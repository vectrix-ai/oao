import { randomUUID } from "node:crypto";
import type { ModelPresetLimits, ModelPresetLimitValues } from "@oao/contracts";
import type { PgClient } from "@oao/db-postgres";
import { publicValue } from "./http.js";

interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
}

export interface ModelPresetLimitsRow {
  readonly id: string;
  readonly preset_id: string;
  readonly context_window: number | null;
  readonly max_output_tokens: number | null;
  readonly created_by_principal_id: string | null;
  readonly created_at: Date;
}

export const MODEL_PRESET_LIMITS_COLUMNS = `id,preset_id,context_window,
  max_output_tokens,created_by_principal_id,created_at`;

export function modelPresetLimitsView(
  row: ModelPresetLimitsRow,
): ModelPresetLimits {
  return {
    id: row.id,
    presetId: row.preset_id,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: publicValue(row.created_at) as string,
  };
}

/** The latest limits of each preset that has any. */
export async function currentModelPresetLimits(
  transaction: PgClient,
  tenant: Tenant,
  presetIds: readonly string[],
): Promise<ReadonlyMap<string, ModelPresetLimits>> {
  if (presetIds.length === 0) return new Map();
  const result = await transaction.query<ModelPresetLimitsRow>(
    `SELECT DISTINCT ON (preset_id) ${MODEL_PRESET_LIMITS_COLUMNS}
       FROM oao.model_preset_limits
      WHERE organization_id=$1 AND project_id=$2 AND preset_id=ANY($3::uuid[])
      ORDER BY preset_id,created_at DESC,id DESC`,
    [tenant.organizationId, tenant.projectId, presetIds],
  );
  return new Map(
    result.rows.map((row) => [row.preset_id, modelPresetLimitsView(row)]),
  );
}

/**
 * Adds limits to a preset's history. They apply from the next run that
 * activates the preset; a run already under way keeps the limits it started
 * with. The newest row applies, so each row gets a later time than the
 * preset's previous one, in milliseconds because times leave the API and
 * backups that way. A restore passes the backed-up time, which keeps the
 * order. Edits of one preset take turns, so two never get the same time.
 */
export async function insertModelPresetLimits(
  transaction: PgClient,
  input: {
    readonly tenant: Tenant;
    readonly presetId: string;
    readonly limits: ModelPresetLimitValues;
    readonly createdByPrincipalId: string;
    readonly createdAt?: Date | string | undefined;
    readonly id?: string | undefined;
  },
): Promise<ModelPresetLimits> {
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 2419))",
    [
      `${input.tenant.organizationId}/${input.tenant.projectId}/${input.presetId}`,
    ],
  );
  const result = await transaction.query<ModelPresetLimitsRow>(
    `INSERT INTO oao.model_preset_limits (
       organization_id,project_id,id,preset_id,context_window,
       max_output_tokens,created_by_principal_id,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,
               COALESCE(
                 date_trunc('milliseconds',$8::timestamptz),
                 GREATEST(
                   date_trunc('milliseconds',clock_timestamp()),
                   (SELECT max(previous.created_at) + interval '1 millisecond'
                      FROM oao.model_preset_limits previous
                     WHERE previous.organization_id=$1
                       AND previous.project_id=$2
                       AND previous.preset_id=$4)
                 )
               ))
     RETURNING ${MODEL_PRESET_LIMITS_COLUMNS}`,
    [
      input.tenant.organizationId,
      input.tenant.projectId,
      input.id ?? randomUUID(),
      input.presetId,
      input.limits.contextWindow,
      input.limits.maxOutputTokens,
      input.createdByPrincipalId,
      input.createdAt ?? null,
    ],
  );
  return modelPresetLimitsView(result.rows[0]!);
}

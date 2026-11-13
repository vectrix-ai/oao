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
 * with. Times leave the API and backups in milliseconds, so they are stored
 * that way too: two that differ by less could not be restored.
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
  const result = await transaction.query<ModelPresetLimitsRow>(
    `INSERT INTO oao.model_preset_limits (
       organization_id,project_id,id,preset_id,context_window,
       max_output_tokens,created_by_principal_id,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,
               date_trunc('milliseconds',COALESCE($8::timestamptz,clock_timestamp())))
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

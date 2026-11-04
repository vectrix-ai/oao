import { randomUUID } from "node:crypto";
import type { ModelPresetPrice, ModelPriceRates } from "@oao/contracts";
import type { PgClient } from "@oao/db-postgres";
import { publicValue } from "./http.js";

interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
}

export interface ModelPresetPriceRow {
  readonly id: string;
  readonly preset_id: string;
  readonly input_usd_per_million: number;
  readonly cached_input_usd_per_million: number;
  readonly cache_write_usd_per_million: number;
  readonly output_usd_per_million: number;
  readonly long_context_above_input_tokens: string | null;
  readonly long_context_input_usd_per_million: number | null;
  readonly long_context_cached_input_usd_per_million: number | null;
  readonly long_context_cache_write_usd_per_million: number | null;
  readonly long_context_output_usd_per_million: number | null;
  readonly valid_from: Date;
  readonly created_by_principal_id: string | null;
  readonly created_at: Date;
}

/** `numeric` arrives as a string, so the rates are read as numbers. */
export const MODEL_PRESET_PRICE_COLUMNS = `id,preset_id,
  input_usd_per_million::float8 AS input_usd_per_million,
  cached_input_usd_per_million::float8 AS cached_input_usd_per_million,
  cache_write_usd_per_million::float8 AS cache_write_usd_per_million,
  output_usd_per_million::float8 AS output_usd_per_million,
  long_context_above_input_tokens,
  long_context_input_usd_per_million::float8 AS long_context_input_usd_per_million,
  long_context_cached_input_usd_per_million::float8 AS long_context_cached_input_usd_per_million,
  long_context_cache_write_usd_per_million::float8 AS long_context_cache_write_usd_per_million,
  long_context_output_usd_per_million::float8 AS long_context_output_usd_per_million,
  valid_from,created_by_principal_id,created_at`;

export function modelPresetPriceView(
  row: ModelPresetPriceRow,
): ModelPresetPrice {
  return {
    id: row.id,
    presetId: row.preset_id,
    inputUsdPerMillion: row.input_usd_per_million,
    cachedInputUsdPerMillion: row.cached_input_usd_per_million,
    cacheWriteUsdPerMillion: row.cache_write_usd_per_million,
    outputUsdPerMillion: row.output_usd_per_million,
    longContext:
      row.long_context_above_input_tokens === null
        ? null
        : {
            aboveInputTokens: Number(row.long_context_above_input_tokens),
            inputUsdPerMillion: row.long_context_input_usd_per_million ?? 0,
            cachedInputUsdPerMillion:
              row.long_context_cached_input_usd_per_million ?? 0,
            cacheWriteUsdPerMillion:
              row.long_context_cache_write_usd_per_million ?? 0,
            outputUsdPerMillion: row.long_context_output_usd_per_million ?? 0,
          },
    validFrom: publicValue(row.valid_from) as string,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: publicValue(row.created_at) as string,
  };
}

/** The price in effect now for each preset that has one. */
export async function currentModelPresetPrices(
  transaction: PgClient,
  tenant: Tenant,
  presetIds: readonly string[],
): Promise<ReadonlyMap<string, ModelPresetPrice>> {
  if (presetIds.length === 0) return new Map();
  const result = await transaction.query<ModelPresetPriceRow>(
    `SELECT DISTINCT ON (preset_id) ${MODEL_PRESET_PRICE_COLUMNS}
       FROM oao.model_preset_prices
      WHERE organization_id=$1 AND project_id=$2 AND preset_id=ANY($3::uuid[])
        AND valid_from<=clock_timestamp()
      ORDER BY preset_id,valid_from DESC`,
    [tenant.organizationId, tenant.projectId, presetIds],
  );
  return new Map(
    result.rows.map((row) => [row.preset_id, modelPresetPriceView(row)]),
  );
}

/** Adds a price to a preset's history, starting now unless `validFrom` says later. */
export async function insertModelPresetPrice(
  transaction: PgClient,
  input: {
    readonly tenant: Tenant;
    readonly presetId: string;
    readonly rates: ModelPriceRates;
    readonly validFrom?: Date | string | undefined;
    readonly createdByPrincipalId: string;
    readonly id?: string | undefined;
  },
): Promise<ModelPresetPrice> {
  const { rates } = input;
  const result = await transaction.query<ModelPresetPriceRow>(
    `INSERT INTO oao.model_preset_prices (
       organization_id,project_id,id,preset_id,
       input_usd_per_million,cached_input_usd_per_million,
       cache_write_usd_per_million,output_usd_per_million,
       long_context_above_input_tokens,long_context_input_usd_per_million,
       long_context_cached_input_usd_per_million,
       long_context_cache_write_usd_per_million,
       long_context_output_usd_per_million,
       valid_from,created_by_principal_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               COALESCE($14::timestamptz,clock_timestamp()),$15)
     RETURNING ${MODEL_PRESET_PRICE_COLUMNS}`,
    [
      input.tenant.organizationId,
      input.tenant.projectId,
      input.id ?? randomUUID(),
      input.presetId,
      rates.inputUsdPerMillion,
      rates.cachedInputUsdPerMillion,
      rates.cacheWriteUsdPerMillion,
      rates.outputUsdPerMillion,
      rates.longContext?.aboveInputTokens ?? null,
      rates.longContext?.inputUsdPerMillion ?? null,
      rates.longContext?.cachedInputUsdPerMillion ?? null,
      rates.longContext?.cacheWriteUsdPerMillion ?? null,
      rates.longContext?.outputUsdPerMillion ?? null,
      input.validFrom ?? null,
      input.createdByPrincipalId,
    ],
  );
  return modelPresetPriceView(result.rows[0]!);
}

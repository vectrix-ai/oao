import type { ModelPriceRates } from "@oao/domain";
import type { Queryable } from "./index.js";

interface RunPresetPriceRow {
  readonly id: string;
  readonly input_usd_per_million: number;
  readonly cached_input_usd_per_million: number;
  readonly cache_write_usd_per_million: number;
  readonly output_usd_per_million: number;
  readonly long_context_above_input_tokens: string | null;
  readonly long_context_input_usd_per_million: number | null;
  readonly long_context_cached_input_usd_per_million: number | null;
  readonly long_context_cache_write_usd_per_million: number | null;
  readonly long_context_output_usd_per_million: number | null;
}

/**
 * The price in effect at a moment for the model preset a run's agent version
 * names. Null when the preset has no price then, or is a deployment preset.
 */
export async function findRunModelPresetPrice(
  client: Queryable,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly at: Date;
  },
): Promise<{ readonly id: string; readonly rates: ModelPriceRates } | null> {
  const result = await client.query(
    `SELECT price.id,
            price.input_usd_per_million::float8 AS input_usd_per_million,
            price.cached_input_usd_per_million::float8 AS cached_input_usd_per_million,
            price.cache_write_usd_per_million::float8 AS cache_write_usd_per_million,
            price.output_usd_per_million::float8 AS output_usd_per_million,
            price.long_context_above_input_tokens,
            price.long_context_input_usd_per_million::float8 AS long_context_input_usd_per_million,
            price.long_context_cached_input_usd_per_million::float8 AS long_context_cached_input_usd_per_million,
            price.long_context_cache_write_usd_per_million::float8 AS long_context_cache_write_usd_per_million,
            price.long_context_output_usd_per_million::float8 AS long_context_output_usd_per_million
       FROM oao.runs r
       JOIN oao.agent_versions v
         ON v.organization_id=r.organization_id
        AND v.project_id=r.project_id
        AND v.id=r.agent_version_id
       JOIN oao.project_model_presets p
         ON p.organization_id=v.organization_id
        AND p.project_id=v.project_id
        AND p.preset_key=v.config->>'modelPreset'
       JOIN LATERAL (
         SELECT candidate.* FROM oao.model_preset_prices candidate
          WHERE candidate.organization_id=p.organization_id
            AND candidate.project_id=p.project_id
            AND candidate.preset_id=p.id
            AND candidate.valid_from<=$4
          ORDER BY candidate.valid_from DESC LIMIT 1
       ) price ON true
      WHERE r.organization_id=$1 AND r.project_id=$2 AND r.id=$3`,
    [input.organizationId, input.projectId, input.runId, input.at],
  );
  const row = result.rows[0] as RunPresetPriceRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    rates: {
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
    },
  };
}

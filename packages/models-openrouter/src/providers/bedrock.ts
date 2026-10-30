import { createProvider } from "@earendil-works/pi-ai";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import type { ModelCatalogEntry } from "@oao/contracts";
import {
  catalogMatches,
  credentialAuth,
  deepFreeze,
  staticCatalogEntry,
  type CreateProjectProviderInput,
} from "./shared.js";

export const BEDROCK_PREFIX = "bedrock/";
const DEFAULT_BEDROCK_REGION = "eu-central-1";

/**
 * Bedrock API keys are region-bound, so the runtime endpoint follows
 * `AWS_REGION` (default eu-central-1) rather than the catalog's per-model URL.
 */
function bedrockBaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const region = environment.AWS_REGION?.trim() || DEFAULT_BEDROCK_REGION;
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Bedrock's ListFoundationModels needs SigV4, so the live catalog is the
 * pinned pi-ai list filtered by search. The API key is not used.
 */
export async function listBedrockModelCatalog(input: {
  readonly apiKey?: string;
  readonly search?: string;
  readonly limit?: number;
}): Promise<readonly ModelCatalogEntry[]> {
  return listBedrockStaticCatalog()
    .filter((entry) => catalogMatches(entry, input.search))
    .slice(0, input.limit ?? undefined);
}

export function listBedrockStaticCatalog(): readonly ModelCatalogEntry[] {
  return amazonBedrockProvider()
    .getModels()
    .map((model) =>
      staticCatalogEntry({
        providerType: "bedrock",
        prefix: BEDROCK_PREFIX,
        model,
        thinkingCanBeDisabled: true,
      }),
    )
    .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
}

export function isApprovedBedrockModel(model: string): boolean {
  const catalogId = model.startsWith(BEDROCK_PREFIX)
    ? model.slice(BEDROCK_PREFIX.length)
    : undefined;
  return (
    catalogId !== undefined && /^(?:[a-z0-9~][a-z0-9._:~-]*)$/u.test(catalogId)
  );
}

/**
 * Any Bedrock model id is accepted. Ids missing from the pinned list (other
 * vendors, new releases) get conservative defaults, like xAI's dynamic model.
 */
function dynamicBedrockModel(
  native: Provider,
  catalogId: string,
): Model<"bedrock-converse-stream"> {
  const known = native.getModels().find((entry) => entry.id === catalogId);
  if (known) return known as Model<"bedrock-converse-stream">;
  return {
    id: catalogId,
    name: catalogId,
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: bedrockBaseUrl(),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
  };
}

export function createBedrockProjectProvider(
  input: CreateProjectProviderInput,
): Provider<"bedrock-converse-stream"> {
  const native = amazonBedrockProvider();
  const baseUrl = bedrockBaseUrl();
  const model = deepFreeze({
    ...dynamicBedrockModel(native, input.catalogId),
    provider: input.providerId,
    baseUrl,
  });
  return createProvider({
    id: input.providerId,
    name: `${native.name} (${input.label})`,
    baseUrl,
    auth: credentialAuth("bedrock", input.apiKey),
    models: [model],
    api: bedrockConverseStreamApi(),
  });
}

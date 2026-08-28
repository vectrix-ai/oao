import type { Api, ApiKeyAuth, Model, Provider } from "@earendil-works/pi-ai";
import type {
  ModelCatalogEntry,
  ModelGenerationSettings,
  ModelProviderType,
} from "@oao/contracts";

export type Fetcher = typeof fetch;

export interface CreateProjectProviderInput {
  readonly providerId: string;
  readonly catalogId: string;
  readonly label: string;
  readonly apiKey: string;
  readonly settings: ModelGenerationSettings | null;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>))
      deepFreeze(nested);
  }
  return value;
}

export function record(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function catalogMatches(
  entry: ModelCatalogEntry,
  search: string | undefined,
): boolean {
  const term = search?.trim().toLowerCase();
  if (!term) return true;
  return (
    entry.catalogId.toLowerCase().includes(term) ||
    entry.name.toLowerCase().includes(term) ||
    entry.model.toLowerCase().includes(term)
  );
}

export function credentialAuth(
  providerType: ModelProviderType,
  apiKey: string,
): { readonly apiKey: ApiKeyAuth } {
  return {
    apiKey: {
      name: `${providerType} project API key`,
      check: async () => ({
        type: "api_key",
        source: "encrypted project credential",
      }),
      resolve: async () => ({
        auth: { apiKey },
        source: "encrypted project credential",
      }),
    },
  };
}

export function staticCatalogEntry(input: {
  readonly providerType: ModelProviderType;
  readonly prefix: string;
  readonly model: Model<Api>;
  readonly adaptiveThinking?: boolean;
  readonly thinkingCanBeDisabled?: boolean;
  readonly effortLevels?: readonly (
    "low" | "medium" | "high" | "xhigh" | "max"
  )[];
}): ModelCatalogEntry {
  return {
    providerType: input.providerType,
    model: `${input.prefix}${input.model.id}`,
    catalogId: input.model.id,
    name: input.model.name,
    contextWindow: positiveInteger(input.model.contextWindow),
    maxOutputTokens: positiveInteger(input.model.maxTokens),
    reasoning: input.model.reasoning === true,
    adaptiveThinking: input.adaptiveThinking ?? false,
    thinkingCanBeDisabled: input.thinkingCanBeDisabled ?? true,
    effortLevels: [...(input.effortLevels ?? [])],
  };
}

export function requireModel<T extends Provider>(
  provider: T,
  catalogId: string,
  providerType: ModelProviderType,
) {
  const model = provider.getModels().find((entry) => entry.id === catalogId);
  if (!model)
    throw new TypeError(
      `Model is not present in the pinned ${providerType} catalog: ${catalogId}`,
    );
  return model;
}

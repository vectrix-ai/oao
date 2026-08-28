import type { ModelCatalogEntry, ModelProviderType } from "@oao/contracts";
import {
  isApprovedAnthropicModel,
  listAnthropicStaticCatalog,
} from "./providers/anthropic.js";
import {
  isApprovedOpenAIModel,
  listOpenAIStaticCatalog,
} from "./providers/openai.js";
import {
  isApprovedOpenRouterModel,
  listOpenRouterStaticCatalog,
} from "./providers/openrouter.js";
import { isApprovedXAIModel, listXAIStaticCatalog } from "./providers/xai.js";

/**
 * Safe, credential-free projection of the pinned deployment catalogs.
 * Project connections use the provider-specific live catalog functions.
 */
export function listApprovedModelCatalog(
  providerType?: ModelProviderType,
): readonly ModelCatalogEntry[] {
  return [
    ...(providerType === undefined || providerType === "openrouter"
      ? listOpenRouterStaticCatalog()
      : []),
    ...(providerType === undefined || providerType === "openai"
      ? listOpenAIStaticCatalog()
      : []),
    ...(providerType === undefined || providerType === "anthropic"
      ? listAnthropicStaticCatalog()
      : []),
    ...(providerType === undefined || providerType === "xai"
      ? listXAIStaticCatalog()
      : []),
  ].sort((left, right) => left.catalogId.localeCompare(right.catalogId));
}

/** True when `model` is accepted by the matching provider adapter. */
export function isApprovedCatalogModel(
  model: string,
  providerType?: ModelProviderType,
): boolean {
  return (
    ((providerType === undefined || providerType === "openrouter") &&
      isApprovedOpenRouterModel(model)) ||
    ((providerType === undefined || providerType === "openai") &&
      isApprovedOpenAIModel(model)) ||
    ((providerType === undefined || providerType === "anthropic") &&
      isApprovedAnthropicModel(model)) ||
    ((providerType === undefined || providerType === "xai") &&
      isApprovedXAIModel(model))
  );
}

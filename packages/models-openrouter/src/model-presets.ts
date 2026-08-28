import { createHash } from "node:crypto";
import type { OpenRouterRouting, Provider } from "@earendil-works/pi-ai";
import {
  DEFAULT_ANTHROPIC_MODEL_GENERATION_SETTINGS,
  DEFAULT_OPENAI_MODEL_GENERATION_SETTINGS,
  type ModelGenerationSettings,
  type ModelProviderType,
  type ModelRoutingPolicy,
} from "@oao/contracts";
import * as v from "valibot";
import { isApprovedCatalogModel } from "./catalog.js";
import { createAnthropicProjectProvider } from "./providers/anthropic.js";
import { createOpenAIProjectProvider } from "./providers/openai.js";
import {
  ApprovedModelPresetSchema,
  OPENROUTER_PREFIX,
  createOpenRouterProjectProvider,
  isPinnedOpenRouterModel,
  presetProviderId,
  toOpenRouterRouting,
  type ApprovedModelPreset,
} from "./providers/openrouter.js";
import { deepFreeze } from "./providers/shared.js";
import { createXAIProjectProvider } from "./providers/xai.js";

export class ImmutableModelPresetRegistry {
  readonly #presets: ReadonlyMap<
    string,
    Readonly<ApprovedModelPreset> & { readonly runtimeModel: string }
  >;

  constructor(
    presets: readonly ApprovedModelPreset[],
    private readonly options: { readonly hostedEnabled: boolean },
  ) {
    const entries = presets.map((input) => {
      const preset = v.parse(ApprovedModelPresetSchema, input);
      if (
        preset.model !== "fake/deterministic" &&
        !preset.model.startsWith(OPENROUTER_PREFIX)
      )
        throw new TypeError(
          `Model is not allowlisted through OpenRouter: ${preset.model}`,
        );
      if (
        preset.model.startsWith(OPENROUTER_PREFIX) &&
        !isPinnedOpenRouterModel(preset.model)
      )
        throw new TypeError(
          `Model is not present in the pinned OpenRouter catalog: ${preset.model}`,
        );
      const runtimeModel = preset.model.startsWith(OPENROUTER_PREFIX)
        ? `${presetProviderId(preset.key)}/${preset.model.slice(OPENROUTER_PREFIX.length)}`
        : preset.model;
      return [
        preset.key,
        deepFreeze({ ...structuredClone(preset), runtimeModel }),
      ] as const;
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw new TypeError("Duplicate model preset key");
    this.#presets = new Map(entries);
    Object.freeze(this);
  }

  resolve(key: string): Readonly<ApprovedModelPreset> & {
    readonly model: string;
    readonly approvedModel: string;
  } {
    const preset = this.#presets.get(key);
    if (!preset) throw new Error(`Model preset is not approved: ${key}`);
    if (
      preset.model.startsWith(OPENROUTER_PREFIX) &&
      !this.options.hostedEnabled
    )
      throw new Error("Hosted model calls are disabled");
    return {
      ...preset,
      approvedModel: preset.model,
      model: preset.runtimeModel,
    };
  }

  list(): readonly Readonly<ApprovedModelPreset>[] {
    return [...this.#presets.values()];
  }
}

export interface ModelPresetTenant {
  readonly organizationId: string;
  readonly projectId: string;
}

export interface ProjectModelPresetInput extends ModelPresetTenant {
  readonly key: string;
  readonly providerId: string;
  readonly providerType: ModelProviderType;
  readonly apiKey: string;
  readonly credentialVersion: number;
  readonly model: string;
  readonly routing: ModelRoutingPolicy;
  readonly settings?: ModelGenerationSettings | null;
}

export interface ResolvedModelPreset {
  readonly key: string;
  /** Runtime model identifier, namespaced by the preset's provider identity. */
  readonly model: string;
  /** Approved catalog identifier the preset was created from. */
  readonly approvedModel: string;
  readonly origin: "deployment" | "project";
  readonly settings?: ModelGenerationSettings | null;
}

function projectPresetProviderId(input: ProjectModelPresetInput): string {
  return `project-model-${createHash("sha256")
    .update(
      [input.organizationId, input.projectId, input.providerId, input.key]
        .map((part) => `${part.length}:${part}`)
        .join("|"),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function presetFingerprint(input: ProjectModelPresetInput): string {
  return JSON.stringify({
    providerId: input.providerId,
    providerType: input.providerType,
    model: input.model,
    routing: Object.fromEntries(
      Object.entries(input.routing).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    settings: input.settings,
  });
}

function assertGenerationSettingsMatchProvider(
  providerType: ModelProviderType,
  model: string,
  settings: ModelGenerationSettings | null,
): void {
  if (settings === null) return;
  const anthropic = "thinking" in settings;
  if (providerType === "anthropic" && !anthropic)
    throw new TypeError("Anthropic model presets require Anthropic settings");
  if (providerType === "openai" && anthropic)
    throw new TypeError("OpenAI model presets require OpenAI settings");
  if (providerType === "xai")
    throw new TypeError("xAI model presets do not support generation settings");
  if (
    providerType === "anthropic" &&
    anthropic &&
    /^anthropic\/claude-opus-5(?:-|$)/u.test(model) &&
    settings.thinking === "disabled" &&
    (settings.effort === "xhigh" || settings.effort === "max")
  )
    throw new TypeError(
      "Claude Opus 5 cannot disable thinking at xhigh or max effort",
    );
}

function createProjectPresetProvider(input: {
  readonly providerId: string;
  readonly providerType: ModelProviderType;
  readonly catalogId: string;
  readonly label: string;
  readonly apiKey: string;
  readonly routing: OpenRouterRouting | undefined;
  readonly settings: ModelGenerationSettings | null;
}): Provider {
  if (input.providerType === "openrouter")
    return createOpenRouterProjectProvider(input);
  if (input.providerType === "openai")
    return createOpenAIProjectProvider(input);
  if (input.providerType === "anthropic")
    return createAnthropicProjectProvider(input);
  return createXAIProjectProvider(input);
}

/**
 * Bounded, tenant-scoped approved catalog for the runtime process.
 *
 * Flue resolves models synchronously, so activation validates and registers the
 * durable project preset before dispatch. Definitions remain append-only in
 * memory and credential rotation replaces only the provider credential.
 */
export class ProjectModelPresetRegistry {
  readonly #deployment: ImmutableModelPresetRegistry;
  readonly #registerProvider: (provider: Provider) => void;
  readonly #active = new Map<
    string,
    {
      readonly resolved: ResolvedModelPreset;
      readonly fingerprint: string;
      readonly credentialVersion: number;
    }
  >();

  constructor(options: {
    readonly deployment: ImmutableModelPresetRegistry;
    readonly registerProvider: (provider: Provider) => void;
  }) {
    this.#deployment = options.deployment;
    this.#registerProvider = options.registerProvider;
  }

  static #cacheKey(tenant: ModelPresetTenant, key: string): string {
    return `${tenant.organizationId}/${tenant.projectId}/${key}`;
  }

  #isDeploymentKey(key: string): boolean {
    return this.#deployment.list().some((preset) => preset.key === key);
  }

  activate(input: ProjectModelPresetInput): ResolvedModelPreset {
    if (!isApprovedCatalogModel(input.model, input.providerType))
      throw new Error(
        `Model is not present in the pinned ${input.providerType} catalog: ${input.model}`,
      );
    if (
      input.providerType !== "openrouter" &&
      Object.keys(input.routing).length > 0
    )
      throw new Error(
        `${input.providerType} model presets do not support routing policy`,
      );
    if (input.providerType === "openrouter" && input.settings != null)
      throw new Error(
        "OpenRouter model presets do not support direct generation settings",
      );
    if (input.providerType === "xai" && input.settings != null)
      throw new Error(
        "xAI model presets do not support direct generation settings",
      );
    const settings =
      input.providerType === "openai"
        ? (input.settings ?? DEFAULT_OPENAI_MODEL_GENERATION_SETTINGS)
        : input.providerType === "anthropic"
          ? (input.settings ?? DEFAULT_ANTHROPIC_MODEL_GENERATION_SETTINGS)
          : null;
    assertGenerationSettingsMatchProvider(
      input.providerType,
      input.model,
      settings,
    );
    const cacheKey = ProjectModelPresetRegistry.#cacheKey(input, input.key);
    const fingerprint = presetFingerprint({ ...input, settings });
    const existing = this.#active.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error(
          `Model preset definition changed after activation: ${input.key}`,
        );
      if (existing.credentialVersion >= input.credentialVersion)
        return existing.resolved;
    }
    const providerId = projectPresetProviderId(input);
    const catalogId = input.model.slice(input.providerType.length + 1);
    this.#registerProvider(
      createProjectPresetProvider({
        providerId,
        providerType: input.providerType,
        catalogId,
        label: input.key,
        apiKey: input.apiKey,
        routing: toOpenRouterRouting(input.routing),
        settings,
      }),
    );
    const resolved: ResolvedModelPreset = deepFreeze({
      key: input.key,
      model: `${providerId}/${catalogId}`,
      approvedModel: input.model,
      origin: "project",
      settings,
    });
    this.#active.set(cacheKey, {
      resolved,
      fingerprint,
      credentialVersion: input.credentialVersion,
    });
    return resolved;
  }

  resolve(key: string, tenant: ModelPresetTenant): ResolvedModelPreset {
    const active = this.#active.get(
      ProjectModelPresetRegistry.#cacheKey(tenant, key),
    );
    if (active) return active.resolved;
    if (this.#isDeploymentKey(key)) {
      const preset = this.#deployment.resolve(key);
      return {
        key: preset.key,
        model: preset.model,
        approvedModel: preset.approvedModel,
        origin: "deployment",
        settings: null,
      };
    }
    throw new Error(`Model preset is not approved: ${key}`);
  }
}

export interface ModelPresetConfiguration {
  readonly hostedEnabled: boolean;
  readonly hostedPresets: readonly ApprovedModelPreset[];
  readonly presets: readonly ApprovedModelPreset[];
  readonly registry: ImmutableModelPresetRegistry;
}

/** Runnable processes have no deployment-local model. */
export function loadModelPresetConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ModelPresetConfiguration {
  void environment;
  const hostedEnabled = false;
  const hostedPresets: readonly ApprovedModelPreset[] = [];
  const presets: readonly ApprovedModelPreset[] = [];
  return {
    hostedEnabled,
    hostedPresets,
    presets,
    registry: new ImmutableModelPresetRegistry(presets, { hostedEnabled }),
  };
}

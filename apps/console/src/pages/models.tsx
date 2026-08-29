import {
  Archive,
  Copy,
  Cpu,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useApi } from "../api/context";
import type {
  AgentSummary,
  CreateModelPresetInput,
  CreateModelProviderInput,
  ModelCatalogEntry,
  ModelGenerationSettings,
  ModelPreset,
  ModelRoutingPolicy,
  ProjectModelProvider,
} from "../api/types";
import {
  MODEL_PRESET_KEY_PATTERN,
  describePresetRouting,
  describeRouting,
  suggestPresetKey,
} from "../model-presets";
import type { ComboboxOption } from "../components/ui";
import {
  Alert,
  Button,
  ButtonGroup,
  Combobox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  EntityCell,
  ErrorState,
  Field,
  FieldRow,
  FormError,
  Input,
  JsonBlock,
  LoadingState,
  MetaGrid,
  Page,
  PageHeader,
  SearchField,
  SectionHeading,
  Select,
  StatusChip,
  TableCard,
  ValidationPanel,
  formatCompactNumber,
  formatDate,
  formatNumber,
  useToast,
} from "../components/ui";

/** Optional policy fields stay unset unless the operator chooses explicitly. */
type Tristate = "" | "yes" | "no";
type OpenAISettings = Extract<
  ModelGenerationSettings,
  { readonly mode: "standard" | "pro" }
>;
type AnthropicSettings = Extract<
  ModelGenerationSettings,
  { readonly thinking: "disabled" | "adaptive" }
>;
type XAISettings = {
  readonly textFormat: "text";
  readonly effort: "low" | "medium" | "high" | "xhigh";
};

function tristate(value: Tristate): boolean | undefined {
  return value === "" ? undefined : value === "yes";
}

function providerList(value: string): readonly string[] | undefined {
  const entries = [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  return entries.length === 0 ? undefined : entries;
}

function price(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function ModelsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [rotatingProvider, setRotatingProvider] =
    useState<ProjectModelProvider | null>(null);
  const [removingProvider, setRemovingProvider] =
    useState<ProjectModelProvider | null>(null);
  const [openPreset, setOpenPreset] = useState<ModelPreset | null>(null);
  const [archivingPreset, setArchivingPreset] = useState<ModelPreset | null>(
    null,
  );
  const [duplicateFrom, setDuplicateFrom] = useState<ModelPreset | null>(null);
  const agents = useQuery({
    queryKey: ["agents", "preset-usage"],
    queryFn: () => api.listAgents({}),
  });
  const providers = useQuery({
    queryKey: ["model-providers"],
    queryFn: () => api.listModelProviders(),
  });
  const presets = useQuery({
    queryKey: ["model-presets"],
    queryFn: () => api.listModelPresets(),
  });
  const create = useMutation({
    mutationFn: (input: CreateModelPresetInput) => api.createModelPreset(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["model-presets"] });
      await queryClient.invalidateQueries({ queryKey: ["context"] });
      setCreating(false);
      notify("Model preset approved.");
    },
  });
  const createProvider = useMutation({
    mutationFn: (input: CreateModelProviderInput) =>
      api.createModelProvider(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      setCreatingProvider(false);
      notify("Provider connection added.");
    },
  });
  const rotateProvider = useMutation({
    mutationFn: (input: {
      readonly providerId: string;
      readonly apiKey: string;
    }) => api.rotateModelProviderCredential(input.providerId, input.apiKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      setRotatingProvider(null);
      notify("Provider credential rotated.");
    },
  });
  const removeProvider = useMutation({
    mutationFn: (provider: ProjectModelProvider) =>
      api.removeModelProvider(provider.id),
    onSuccess: async (_result, provider) => {
      await queryClient.invalidateQueries({ queryKey: ["model-providers"] });
      await queryClient.invalidateQueries({ queryKey: ["model-presets"] });
      setRemovingProvider(null);
      notify(`Removed ${provider.displayName}.`);
    },
  });
  const archivePreset = useMutation({
    mutationFn: (preset: ModelPreset) => {
      if (!preset.id) throw new Error("Deployment presets cannot be archived.");
      return api.archiveModelPreset(preset.id);
    },
    onSuccess: async (_result, preset) => {
      await queryClient.invalidateQueries({ queryKey: ["model-presets"] });
      await queryClient.invalidateQueries({ queryKey: ["context"] });
      setArchivingPreset(null);
      setOpenPreset(null);
      notify(`Archived ${preset.displayName}.`);
    },
  });
  const usageByPreset = useMemo(() => {
    const map = new Map<string, AgentSummary[]>();
    for (const agent of agents.data?.data ?? [])
      if (agent.model)
        map.set(agent.model, [...(map.get(agent.model) ?? []), agent]);
    return map;
  }, [agents.data]);
  const term = search.trim().toLowerCase();
  const visible = (presets.data?.data ?? []).filter(
    (preset) =>
      !term ||
      `${preset.key} ${preset.displayName} ${preset.model}`
        .toLowerCase()
        .includes(term),
  );
  const encryptionConfigured =
    presets.data?.credentialEncryptionConfigured === true;

  return (
    <Page>
      <PageHeader
        eyebrow="Build"
        title="Models"
        description="Project provider connections and approved model presets. API keys are write-only and encrypted before PostgreSQL stores them."
        actions={
          <ButtonGroup>
            <Button
              icon={<KeyRound size={15} />}
              disabled={!encryptionConfigured}
              onClick={() => setCreatingProvider(true)}
            >
              Add provider
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={15} />}
              disabled={!encryptionConfigured || !providers.data?.length}
              onClick={() => setCreating(true)}
            >
              Add model preset
            </Button>
          </ButtonGroup>
        }
      />
      {presets.isSuccess && !encryptionConfigured ? (
        <Alert
          tone="warning"
          role="status"
          title="Provider credential encryption is not configured"
        >
          Set the platform encryption key for the API and runtime. Provider API
          keys themselves belong in PostgreSQL and are never read from
          environment variables.
        </Alert>
      ) : null}

      <section className="section-stack">
        <SectionHeading
          eyebrow="Credentials"
          id="provider-connections-heading"
          title="Provider connections"
          description="One encrypted API key per connection, shared by every preset that routes through it."
        />
        {providers.isPending ? (
          <LoadingState label="Loading provider connections" rows={3} />
        ) : providers.isError ? (
          <ErrorState
            error={providers.error}
            retry={() => void providers.refetch()}
          />
        ) : providers.data.length === 0 ? (
          <EmptyState
            icon="⚿"
            title="No provider connections yet"
            description="Add an OpenRouter, OpenAI, or Anthropic connection before creating a hosted model preset."
            action={
              encryptionConfigured ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setCreatingProvider(true)}
                >
                  Add provider
                </Button>
              ) : undefined
            }
          />
        ) : (
          <TableCard
            label="Model provider connections"
            caption="Provider connections for this project"
          >
            <thead>
              <tr>
                <th>Provider</th>
                <th>Type</th>
                <th>Credential</th>
                <th>Updated</th>
                <th className="actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.data.map((provider) => (
                <tr key={provider.id}>
                  <td>
                    <EntityCell
                      icon={<KeyRound size={15} />}
                      name={provider.displayName}
                      meta={provider.key}
                    />
                  </td>
                  <td>
                    <StatusChip value={provider.providerType} />
                  </td>
                  <td>
                    <span className="key-mask">
                      sha256:{provider.credentialFingerprint}
                    </span>
                    <small className="cell-sub">
                      v{provider.credentialVersion}
                    </small>
                  </td>
                  <td>{formatDate(provider.updatedAt)}</td>
                  <td className="actions">
                    <ButtonGroup>
                      <Button
                        size="sm"
                        icon={<RefreshCw size={13} />}
                        onClick={() => setRotatingProvider(provider)}
                      >
                        Rotate key
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => {
                          removeProvider.reset();
                          setRemovingProvider(provider);
                        }}
                      >
                        Remove
                      </Button>
                    </ButtonGroup>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>

      <section className="section-stack">
        <SectionHeading
          eyebrow="Approved models"
          title="Model presets"
          description="A preset is append-only: open one to inspect it, duplicate it into a new key, or archive it."
          actions={
            <SearchField
              value={search}
              onChange={setSearch}
              label="Search model presets"
            />
          }
        />
        {presets.isPending ? (
          <LoadingState label="Loading model presets" />
        ) : presets.isError ? (
          <ErrorState
            error={presets.error}
            retry={() => void presets.refetch()}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="◇"
            title={term ? "No matching model presets" : "No model presets yet"}
            description={
              term
                ? "Try a different search term."
                : "A preset makes one approved model selectable when publishing an agent version."
            }
          />
        ) : (
          <TableCard
            label="Model presets table"
            caption="Model presets available to this project"
          >
            <thead>
              <tr>
                <th>Preset</th>
                <th>Model</th>
                <th>Source</th>
                <th>Policy / settings</th>
                <th>Used by</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((preset) => (
                <tr key={preset.key}>
                  <td>
                    <button
                      type="button"
                      className="row-link"
                      onClick={() => setOpenPreset(preset)}
                    >
                      <EntityCell
                        icon={<Cpu size={15} />}
                        name={preset.displayName}
                        meta={preset.key}
                      />
                    </button>
                  </td>
                  <td>
                    <code>{preset.model}</code>
                  </td>
                  <td>
                    <StatusChip
                      value={
                        preset.origin === "deployment"
                          ? "deployment"
                          : "project"
                      }
                    />
                  </td>
                  <td>{describePresetRouting(preset)}</td>
                  <td>
                    {agents.isPending
                      ? "…"
                      : `${usageByPreset.get(preset.key)?.length ?? 0} ${
                          (usageByPreset.get(preset.key)?.length ?? 0) === 1
                            ? "agent"
                            : "agents"
                        }`}
                  </td>
                  <td>
                    {preset.createdAt
                      ? formatDate(preset.createdAt)
                      : "Deployment configuration"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>

      {creating || duplicateFrom ? (
        <CreateModelPresetDialog
          existingKeys={(presets.data?.data ?? []).map((preset) => preset.key)}
          providers={providers.data ?? []}
          {...(duplicateFrom ? { initial: duplicateFrom } : {})}
          pending={create.isPending}
          error={create.error}
          onClose={() => {
            setCreating(false);
            setDuplicateFrom(null);
          }}
          onSubmit={(input) => create.mutate(input)}
        />
      ) : null}
      {openPreset ? (
        <PresetDetailDialog
          preset={openPreset}
          provider={
            (providers.data ?? []).find(
              (entry) => entry.id === openPreset.providerId,
            ) ?? null
          }
          usedBy={usageByPreset.get(openPreset.key) ?? []}
          usageLoading={agents.isPending}
          onClose={() => setOpenPreset(null)}
          onDuplicate={() => {
            setDuplicateFrom(openPreset);
            setOpenPreset(null);
          }}
          onArchive={() => {
            archivePreset.reset();
            setArchivingPreset(openPreset);
          }}
        />
      ) : null}
      {archivingPreset ? (
        <ConfirmDialog
          title={`Archive “${archivingPreset.displayName}”?`}
          description={`${archivingPreset.key} stops being offered to new agent versions. ${
            (usageByPreset.get(archivingPreset.key)?.length ?? 0) > 0
              ? `${usageByPreset.get(archivingPreset.key)!.length} agent${usageByPreset.get(archivingPreset.key)!.length === 1 ? "" : "s"} currently pin this key; their published versions keep running on it, but they must move to another preset before publishing again.`
              : "No agent currently pins this key."
          } Archiving cannot be undone.`}
          confirmLabel="Archive preset"
          pending={archivePreset.isPending}
          error={archivePreset.error?.message ?? null}
          onClose={() => setArchivingPreset(null)}
          onConfirm={() => archivePreset.mutate(archivingPreset)}
        />
      ) : null}
      {removingProvider ? (
        <ConfirmDialog
          title={`Remove “${removingProvider.displayName}”?`}
          description={`The ${removingProvider.providerType} API key behind ${removingProvider.key} is wiped and the key becomes free for a new connection. Removal is refused while any model preset still routes through it; archive those presets first. Sessions of agents pinned to already archived presets on this connection will fail to run.`}
          confirmLabel="Remove connection"
          pending={removeProvider.isPending}
          error={removeProvider.error?.message ?? null}
          onClose={() => setRemovingProvider(null)}
          onConfirm={() => removeProvider.mutate(removingProvider)}
        />
      ) : null}
      {creatingProvider ? (
        <CreateProviderDialog
          existingKeys={(providers.data ?? []).map((provider) => provider.key)}
          pending={createProvider.isPending}
          error={createProvider.error}
          onClose={() => setCreatingProvider(false)}
          onSubmit={(input) => createProvider.mutate(input)}
        />
      ) : null}
      {rotatingProvider ? (
        <RotateProviderCredentialDialog
          provider={rotatingProvider}
          pending={rotateProvider.isPending}
          error={rotateProvider.error}
          onClose={() => setRotatingProvider(null)}
          onSubmit={(apiKey) =>
            rotateProvider.mutate({ providerId: rotatingProvider.id, apiKey })
          }
        />
      ) : null}
    </Page>
  );
}

function CreateModelPresetDialog({
  existingKeys,
  providers,
  initial,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly existingKeys: readonly string[];
  readonly providers: readonly ProjectModelProvider[];
  /** Duplicating: start from this preset's provider, model, policy, and settings. */
  readonly initial?: ModelPreset;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateModelPresetInput) => void;
}) {
  const api = useApi();
  const initialProviderId =
    initial?.providerId &&
    providers.some((entry) => entry.id === initial.providerId)
      ? initial.providerId
      : (providers[0]?.id ?? "");
  const [providerId, setProviderId] = useState(initialProviderId);
  const provider = providers.find((entry) => entry.id === providerId);
  const [catalogSearch, setCatalogSearch] = useState(initial?.model ?? "");
  const catalogQuery = useQuery({
    queryKey: ["model-catalog", providerId, catalogSearch],
    queryFn: () => api.listModelCatalog(providerId, catalogSearch),
    enabled: providerId.length > 0,
    // Keep the previous matches visible while the next search resolves, so the
    // list never blinks back to a loading row between keystrokes.
    placeholderData: (previous) => previous,
  });
  const catalog = catalogQuery.data?.data ?? [];
  // The chosen entry is held rather than looked up, because a later search
  // narrows the catalog and must not silently invalidate the selection.
  const [model, setModel] = useState<ModelCatalogEntry | null>(null);
  // A duplicate keeps the source name and gets the next free key; the operator
  // edits either, and the model pick no longer overrides them.
  const [key, setKey] = useState(
    initial ? suggestPresetKey(initial.displayName, existingKeys) : "",
  );
  const [keyEdited, setKeyEdited] = useState(initial !== undefined);
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [displayNameEdited, setDisplayNameEdited] = useState(
    initial !== undefined,
  );
  const initialRouting = initial?.routing ?? {};
  const tristateOf = (value: boolean | undefined): Tristate =>
    value === undefined ? "" : value ? "yes" : "no";
  const [dataCollection, setDataCollection] = useState<"" | "deny" | "allow">(
    initialRouting.dataCollection ?? "",
  );
  const [zeroDataRetention, setZeroDataRetention] = useState<Tristate>(
    tristateOf(initialRouting.zeroDataRetention),
  );
  const [allowFallbacks, setAllowFallbacks] = useState<Tristate>(
    tristateOf(initialRouting.allowFallbacks),
  );
  const [requireParameters, setRequireParameters] = useState<Tristate>(
    tristateOf(initialRouting.requireParameters),
  );
  const [providerAllowlist, setProviderAllowlist] = useState(
    initialRouting.providerAllowlist?.join(", ") ?? "",
  );
  const [providerDenylist, setProviderDenylist] = useState(
    initialRouting.providerDenylist?.join(", ") ?? "",
  );
  const [providerOrder, setProviderOrder] = useState(
    initialRouting.providerOrder?.join(", ") ?? "",
  );
  const [sort, setSort] = useState<"" | "price" | "throughput" | "latency">(
    initialRouting.sort ?? "",
  );
  const [maxPrompt, setMaxPrompt] = useState(
    initialRouting.maxPromptPriceUsdPerMillion === undefined
      ? ""
      : String(initialRouting.maxPromptPriceUsdPerMillion),
  );
  const [maxCompletion, setMaxCompletion] = useState(
    initialRouting.maxCompletionPriceUsdPerMillion === undefined
      ? ""
      : String(initialRouting.maxCompletionPriceUsdPerMillion),
  );
  const initialSettings = initial?.settings ?? null;
  const openaiInitial =
    initialSettings && "mode" in initialSettings ? initialSettings : null;
  const anthropicInitial =
    initialSettings && "thinking" in initialSettings ? initialSettings : null;
  const xaiInitial =
    initialSettings && !openaiInitial && !anthropicInitial
      ? initialSettings
      : null;
  const [reasoningMode, setReasoningMode] = useState<"standard" | "pro">(
    openaiInitial?.mode ?? "standard",
  );
  const [reasoningEffort, setReasoningEffort] = useState<
    OpenAISettings["effort"]
  >(openaiInitial?.effort ?? "medium");
  const [verbosity, setVerbosity] = useState<OpenAISettings["verbosity"]>(
    openaiInitial?.verbosity ?? "medium",
  );
  const [reasoningSummary, setReasoningSummary] = useState<
    OpenAISettings["summary"]
  >(openaiInitial?.summary ?? "auto");
  const [anthropicThinking, setAnthropicThinking] = useState<
    AnthropicSettings["thinking"]
  >(anthropicInitial?.thinking ?? "adaptive");
  const [anthropicMaxTokens, setAnthropicMaxTokens] = useState(
    anthropicInitial?.maxTokens ?? 20_000,
  );
  const [anthropicEffort, setAnthropicEffort] = useState<
    AnthropicSettings["effort"]
  >(anthropicInitial?.effort ?? "high");
  const [xaiEffort, setXAIEffort] = useState<XAISettings["effort"]>(
    (xaiInitial?.effort as XAISettings["effort"] | undefined) ?? "high",
  );
  // Once the catalog answers the prefilled search, pin the source model.
  useEffect(() => {
    if (!initial || model || catalogQuery.data === undefined) return;
    const entry = catalogQuery.data.data.find(
      (candidate) => candidate.model === initial.model,
    );
    if (entry) setModel(entry);
  }, [initial, model, catalogQuery.data]);

  const settings: ModelGenerationSettings | null =
    provider?.providerType === "openai"
      ? {
          textFormat: "text",
          mode: reasoningMode,
          effort: reasoningEffort,
          verbosity,
          summary: reasoningSummary,
        }
      : provider?.providerType === "anthropic"
        ? {
            thinking: anthropicThinking,
            maxTokens: anthropicMaxTokens,
            effort: anthropicEffort,
          }
        : provider?.providerType === "xai" &&
            (model?.effortLevels?.length ?? 0) > 0
          ? { textFormat: "text", effort: xaiEffort }
          : null;

  const catalogOptions = useMemo<readonly ComboboxOption[]>(
    () =>
      catalog.map((entry) => ({
        value: entry.model,
        label: entry.name,
        description: entry.model,
        hint: [
          entry.contextWindow === null
            ? null
            : `${formatCompactNumber(entry.contextWindow)} ctx`,
          entry.reasoning ? "reasoning" : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    [catalog],
  );

  /** Picking a model fills the key and name until the operator edits them. */
  const chooseModel = (value: string) => {
    const entry = catalog.find((candidate) => candidate.model === value);
    if (!entry) return;
    setModel(entry);
    if (entry.providerType === "anthropic") {
      const thinking = entry.adaptiveThinking ? "adaptive" : "disabled";
      setAnthropicThinking(thinking);
      setAnthropicMaxTokens(Math.min(20_000, entry.maxOutputTokens ?? 20_000));
      const efforts = entry.effortLevels ?? [];
      setAnthropicEffort(
        efforts.includes("high") ? "high" : (efforts[0] ?? "high"),
      );
    }
    if (entry.providerType === "xai" && entry.effortLevels?.length) {
      const efforts = entry.effortLevels.filter(
        (effort): effort is XAISettings["effort"] => effort !== "max",
      );
      setXAIEffort(efforts.includes("high") ? "high" : (efforts[0] ?? "high"));
    }
    if (!keyEdited) setKey(suggestPresetKey(entry.name, existingKeys));
    if (!displayNameEdited) setDisplayName(entry.name);
  };

  const routing: ModelRoutingPolicy = useMemo(() => {
    if (provider?.providerType !== "openrouter") return {};
    const allowlist = providerList(providerAllowlist);
    const denylist = providerList(providerDenylist);
    const order = providerList(providerOrder);
    const promptCap = price(maxPrompt);
    const completionCap = price(maxCompletion);
    return {
      ...(dataCollection ? { dataCollection } : {}),
      ...(tristate(zeroDataRetention) === undefined
        ? {}
        : { zeroDataRetention: tristate(zeroDataRetention) }),
      ...(tristate(allowFallbacks) === undefined
        ? {}
        : { allowFallbacks: tristate(allowFallbacks) }),
      ...(tristate(requireParameters) === undefined
        ? {}
        : { requireParameters: tristate(requireParameters) }),
      ...(allowlist ? { providerAllowlist: allowlist } : {}),
      ...(denylist ? { providerDenylist: denylist } : {}),
      ...(order ? { providerOrder: order } : {}),
      ...(sort ? { sort } : {}),
      ...(promptCap === undefined
        ? {}
        : { maxPromptPriceUsdPerMillion: promptCap }),
      ...(completionCap === undefined
        ? {}
        : { maxCompletionPriceUsdPerMillion: completionCap }),
    } as ModelRoutingPolicy;
  }, [
    allowFallbacks,
    dataCollection,
    maxCompletion,
    maxPrompt,
    providerAllowlist,
    providerDenylist,
    providerOrder,
    requireParameters,
    sort,
    zeroDataRetention,
    provider?.providerType,
  ]);

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!provider) errors.push("Select a project provider connection.");
    if (!model) {
      // The key and the display name are derived from the model, so they are
      // not reported as separate problems before one has been chosen.
      errors.push("Select a model from the provider catalog.");
      return errors;
    }
    if (!MODEL_PRESET_KEY_PATTERN.test(key))
      errors.push(
        "Preset key must be lowercase, hyphen separated, and end with a version suffix such as -v1.",
      );
    if (existingKeys.includes(key))
      errors.push("Preset key is already used in this project.");
    if (displayName.trim().length < 2)
      errors.push("Display name must contain at least 2 characters.");
    if (
      Number.isNaN(routing.maxPromptPriceUsdPerMillion) ||
      Number.isNaN(routing.maxCompletionPriceUsdPerMillion)
    )
      errors.push("Price caps must be numbers.");
    if (
      provider?.providerType === "anthropic" &&
      (!Number.isInteger(anthropicMaxTokens) || anthropicMaxTokens < 1)
    )
      errors.push("Anthropic max tokens must be a positive whole number.");
    if (
      provider?.providerType === "anthropic" &&
      model.maxOutputTokens !== null &&
      anthropicMaxTokens > model.maxOutputTokens
    )
      errors.push(
        `Anthropic max tokens cannot exceed ${formatNumber(model.maxOutputTokens)} for this model.`,
      );
    return errors;
  }, [
    anthropicMaxTokens,
    displayName,
    existingKeys,
    key,
    model,
    provider,
    routing,
  ]);

  return (
    <Dialog
      wide
      title={
        initial ? `Duplicate “${initial.displayName}”` : "Add model preset"
      }
      description={
        initial
          ? "Adjust anything below and publish it under a new key. The original preset stays exactly as agent versions reviewed it."
          : "A preset is append-only. Publish a new preset key instead of changing an existing one, so already published agent versions keep the model they were reviewed with."
      }
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (validation.length > 0 || !model) return;
        onSubmit({
          key,
          displayName,
          providerId,
          model: model.model,
          routing,
          settings,
        });
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            loading={pending}
            disabled={validation.length > 0}
          >
            {pending ? "Adding…" : "Add model preset"}
          </Button>
        </>
      }
    >
      <Field
        label="Provider connection"
        hint="The API key stays attached to this project connection."
      >
        <Select
          value={providerId}
          onChange={(event) => {
            setProviderId(event.target.value);
            setModel(null);
            setCatalogSearch("");
          }}
        >
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName} — {entry.providerType}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Model"
        hint={
          model
            ? `${model.model}${model.contextWindow === null ? "" : ` · ${formatNumber(model.contextWindow)} token context`}`
            : "Search the live catalog available to this provider connection."
        }
      >
        <Combobox
          label="Model"
          value={model?.model ?? ""}
          {...(model
            ? {
                selectedOption: {
                  value: model.model,
                  label: model.name,
                  description: model.model,
                },
              }
            : {})}
          options={catalogOptions}
          onChange={chooseModel}
          onSearchChange={setCatalogSearch}
          loading={catalogQuery.isPending}
          {...(catalogQuery.isError
            ? { errorMessage: catalogQuery.error.message }
            : {})}
          emptyMessage="No catalog entry matches this search"
          placeholder="Search models…"
          disabled={!provider}
        />
      </Field>
      {catalogQuery.isError ? (
        <FormError>{catalogQuery.error.message}</FormError>
      ) : null}
      {provider?.providerType === "openai" ? (
        <details className="policy-details" open>
          <summary>
            Model settings
            <span className="policy-summary">
              {reasoningMode} · {reasoningEffort} reasoning · {verbosity}
              {" verbosity"}
            </span>
          </summary>
          <div className="policy-body">
            <FieldRow>
              <Field label="Text format">
                <Select value="text" disabled>
                  <option value="text">text</option>
                </Select>
              </Field>
              <Field label="Reasoning mode">
                <Select
                  value={reasoningMode}
                  onChange={(event) =>
                    setReasoningMode(event.target.value as "standard" | "pro")
                  }
                >
                  <option value="standard">standard</option>
                  <option value="pro">pro</option>
                </Select>
              </Field>
              <Field label="Reasoning effort">
                <Select
                  value={reasoningEffort}
                  onChange={(event) =>
                    setReasoningEffort(
                      event.target.value as OpenAISettings["effort"],
                    )
                  }
                >
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </Select>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Verbosity">
                <Select
                  value={verbosity}
                  onChange={(event) =>
                    setVerbosity(
                      event.target.value as OpenAISettings["verbosity"],
                    )
                  }
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </Select>
              </Field>
              <Field label="Summary">
                <Select
                  value={reasoningSummary}
                  onChange={(event) =>
                    setReasoningSummary(
                      event.target.value as OpenAISettings["summary"],
                    )
                  }
                >
                  <option value="auto">auto</option>
                  <option value="concise">concise</option>
                  <option value="detailed">detailed</option>
                </Select>
              </Field>
            </FieldRow>
          </div>
        </details>
      ) : null}
      {provider?.providerType === "anthropic" ? (
        <details className="policy-details" open>
          <summary>
            Claude settings
            <span className="policy-summary">
              {anthropicThinking} thinking · {anthropicEffort} effort ·{" "}
              {formatCompactNumber(anthropicMaxTokens)} max tokens
            </span>
          </summary>
          <div className="policy-body">
            <FieldRow>
              <Field
                label="Thinking"
                hint="Adaptive lets Claude decide when and how much to think."
              >
                <Select
                  value={anthropicThinking}
                  onChange={(event) => {
                    const thinking = event.target
                      .value as AnthropicSettings["thinking"];
                    setAnthropicThinking(thinking);
                    if (
                      thinking === "disabled" &&
                      /^claude-opus-5(?:-|$)/u.test(model?.catalogId ?? "") &&
                      (anthropicEffort === "xhigh" || anthropicEffort === "max")
                    )
                      setAnthropicEffort("high");
                  }}
                >
                  {model?.thinkingCanBeDisabled !== false ? (
                    <option value="disabled">Disabled</option>
                  ) : null}
                  {model?.adaptiveThinking ? (
                    <option value="adaptive">Adaptive</option>
                  ) : null}
                </Select>
              </Field>
              <Field
                label="Max tokens"
                hint="Hard ceiling for thinking plus response text."
              >
                <Input
                  type="number"
                  min={1}
                  max={model?.maxOutputTokens ?? 300_000}
                  step={1}
                  value={anthropicMaxTokens}
                  onChange={(event) =>
                    setAnthropicMaxTokens(Number(event.target.value))
                  }
                />
              </Field>
              <Field
                label="Effort"
                hint="Controls overall response and adaptive-thinking depth."
              >
                <Select
                  value={anthropicEffort}
                  onChange={(event) =>
                    setAnthropicEffort(
                      event.target.value as AnthropicSettings["effort"],
                    )
                  }
                >
                  {(model?.effortLevels?.length
                    ? model.effortLevels
                    : (["high"] as const)
                  )
                    .filter(
                      (effort) =>
                        anthropicThinking !== "disabled" ||
                        !/^claude-opus-5(?:-|$)/u.test(
                          model?.catalogId ?? "",
                        ) ||
                        (effort !== "xhigh" && effort !== "max"),
                    )
                    .map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                </Select>
              </Field>
            </FieldRow>
          </div>
        </details>
      ) : null}
      {provider?.providerType === "xai" &&
      (model?.effortLevels?.length ?? 0) > 0 ? (
        <details className="policy-details" open>
          <summary>
            Grok settings
            <span className="policy-summary">
              {xaiEffort} reasoning · text response
            </span>
          </summary>
          <div className="policy-body">
            <FieldRow>
              <Field
                label="Response format"
                hint="Agent sessions currently use free-form text or tool calls."
              >
                <Select value="text" disabled>
                  <option value="text">text</option>
                </Select>
              </Field>
              <Field
                label="Reasoning effort"
                hint="Controls Grok reasoning depth. Reasoning cannot be disabled on supported models."
              >
                <Select
                  value={xaiEffort}
                  onChange={(event) =>
                    setXAIEffort(event.target.value as XAISettings["effort"])
                  }
                >
                  {(model?.effortLevels ?? [])
                    .filter(
                      (effort): effort is XAISettings["effort"] =>
                        effort !== "max",
                    )
                    .map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                </Select>
              </Field>
            </FieldRow>
            <small>
              Tools and the system prompt are configured on the immutable agent
              version that uses this preset.
            </small>
          </div>
        </details>
      ) : null}
      <FieldRow>
        <Field
          label="Preset key"
          hint="Stable and versioned. Suggested from the model, and safe to rename."
        >
          <Input
            name="key"
            required
            className="input--mono"
            value={key}
            onChange={(event) => {
              setKeyEdited(true);
              setKey(event.target.value);
            }}
            placeholder="claude-sonnet-4-6-zdr-v1"
          />
        </Field>
        <Field
          label="Display name"
          hint="What operators see when they pick this preset."
        >
          <Input
            name="displayName"
            required
            value={displayName}
            onChange={(event) => {
              setDisplayNameEdited(true);
              setDisplayName(event.target.value);
            }}
            placeholder="Claude Sonnet 4.6 (zero retention)"
          />
        </Field>
      </FieldRow>
      {provider?.providerType === "openrouter" ? (
        <details className="policy-details">
          <summary>
            Routing and data policy
            <span className="policy-summary">{describeRouting(routing)}</span>
          </summary>
          <div className="policy-body">
            <FieldRow>
              <Field label="Data collection">
                <Select
                  value={dataCollection}
                  onChange={(event) =>
                    setDataCollection(
                      event.target.value as "" | "deny" | "allow",
                    )
                  }
                >
                  <option value="">Provider default</option>
                  <option value="deny">Deny</option>
                  <option value="allow">Allow</option>
                </Select>
              </Field>
              <Field label="Zero data retention">
                <Select
                  value={zeroDataRetention}
                  onChange={(event) =>
                    setZeroDataRetention(event.target.value as Tristate)
                  }
                >
                  <option value="">Provider default</option>
                  <option value="yes">Required</option>
                  <option value="no">Not required</option>
                </Select>
              </Field>
              <Field label="Fallback routing">
                <Select
                  value={allowFallbacks}
                  onChange={(event) =>
                    setAllowFallbacks(event.target.value as Tristate)
                  }
                >
                  <option value="">Provider default</option>
                  <option value="yes">Allowed</option>
                  <option value="no">Disallowed</option>
                </Select>
              </Field>
              <Field label="Require declared parameters">
                <Select
                  value={requireParameters}
                  onChange={(event) =>
                    setRequireParameters(event.target.value as Tristate)
                  }
                >
                  <option value="">Provider default</option>
                  <option value="yes">Required</option>
                  <option value="no">Not required</option>
                </Select>
              </Field>
              <Field label="Route preference">
                <Select
                  value={sort}
                  onChange={(event) =>
                    setSort(
                      event.target.value as
                        "" | "price" | "throughput" | "latency",
                    )
                  }
                >
                  <option value="">Provider default</option>
                  <option value="price">Lowest price</option>
                  <option value="throughput">Highest throughput</option>
                  <option value="latency">Lowest latency</option>
                </Select>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field
                label="Provider allowlist"
                hint="Comma separated upstream provider slugs."
              >
                <Input
                  value={providerAllowlist}
                  onChange={(event) => setProviderAllowlist(event.target.value)}
                  placeholder="anthropic"
                />
              </Field>
              <Field label="Provider denylist" hint="Comma separated.">
                <Input
                  value={providerDenylist}
                  onChange={(event) => setProviderDenylist(event.target.value)}
                />
              </Field>
              <Field
                label="Provider order"
                hint="Comma separated, most preferred first."
              >
                <Input
                  value={providerOrder}
                  onChange={(event) => setProviderOrder(event.target.value)}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field
                label="Max prompt price (USD per million tokens)"
                hint="A provider routing constraint, not a budget."
              >
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={maxPrompt}
                  onChange={(event) => setMaxPrompt(event.target.value)}
                />
              </Field>
              <Field label="Max completion price (USD per million tokens)">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={maxCompletion}
                  onChange={(event) => setMaxCompletion(event.target.value)}
                />
              </Field>
            </FieldRow>
          </div>
        </details>
      ) : (
        <Alert tone="info" role="status">
          Direct provider presets use their selected connection.
          OpenRouter-specific routing controls do not apply.
        </Alert>
      )}
      <ValidationPanel
        errors={validation}
        readyMessage={`Ready to approve. Routing summary: ${describeRouting(routing)}`}
      />
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** Read-only view of one preset; changing it means duplicating into a new key. */
function PresetDetailDialog({
  preset,
  provider,
  usedBy,
  usageLoading,
  onClose,
  onDuplicate,
  onArchive,
}: {
  readonly preset: ModelPreset;
  readonly provider: ProjectModelProvider | null;
  readonly usedBy: readonly AgentSummary[];
  readonly usageLoading: boolean;
  readonly onClose: () => void;
  readonly onDuplicate: () => void;
  readonly onArchive: () => void;
}) {
  const isProject = preset.origin === "project" && preset.id !== null;
  return (
    <Dialog
      wide
      title={preset.displayName}
      description="Presets are immutable so every published agent version keeps the exact model it was reviewed with. To change one, duplicate it into a new key."
      onClose={onClose}
      footer={
        <>
          {isProject ? (
            <Button
              variant="danger"
              icon={<Archive size={14} />}
              onClick={onArchive}
            >
              Archive preset
            </Button>
          ) : null}
          <Button onClick={onClose}>Close</Button>
          {isProject ? (
            <Button
              variant="primary"
              icon={<Copy size={14} />}
              onClick={onDuplicate}
              disabled={!preset.available}
            >
              Duplicate as new preset
            </Button>
          ) : null}
        </>
      }
    >
      <MetaGrid
        columns={2}
        items={[
          { label: "Key", value: <code>{preset.key}</code> },
          { label: "Model", value: <code>{preset.model}</code> },
          {
            label: "Provider connection",
            value: provider
              ? `${provider.displayName} · ${provider.providerType}`
              : preset.origin === "deployment"
                ? "Deployment configuration"
                : "Removed connection",
          },
          {
            label: "Source",
            value: preset.origin === "deployment" ? "Deployment" : "Project",
          },
          {
            label: "Availability",
            value: preset.available
              ? "Available to new agent versions"
              : "Unavailable",
          },
          {
            label: "Created",
            value: preset.createdAt
              ? formatDate(preset.createdAt)
              : "Deployment configuration",
          },
        ]}
      />
      <section className="stack">
        <h3>{preset.settings ? "Generation settings" : "Routing policy"}</h3>
        <p className="muted">{describePresetRouting(preset)}</p>
        {preset.origin === "project" ? (
          <JsonBlock
            label={preset.settings ? "Generation settings" : "Routing policy"}
            value={preset.settings ?? preset.routing}
          />
        ) : null}
      </section>
      <section className="stack">
        <h3>Used by</h3>
        {usageLoading ? (
          <p className="muted">Loading agents…</p>
        ) : usedBy.length === 0 ? (
          <p className="muted">No agent pins this preset.</p>
        ) : (
          <ul className="preset-usage">
            {usedBy.map((agent) => (
              <li key={agent.id}>
                <Link to={`/agents/${agent.id}`}>{agent.name}</Link>
                <span className="muted">
                  {" "}
                  · {agent.version == null ? "draft" : `v${agent.version}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}

function CreateProviderDialog({
  existingKeys,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly existingKeys: readonly string[];
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateModelProviderInput) => void;
}) {
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [providerType, setProviderType] =
    useState<CreateModelProviderInput["providerType"]>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const validation = [
    ...(!PROVIDER_KEY_PATTERN.test(key)
      ? ["Key must be lowercase and hyphen separated."]
      : []),
    ...(existingKeys.includes(key)
      ? ["Key is already used in this project."]
      : []),
    ...(displayName.trim().length < 2
      ? ["Display name must contain at least 2 characters."]
      : []),
    ...(apiKey.length < 8
      ? ["API key must contain at least 8 characters."]
      : []),
  ];
  return (
    <Dialog
      title="Add model provider"
      description="The API key is encrypted before it is stored and cannot be read back through the API or console."
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (validation.length === 0)
          onSubmit({ key, displayName, providerType, apiKey });
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            loading={pending}
            disabled={validation.length > 0}
          >
            {pending ? "Adding…" : "Add provider"}
          </Button>
        </>
      }
    >
      <Field label="Provider type">
        <Select
          value={providerType}
          onChange={(event) =>
            setProviderType(
              event.target.value as CreateModelProviderInput["providerType"],
            )
          }
        >
          <option value="openrouter">OpenRouter</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="xai">xAI (Grok)</option>
        </Select>
      </Field>
      <Field label="Connection key" hint="For example openrouter-primary.">
        <Input
          autoFocus
          className="input--mono"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </Field>
      <Field label="Display name">
        <Input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <Field
        label="API key"
        hint="Write-only. It will not be returned after submission."
      >
        <Input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

function RotateProviderCredentialDialog({
  provider,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly provider: ProjectModelProvider;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (apiKey: string) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  return (
    <Dialog
      title={`Rotate ${provider.displayName} key`}
      description={`Replaces credential version ${provider.credentialVersion}. Existing model presets keep working with the new key.`}
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (apiKey.length >= 8) onSubmit(apiKey);
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            loading={pending}
            disabled={apiKey.length < 8}
          >
            {pending ? "Rotating…" : "Rotate key"}
          </Button>
        </>
      }
    >
      <Alert tone="warning" role="status">
        The previous key stays encrypted and in use until this rotation
        succeeds.
      </Alert>
      <Field
        label="New API key"
        hint="Write-only. It will not be returned after submission."
      >
        <Input
          autoFocus
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

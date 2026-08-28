import { Cpu, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useApi } from "../api/context";
import type {
  CreateModelPresetInput,
  CreateModelProviderInput,
  ModelCatalogEntry,
  ModelGenerationSettings,
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
  Dialog,
  EmptyState,
  EntityCell,
  ErrorState,
  Field,
  FieldRow,
  FormError,
  Input,
  LoadingState,
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
  { readonly textFormat: "text" }
>;
type AnthropicSettings = Extract<
  ModelGenerationSettings,
  { readonly thinking: "disabled" | "adaptive" }
>;

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
                    <Button
                      size="sm"
                      icon={<RefreshCw size={13} />}
                      onClick={() => setRotatingProvider(provider)}
                    >
                      Rotate key
                    </Button>
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
          description="A preset is append-only: publish a new key rather than editing one already in use."
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
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((preset) => (
                <tr key={preset.key}>
                  <td>
                    <EntityCell
                      icon={<Cpu size={15} />}
                      name={preset.displayName}
                      meta={preset.key}
                    />
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

      {creating ? (
        <CreateModelPresetDialog
          existingKeys={(presets.data?.data ?? []).map((preset) => preset.key)}
          providers={providers.data ?? []}
          pending={create.isPending}
          error={create.error}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
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
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly existingKeys: readonly string[];
  readonly providers: readonly ProjectModelProvider[];
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateModelPresetInput) => void;
}) {
  const api = useApi();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const provider = providers.find((entry) => entry.id === providerId);
  const [catalogSearch, setCatalogSearch] = useState("");
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
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [displayNameEdited, setDisplayNameEdited] = useState(false);
  const [dataCollection, setDataCollection] = useState<"" | "deny" | "allow">(
    "",
  );
  const [zeroDataRetention, setZeroDataRetention] = useState<Tristate>("");
  const [allowFallbacks, setAllowFallbacks] = useState<Tristate>("");
  const [requireParameters, setRequireParameters] = useState<Tristate>("");
  const [providerAllowlist, setProviderAllowlist] = useState("");
  const [providerDenylist, setProviderDenylist] = useState("");
  const [providerOrder, setProviderOrder] = useState("");
  const [sort, setSort] = useState<"" | "price" | "throughput" | "latency">("");
  const [maxPrompt, setMaxPrompt] = useState("");
  const [maxCompletion, setMaxCompletion] = useState("");
  const [reasoningMode, setReasoningMode] = useState<"standard" | "pro">(
    "standard",
  );
  const [reasoningEffort, setReasoningEffort] =
    useState<OpenAISettings["effort"]>("medium");
  const [verbosity, setVerbosity] =
    useState<OpenAISettings["verbosity"]>("medium");
  const [reasoningSummary, setReasoningSummary] =
    useState<OpenAISettings["summary"]>("auto");
  const [anthropicThinking, setAnthropicThinking] =
    useState<AnthropicSettings["thinking"]>("adaptive");
  const [anthropicMaxTokens, setAnthropicMaxTokens] = useState(20_000);
  const [anthropicEffort, setAnthropicEffort] =
    useState<AnthropicSettings["effort"]>("high");

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
      title="Add model preset"
      description="A preset is append-only. Publish a new preset key instead of changing an existing one, so already published agent versions keep the model they were reviewed with."
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

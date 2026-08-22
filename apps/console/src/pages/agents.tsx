import {
  Bot,
  Braces,
  ChevronRight,
  Pencil,
  Plus,
  Save,
  Trash2,
  Wrench,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api/context";
import type {
  AgentSummary,
  AgentVersionConfig,
  ModelPreset,
  ProjectSandboxProvider,
  SandboxSnapshotEntry,
  SkillSummary,
  ToolDefinition,
} from "../api/types";
import { describePresetRouting } from "../model-presets";
import type { ComboboxOption } from "../components/ui";
import {
  Alert,
  Button,
  Chip,
  CheckboxRow,
  Combobox,
  Dialog,
  EmptyState,
  EntityCell,
  ErrorState,
  Field,
  FieldRow,
  FilterBar,
  FormError,
  Input,
  JsonBlock,
  LoadingState,
  Page,
  PageHeader,
  Pagination,
  Panel,
  SearchField,
  Select,
  StatusChip,
  Switch,
  TableCard,
  Textarea,
  ValidationPanel,
  formatDate,
  useToast,
} from "../components/ui";

const agentStatuses = ["", "published", "draft", "archived"];
type SandboxCapability = AgentVersionConfig["sandbox"]["capabilities"][number];

function parseToolsJson(value: string): {
  readonly tools: readonly ToolDefinition[];
  readonly error?: string;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed))
      return { tools: [], error: "Tools JSON must be an array." };
    if (
      parsed.some(
        (tool) => !tool || typeof tool !== "object" || Array.isArray(tool),
      )
    )
      return { tools: [], error: "Every tool must be a JSON object." };
    const tools = parsed as ToolDefinition[];
    if (
      tools.some(
        (tool) =>
          typeof tool.name !== "string" || tool.name.trim().length === 0,
      )
    )
      return { tools: [], error: "Every tool needs a non-empty string name." };
    return { tools };
  } catch (error) {
    return {
      tools: [],
      error: error instanceof Error ? error.message : "Tools JSON is invalid.",
    };
  }
}

function parseToolJson(value: string): {
  readonly tool?: ToolDefinition;
  readonly error?: string;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { error: "The tool must be a single JSON object." };
    const tool = parsed as ToolDefinition;
    if (typeof tool.name !== "string" || tool.name.trim().length === 0)
      return { error: "The tool needs a non-empty string name." };
    return { tool };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Tool JSON is invalid.",
    };
  }
}

/** Seed for a freshly added tool; the modal editor takes it from here. */
const TOOL_TEMPLATE = {
  schemaVersion: 1,
  name: "new_tool",
  description: "Describe when the model should use this tool.",
  owner: "caller",
  approval: "always",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

const sandboxCapabilityOptions = [
  [
    "filesystem_read",
    "Read files",
    "Adds read. Shell also adds grep and glob.",
  ],
  ["filesystem_write", "Write files", "Adds write and edit."],
  ["shell", "Shell and search", "Adds bash, grep, and glob."],
  [
    "browser",
    "Browser session",
    "Adds navigate, accessibility snapshot, screenshot, and interaction tools.",
  ],
] as const satisfies readonly (readonly [SandboxCapability, string, string])[];

/**
 * Presets are append-only, so the list only ever grows: it is searched rather
 * than scrolled, and an unavailable preset stays visible but unselectable.
 */
function presetOptions(
  presets: readonly ModelPreset[],
): readonly ComboboxOption[] {
  return presets.map((preset) => ({
    value: preset.key,
    label: preset.displayName,
    description: preset.key,
    keywords: preset.model,
    hint: preset.available
      ? preset.origin === "deployment"
        ? "deployment"
        : "project"
      : "unavailable",
    ...(preset.available ? {} : { disabled: true }),
  }));
}

function snapshotLabel(snapshot: SandboxSnapshotEntry): string {
  const resources = `${snapshot.cpu} CPU · ${snapshot.memoryGiB} GiB · ${snapshot.diskGiB} GiB disk`;
  const image =
    snapshot.imageName && snapshot.imageName !== snapshot.name
      ? ` · ${snapshot.imageName}`
      : "";
  return `${snapshot.name}${image} · ${resources}${snapshot.available ? "" : ` · ${snapshot.state}`}`;
}

function delegateSandboxMismatch(
  coordinator: AgentVersionConfig["sandbox"],
  child: AgentVersionConfig["sandbox"],
): string | undefined {
  if (coordinator.enabled !== child.enabled)
    return child.enabled
      ? "sandbox is enabled for this child but disabled for the coordinator"
      : "sandbox is disabled for this child, so it cannot share the coordinator workspace";
  if (coordinator.provider !== child.provider)
    return `sandbox provider ${child.provider} does not match coordinator provider ${coordinator.provider}`;
  if ((coordinator.snapshotId ?? null) !== (child.snapshotId ?? null))
    return "the Daytona snapshot does not match the coordinator snapshot";
  if (coordinator.network !== child.network)
    return `network policy ${child.network} does not match coordinator policy ${coordinator.network}`;
  return undefined;
}

function initialAgentConfig(
  name: string,
  modelPreset: string,
  sandboxProvider: string,
): AgentVersionConfig {
  return {
    systemPrompt: `You are ${name}, a helpful managed agent. Complete the user's request carefully and do not expose secrets or internal reasoning.`,
    modelPreset,
    tools: [],
    skillVersionIds: [],
    delegates: [],
    sandbox: {
      enabled: false,
      provider: sandboxProvider,
      network: "none",
      capabilities: ["filesystem_read", "filesystem_write", "shell"],
    },
    limits: { maxTurns: 32, timeoutMs: 60_000 },
  };
}

interface CreateAgentInput {
  readonly name: string;
  readonly description: string;
  readonly modelPreset: string;
  readonly sandbox: AgentVersionConfig["sandbox"];
  readonly skillVersionIds: readonly string[];
}

export function AgentsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useToast();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["agents", { search, status, date, page }],
    queryFn: () => api.listAgents({ search, status, date, page }),
  });
  const modelPresets = useQuery({
    queryKey: ["model-presets"],
    queryFn: () => api.listModelPresets(),
  });
  const sandboxProviders = useQuery({
    queryKey: ["sandbox-providers"],
    queryFn: () => api.listSandboxProviders(),
  });
  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills({}),
  });
  const create = useMutation({
    mutationFn: (input: CreateAgentInput) => {
      const config = initialAgentConfig(
        input.name,
        input.modelPreset,
        input.sandbox.provider,
      );
      return api.createAgent({
        name: input.name,
        description: input.description,
        initialConfig: {
          ...config,
          sandbox: input.sandbox,
          skillVersionIds: input.skillVersionIds,
        },
      });
    },
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      setCreating(false);
      notify("Agent created.");
      navigate(`/agents/${agent.id}`);
    },
  });
  const filtered = Boolean(search || status || date);
  const openCreate = () => setCreating(true);

  return (
    <Page>
      <PageHeader
        eyebrow="Build"
        title="Agents"
        description="Versioned agent definitions, approved models, tools, and sandbox policies."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={openCreate}
          >
            Create agent
          </Button>
        }
      />
      <FilterBar label="Agent filters">
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          label="Search agents"
        />
        <Field label="Status">
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            {agentStatuses.map((value) => (
              <option key={value} value={value}>
                {value
                  ? value[0]!.toUpperCase() + value.slice(1)
                  : "All statuses"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Created on">
          <Input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setPage(1);
            }}
          />
        </Field>
        {filtered ? (
          <Button
            className="filter-reset"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatus("");
              setDate("");
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </FilterBar>
      {query.isPending ? (
        <LoadingState label="Loading agents" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState
          title={filtered ? "No matching agents" : "No agents yet"}
          description={
            filtered
              ? "Try clearing one or more filters."
              : "An agent is a durable runtime with a versioned prompt, approved model, and tool policy."
          }
          action={
            filtered ? undefined : (
              <Button variant="primary" size="sm" onClick={openCreate}>
                Create agent
              </Button>
            )
          }
        />
      ) : (
        <TableCard
          label="Agents table"
          caption="Agents in this project"
          footer={
            <Pagination
              page={query.data.page}
              pageSize={query.data.pageSize}
              total={query.data.total}
              onChange={setPage}
            />
          }
        >
          <thead>
            <tr>
              <th>Name</th>
              <th>Model</th>
              <th>Status</th>
              <th>Version</th>
              <th>Created</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((agent) => (
              <tr key={agent.id}>
                <td>
                  <Link to={`/agents/${agent.id}`}>
                    <EntityCell
                      icon={<Bot size={15} />}
                      name={agent.name}
                      meta={agent.key}
                    />
                  </Link>
                </td>
                <td className="mono">{agent.model}</td>
                <td>
                  <StatusChip value={agent.status} />
                </td>
                <td className="mono">v{agent.version}</td>
                <td>{formatDate(agent.createdAt)}</td>
                <td>{formatDate(agent.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableCard>
      )}
      {creating ? (
        <CreateAgentDialog
          pending={create.isPending}
          error={create.error}
          modelPresets={modelPresets.data?.data ?? []}
          modelPresetsPending={modelPresets.isPending}
          modelPresetsError={modelPresets.error}
          sandboxProviders={sandboxProviders.data?.data ?? []}
          sandboxProvidersPending={sandboxProviders.isPending}
          sandboxProvidersError={sandboxProviders.error}
          skills={skills.data?.data ?? []}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
        />
      ) : null}
    </Page>
  );
}

function CreateAgentDialog({
  pending,
  error,
  modelPresets,
  modelPresetsPending,
  modelPresetsError,
  sandboxProviders,
  sandboxProvidersPending,
  sandboxProvidersError,
  skills,
  onClose,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: Error | null;
  readonly modelPresets: readonly ModelPreset[];
  readonly modelPresetsPending: boolean;
  readonly modelPresetsError: Error | null;
  readonly sandboxProviders: readonly ProjectSandboxProvider[];
  readonly sandboxProvidersPending: boolean;
  readonly sandboxProvidersError: Error | null;
  readonly skills: readonly SkillSummary[];
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateAgentInput) => void;
}) {
  const [modelPreset, setModelPreset] = useState("");
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [sandboxProvider, setSandboxProvider] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [network, setNetwork] = useState<"none" | "restricted">("none");
  const [sandboxCapabilities, setSandboxCapabilities] = useState<
    readonly SandboxCapability[]
  >(["filesystem_read", "filesystem_write", "shell"]);
  const [skillVersionIds, setSkillVersionIds] = useState<readonly string[]>([]);
  const selectedPreset = modelPresets.find(
    (preset) => preset.key === modelPreset,
  );
  const availablePresets = modelPresets.filter((preset) => preset.available);
  const selectedSandboxProvider = sandboxProviders.find(
    (provider) => provider.key === sandboxProvider,
  );
  const api = useApi();
  const snapshots = useQuery({
    queryKey: ["sandbox-snapshots", selectedSandboxProvider?.id],
    queryFn: () => api.listSandboxSnapshots(selectedSandboxProvider!.id),
    enabled: sandboxEnabled && Boolean(selectedSandboxProvider),
  });
  useEffect(() => {
    if (!availablePresets.some((preset) => preset.key === modelPreset))
      setModelPreset(availablePresets[0]?.key ?? "");
  }, [availablePresets, modelPreset]);
  useEffect(() => {
    if (!sandboxProviders.some((provider) => provider.key === sandboxProvider))
      setSandboxProvider(sandboxProviders[0]?.key ?? "");
  }, [sandboxProvider, sandboxProviders]);
  const canSubmit =
    !pending &&
    !modelPresetsPending &&
    !modelPresetsError &&
    availablePresets.some((preset) => preset.key === modelPreset) &&
    !sandboxProvidersPending &&
    !sandboxProvidersError &&
    sandboxProviders.some((provider) => provider.key === sandboxProvider) &&
    (!sandboxEnabled ||
      (snapshotId.length > 0 &&
        (snapshots.data?.data ?? []).some(
          (snapshot) => snapshot.id === snapshotId && snapshot.available,
        )));

  return (
    <Dialog
      title="Create agent"
      description="Creates the definition together with a valid, immutable first version."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({
          name: String(data.get("name") ?? ""),
          description: String(data.get("description") ?? ""),
          modelPreset: String(data.get("modelPreset") ?? ""),
          sandbox: {
            enabled: sandboxEnabled,
            provider: sandboxProvider,
            ...(snapshotId ? { snapshotId } : {}),
            network,
            capabilities: sandboxCapabilities,
          },
          skillVersionIds,
        });
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            loading={pending}
            disabled={!canSubmit}
          >
            {pending ? "Creating…" : "Create agent"}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input
          name="name"
          required
          minLength={2}
          autoFocus
          placeholder="e.g. Support operator"
        />
      </Field>
      <Field label="Description">
        <Textarea
          name="description"
          rows={3}
          maxLength={2000}
          placeholder="What should this agent do?"
        />
      </Field>
      <Field
        label="Skills"
        hint="Exact versions are frozen into agent version 1 and inherited by every new session."
      >
        {skills.length === 0 ? (
          <p className="muted">
            No active Skills are available. <Link to="/skills">Create one</Link>
            .
          </p>
        ) : (
          <div className="stack">
            {skills
              .filter((skill) => skill.status === "active")
              .map((skill) => (
                <CheckboxRow
                  key={skill.id}
                  label={`${skill.displayName} · v${skill.version}`}
                  description={skill.description}
                  checked={skillVersionIds.includes(skill.latestVersionId)}
                  disabled={pending}
                  onChange={(event) =>
                    setSkillVersionIds((current) =>
                      event.target.checked
                        ? [...current, skill.latestVersionId]
                        : current.filter((id) => id !== skill.latestVersionId),
                    )
                  }
                />
              ))}
          </div>
        )}
      </Field>
      <Field
        label="Approved model preset"
        hint="The first immutable version will be published with this preset."
      >
        <Combobox
          label="Approved model preset"
          name="modelPreset"
          value={modelPreset}
          options={presetOptions(modelPresets)}
          onChange={setModelPreset}
          disabled={
            pending || modelPresetsPending || Boolean(modelPresetsError)
          }
          loading={modelPresetsPending}
          {...(modelPresetsError
            ? { errorMessage: modelPresetsError.message }
            : {})}
          emptyMessage="No approved preset matches this search"
          placeholder="Search approved presets…"
        />
      </Field>
      <Alert
        tone={modelPresetsError ? "danger" : "info"}
        role={modelPresetsError ? "alert" : "status"}
      >
        {modelPresetsError ? (
          <>
            <strong>Model presets could not be loaded.</strong>
            <span>{modelPresetsError.message}</span>
          </>
        ) : modelPresetsPending ? (
          <>
            <strong>Loading approved model presets</strong>
            <span>
              The agent can be created after the project catalog loads.
            </span>
          </>
        ) : selectedPreset ? (
          <>
            <strong>
              {selectedPreset.displayName} · {selectedPreset.model}
            </strong>
            <span>
              {selectedPreset.origin === "deployment"
                ? "Deployment preset"
                : "Project preset"}{" "}
              · {describePresetRouting(selectedPreset)}{" "}
              <Link to="/models">Manage models</Link>
            </span>
          </>
        ) : (
          <>
            <strong>Select an approved model preset</strong>
            <span>
              Add or repair project presets from{" "}
              <Link to="/models">Models</Link>.
            </span>
          </>
        )}
      </Alert>
      <div className="stack">
        <Switch
          label="Enable sandbox"
          checked={sandboxEnabled}
          disabled={pending}
          onChange={setSandboxEnabled}
        />
        <FieldRow>
          <Field
            label="Sandbox provider"
            hint="Choose a project-scoped Daytona connection."
          >
            <Select
              value={sandboxProvider}
              disabled={pending}
              onChange={(event) => {
                setSandboxProvider(event.target.value);
                setSnapshotId("");
              }}
            >
              {sandboxProviders.map((provider) => (
                <option key={provider.id} value={provider.key}>
                  {provider.displayName} · {provider.providerType}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Daytona snapshot"
            hint="Select an active snapshot returned by the connected Daytona account."
          >
            <Select
              value={snapshotId}
              disabled={
                pending ||
                !sandboxEnabled ||
                !selectedSandboxProvider ||
                snapshots.isPending ||
                snapshots.isError
              }
              onChange={(event) => setSnapshotId(event.target.value)}
            >
              <option value="" disabled>
                Select an active Daytona snapshot
              </option>
              {(snapshots.data?.data ?? []).map((snapshot) => (
                <option
                  key={snapshot.id}
                  value={snapshot.id}
                  disabled={!snapshot.available}
                >
                  {snapshotLabel(snapshot)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Network policy">
            <Select
              value={network}
              disabled={pending || !sandboxEnabled}
              onChange={(event) =>
                setNetwork(event.target.value as "none" | "restricted")
              }
            >
              <option value="none">No network</option>
              <option value="restricted">Restricted</option>
            </Select>
          </Field>
        </FieldRow>
        {snapshots.isError ? (
          <Alert tone="danger" role="alert">
            <strong>Daytona snapshots could not be loaded.</strong>
            <span>{snapshots.error.message}</span>
          </Alert>
        ) : snapshots.isPending && sandboxEnabled ? (
          <Alert tone="info" role="status">
            <strong>Loading Daytona snapshots</strong>
          </Alert>
        ) : sandboxEnabled &&
          snapshots.data &&
          !snapshots.data.data.some((snapshot) => snapshot.available) ? (
          <Alert tone="warning" role="alert">
            <strong>No active Daytona snapshots are available.</strong>
            <span>
              Create or activate a snapshot in Daytona, then try again.
            </span>
          </Alert>
        ) : null}
        {sandboxProvidersError ? (
          <Alert tone="danger" role="alert">
            <strong>Sandbox providers could not be loaded.</strong>
            <span>{sandboxProvidersError.message}</span>
          </Alert>
        ) : sandboxProvidersPending ? (
          <Alert tone="info" role="status">
            <strong>Loading sandbox providers</strong>
          </Alert>
        ) : sandboxProviders.length === 0 ? (
          <Alert tone="info" role="status">
            <strong>No Daytona sandbox provider configured.</strong>
            <span>
              Add a connection in{" "}
              <Link to="/sandbox-providers">Sandbox providers</Link>.
            </span>
          </Alert>
        ) : null}
        <div className="field-row">
          {sandboxCapabilityOptions.map(([capability, label, description]) => (
            <CheckboxRow
              key={capability}
              label={label}
              description={description}
              checked={sandboxCapabilities.includes(capability)}
              disabled={pending || !sandboxEnabled}
              onChange={(event) =>
                setSandboxCapabilities((current) =>
                  event.target.checked
                    ? [...current, capability]
                    : current.filter((entry) => entry !== capability),
                )
              }
            />
          ))}
        </div>
      </div>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

export function AgentDetailPage() {
  const { agentId = "" } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const query = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const modelPresets = useQuery({
    queryKey: ["model-presets"],
    queryFn: () => api.listModelPresets(),
  });
  const sandboxProviders = useQuery({
    queryKey: ["sandbox-providers"],
    queryFn: () => api.listSandboxProviders(),
  });
  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills({}),
  });
  const agents = useQuery({
    queryKey: ["agents", "delegate-roster"],
    queryFn: () => api.listAgents({}),
  });
  const publish = useMutation({
    mutationFn: (config: AgentVersionConfig) =>
      api.publishAgentVersion(agentId, config),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      notify("New agent version published.");
    },
  });
  if (query.isPending)
    return (
      <Page>
        <LoadingState label="Loading agent" rows={7} />
      </Page>
    );
  if (query.isError)
    return (
      <Page>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </Page>
    );
  return (
    <AgentEditor
      key={`${query.data.id}:${query.data.version}`}
      agent={query.data}
      publishing={publish.isPending}
      publishError={publish.error}
      onPublish={(config) => publish.mutate(config)}
      modelPresets={modelPresets.data?.data ?? []}
      sandboxProviders={sandboxProviders.data?.data ?? []}
      sandboxProvidersError={sandboxProviders.error}
      skills={skills.data?.data ?? []}
      availableAgents={(agents.data?.data ?? []).filter(
        (candidate) => candidate.id !== query.data.id,
      )}
    />
  );
}

function AgentEditor({
  agent,
  publishing,
  publishError,
  onPublish,
  modelPresets,
  sandboxProviders,
  sandboxProvidersError,
  skills,
  availableAgents,
}: {
  readonly agent: Awaited<ReturnType<ReturnType<typeof useApi>["getAgent"]>>;
  readonly publishing: boolean;
  readonly publishError: Error | null;
  readonly onPublish: (config: AgentVersionConfig) => void;
  readonly modelPresets: readonly ModelPreset[];
  readonly sandboxProviders: readonly ProjectSandboxProvider[];
  readonly sandboxProvidersError: Error | null;
  readonly skills: readonly SkillSummary[];
  readonly availableAgents: readonly AgentSummary[];
}) {
  const api = useApi();
  const [selectedVersion, setSelectedVersion] = useState(agent.version);
  const selected =
    agent.versions.find((version) => version.version === selectedVersion) ??
    agent.versions[0];
  const baseConfig = selected?.config ?? initialAgentConfig(agent.name, "", "");
  const [instructions, setInstructions] = useState(baseConfig.systemPrompt);
  const [modelPreset, setModelPreset] = useState(baseConfig.modelPreset);
  const [sandboxEnabled, setSandboxEnabled] = useState(
    baseConfig.sandbox.enabled,
  );
  const [network, setNetwork] = useState(baseConfig.sandbox.network);
  const [sandboxProvider, setSandboxProvider] = useState(
    baseConfig.sandbox.provider,
  );
  const [snapshotId, setSnapshotId] = useState(
    baseConfig.sandbox.snapshotId ?? "",
  );
  const [sandboxCapabilities, setSandboxCapabilities] = useState(
    baseConfig.sandbox.capabilities,
  );
  const [timeout, setTimeoutValue] = useState(baseConfig.limits.timeoutMs);
  const [skillVersionIds, setSkillVersionIds] = useState(
    baseConfig.skillVersionIds ?? [],
  );
  const [delegates, setDelegates] = useState(baseConfig.delegates ?? []);
  const [tools, setTools] = useState<readonly ToolDefinition[]>(
    baseConfig.tools,
  );
  const [toolEditor, setToolEditor] = useState<number | "new" | null>(null);
  const [bulkToolEditor, setBulkToolEditor] = useState(false);
  const selectedSandboxProvider = sandboxProviders.find(
    (provider) => provider.key === sandboxProvider,
  );
  const snapshots = useQuery({
    queryKey: ["sandbox-snapshots", selectedSandboxProvider?.id],
    queryFn: () => api.listSandboxSnapshots(selectedSandboxProvider!.id),
    enabled: Boolean(selectedSandboxProvider),
  });
  const isLatest = !selected || selectedVersion === agent.version;
  const selectedPreset = modelPresets.find(
    (preset) => preset.key === modelPreset,
  );
  const chooseVersion = (version: number) => {
    const next = agent.versions.find((item) => item.version === version);
    if (!next) return;
    setSelectedVersion(version);
    setInstructions(next.config.systemPrompt);
    setModelPreset(next.config.modelPreset);
    setSandboxEnabled(next.config.sandbox.enabled);
    setSandboxProvider(next.config.sandbox.provider);
    setSnapshotId(next.config.sandbox.snapshotId ?? "");
    setNetwork(next.config.sandbox.network);
    setSandboxCapabilities(next.config.sandbox.capabilities);
    setTimeoutValue(next.config.limits.timeoutMs);
    setSkillVersionIds(next.config.skillVersionIds ?? []);
    setDelegates(next.config.delegates ?? []);
    setTools(next.config.tools);
  };
  const config: AgentVersionConfig = {
    ...baseConfig,
    systemPrompt: instructions,
    modelPreset,
    tools,
    skillVersionIds,
    delegates,
    sandbox: {
      enabled: sandboxEnabled,
      provider: sandboxProvider,
      ...(snapshotId ? { snapshotId } : {}),
      network,
      capabilities: sandboxCapabilities,
    },
    limits: { maxTurns: 32, timeoutMs: timeout },
  };
  const incompatibleSelectedDelegates = delegates.flatMap((delegate) => {
    const candidate = availableAgents.find(
      (item) => item.latestVersionId === delegate.agentVersionId,
    );
    if (!candidate) return [];
    const mismatch = delegateSandboxMismatch(config.sandbox, candidate.sandbox);
    return mismatch ? [{ delegate, candidate, mismatch }] : [];
  });
  const validation: string[] = [];
  if (instructions.trim().length < 20)
    validation.push("System instructions must contain at least 20 characters.");
  const duplicateToolNames = [
    ...new Set(
      tools
        .map((tool) => tool.name)
        .filter((name, index, all) => all.indexOf(name) !== index),
    ),
  ];
  if (duplicateToolNames.length > 0)
    validation.push(
      `Tool names must be unique: ${duplicateToolNames.join(", ")}.`,
    );
  if (timeout < 1_000 || timeout > 3_600_000)
    validation.push("Run timeout must be between 1,000 and 3,600,000 ms.");
  if (!modelPreset) validation.push("An approved model preset is required.");
  else if (
    modelPresets.length > 0 &&
    !modelPresets.some((preset) => preset.key === modelPreset)
  )
    validation.push(
      `${modelPreset} is not an approved model preset for this project.`,
    );
  else if (
    modelPresets.some(
      (preset) => preset.key === modelPreset && !preset.available,
    )
  )
    validation.push(`${modelPreset} is not available in this deployment.`);
  if (!sandboxProviders.some((provider) => provider.key === sandboxProvider))
    validation.push(
      `${sandboxProvider} is not a configured Daytona connection for this project.`,
    );
  if (sandboxProvidersError)
    validation.push("Sandbox connections could not be verified.");
  if (sandboxEnabled) {
    if (!snapshotId) validation.push("Select an active Daytona snapshot.");
    else if (snapshots.isError)
      validation.push("The selected Daytona snapshot could not be verified.");
    else if (
      snapshots.data &&
      !snapshots.data.data.some(
        (snapshot) => snapshot.id === snapshotId && snapshot.available,
      )
    )
      validation.push(
        `${snapshotId} is not an active snapshot for this Daytona connection.`,
      );
  }
  for (const { candidate, mismatch } of incompatibleSelectedDelegates)
    validation.push(
      `${candidate.name} cannot be delegated: ${mismatch}. Publish a compatible child version first or remove it from this version.`,
    );

  return (
    <Page>
      <PageHeader
        breadcrumbs={[
          { label: "Agents", to: "/agents" },
          { label: agent.name },
        ]}
        eyebrow={`${agent.key} · v${agent.version}`}
        title={agent.name}
        description={agent.description}
        actions={
          <>
            <StatusChip value={agent.status} />
            <Button
              variant="primary"
              icon={<Save size={15} />}
              disabled={validation.length > 0 || !isLatest}
              loading={publishing}
              onClick={() => onPublish(config)}
            >
              {publishing ? "Publishing…" : "Publish new version"}
            </Button>
          </>
        }
      />
      <div className="editor-stack">
        <nav className="version-strip" aria-label="Immutable versions">
          <span className="eyebrow">Versions · immutable</span>
          {agent.versions.length === 0 ? (
            <p className="muted">
              No versions yet. Publish the default draft to create version 1.
            </p>
          ) : (
            <>
              <div className="version-strip-list">
                {agent.versions.map((version) => (
                  <button
                    type="button"
                    key={version.id}
                    aria-current={version.version === selectedVersion}
                    className={
                      version.version === selectedVersion
                        ? "version-pill version-pill--active"
                        : "version-pill"
                    }
                    title={`${formatDate(version.createdAt)} · ${version.contentHash}`}
                    onClick={() => chooseVersion(version.version)}
                  >
                    Version {version.version}
                    {version.version === agent.version ? (
                      <Chip tone="info">latest</Chip>
                    ) : null}
                  </button>
                ))}
              </div>
              {selected ? (
                <span
                  className="version-strip-meta"
                  title={selected.contentHash}
                >
                  <time dateTime={selected.createdAt}>
                    {formatDate(selected.createdAt)}
                  </time>
                  <code>{selected.contentHash}</code>
                </span>
              ) : null}
            </>
          )}
        </nav>
        {!isLatest ? (
          <Alert tone="info" title="Viewing an immutable version" role="status">
            Published versions can never change. Select the latest version to
            prepare a new publish.
          </Alert>
        ) : null}
        <Panel
          title="Agent definition"
          description="Changes become immutable when published."
        >
          <div className="stack">
            <Field
              label="Approved model preset"
              hint="Publishing links this immutable version to the selected preset. Provider routing stays behind the model adapter."
            >
              <Combobox
                label="Approved model preset"
                value={modelPreset}
                options={presetOptions(modelPresets)}
                onChange={setModelPreset}
                disabled={!isLatest}
                emptyMessage="No approved preset matches this search"
                placeholder="Search approved presets…"
              />
            </Field>
            <Alert tone="info" role="status">
              <strong>
                {selectedPreset
                  ? `${selectedPreset.displayName} · ${selectedPreset.model}`
                  : "Select an approved model preset"}
              </strong>
              <span>
                {selectedPreset
                  ? `${selectedPreset.origin === "deployment" ? "Deployment preset" : "Project preset"} · ${describePresetRouting(selectedPreset)}`
                  : "Only presets approved for this project can be published."}{" "}
                <Link to="/models">Manage models</Link>
              </span>
            </Alert>
            <Field
              label="System instructions"
              hint="Provider reasoning is shown only in the authorized session transcript; credentials and authorization headers remain excluded."
            >
              <Textarea
                rows={9}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                disabled={!isLatest}
              />
            </Field>
          </div>
        </Panel>
        <Panel
          title="Tools"
          collapsible
          defaultCollapsed
          description={
            tools.length === 0
              ? "No caller or platform tools are configured. Enabled sandbox tools are selected under Sandbox policy."
              : `${tools.length} tool ${tools.length === 1 ? "definition is" : "definitions are"} sent to the model and enforced at execution.`
          }
          actions={
            <>
              <Button
                size="sm"
                icon={<Braces size={14} />}
                disabled={!isLatest}
                onClick={() => setBulkToolEditor(true)}
              >
                Edit JSON
              </Button>
              <Button
                size="sm"
                icon={<Plus size={14} />}
                disabled={!isLatest}
                onClick={() => setToolEditor("new")}
              >
                Add tool
              </Button>
            </>
          }
        >
          {tools.length === 0 ? (
            <EmptyState
              icon="⌥"
              title="No tools configured"
              description="Add a tool definition, or paste a complete list with Edit JSON. Enabled sandbox tools are selected below."
            />
          ) : (
            <div className="tool-list">
              {tools.map((tool, index) => (
                <ToolListItem
                  key={`${tool.name}:${index}`}
                  tool={tool}
                  editable={isLatest}
                  onEdit={() => setToolEditor(index)}
                  onRemove={() =>
                    setTools((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                />
              ))}
            </div>
          )}
        </Panel>
        <Panel
          title="Skills"
          description="Catalog metadata stays small; instructions and resources load only after activation."
          actions={<Link to="/skills">Manage Skills</Link>}
        >
          {skills.length === 0 ? (
            <EmptyState
              icon="◇"
              title="No Skills available"
              description="Create a versioned Skill before attaching it to this agent."
            />
          ) : (
            <div className="stack">
              {skills.map((skill) => {
                const selectedId = skill.versionIds.find((id) =>
                  skillVersionIds.includes(id),
                );
                const checked = selectedId !== undefined;
                return (
                  <CheckboxRow
                    key={skill.id}
                    label={`${skill.displayName} · ${
                      selectedId === skill.latestVersionId
                        ? `v${skill.version}`
                        : checked
                          ? "older pinned version"
                          : `v${skill.version}`
                    }`}
                    description={skill.description}
                    checked={checked}
                    disabled={!isLatest || skill.status !== "active"}
                    onChange={(event) =>
                      setSkillVersionIds((current) => {
                        const withoutSkill = current.filter(
                          (id) => !skill.versionIds.includes(id),
                        );
                        return event.target.checked
                          ? [...withoutSkill, skill.latestVersionId]
                          : withoutSkill;
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </Panel>
        <Panel
          title="Delegates"
          description="Each coordinator version pins exact child-agent versions. Child sessions keep isolated history while sharing the coordinator workspace."
        >
          {availableAgents.length === 0 ? (
            <EmptyState
              icon="⇢"
              title="No delegate agents available"
              description="Create and publish another agent before adding it to this coordinator's roster."
            />
          ) : (
            <div className="stack">
              <Alert tone="info" role="status">
                A child can be selected only when its latest version has the
                same sandbox enabled state, provider, snapshot, and network
                policy as this coordinator. Tool capabilities may differ.
              </Alert>
              {incompatibleSelectedDelegates.length > 0 ? (
                <Alert
                  tone="warning"
                  title="Selected delegates do not match the draft sandbox"
                  role="alert"
                >
                  <p>
                    Publish compatible child versions first, or remove the
                    incompatible bindings from this new coordinator version.
                  </p>
                  <Button
                    size="sm"
                    onClick={() =>
                      setDelegates((current) =>
                        current.filter(
                          (delegate) =>
                            !incompatibleSelectedDelegates.some(
                              (entry) =>
                                entry.delegate.agentVersionId ===
                                delegate.agentVersionId,
                            ),
                        ),
                      )
                    }
                  >
                    Remove incompatible{" "}
                    {incompatibleSelectedDelegates.length === 1
                      ? "delegate"
                      : "delegates"}
                  </Button>
                </Alert>
              ) : null}
              {availableAgents.map((candidate) => {
                const checked = delegates.some(
                  (delegate) =>
                    delegate.agentVersionId === candidate.latestVersionId,
                );
                const mismatch = delegateSandboxMismatch(
                  config.sandbox,
                  candidate.sandbox,
                );
                return (
                  <CheckboxRow
                    key={candidate.id}
                    label={`${candidate.name} · v${candidate.version}`}
                    description={`${candidate.description} ${
                      mismatch
                        ? `Unavailable — ${mismatch}. Publish a compatible child version first.`
                        : "Sandbox-compatible with this coordinator."
                    } Exact version ${candidate.latestVersionId}.`}
                    checked={checked}
                    disabled={
                      !isLatest ||
                      candidate.status !== "published" ||
                      (!checked && mismatch !== undefined)
                    }
                    onChange={(event) =>
                      setDelegates((current) =>
                        event.target.checked
                          ? [
                              ...current,
                              {
                                key: candidate.key,
                                description:
                                  candidate.description || candidate.name,
                                agentVersionId: candidate.latestVersionId,
                                maxParallel: 1,
                              },
                            ]
                          : current.filter(
                              (delegate) =>
                                delegate.agentVersionId !==
                                candidate.latestVersionId,
                            ),
                      )
                    }
                  />
                );
              })}
            </div>
          )}
        </Panel>
        <Panel
          title="Sandbox policy"
          description="Execution settings are adapter-neutral and versioned."
          actions={
            <Switch
              label="Sandbox enabled"
              checked={sandboxEnabled}
              disabled={!isLatest}
              onChange={setSandboxEnabled}
            />
          }
        >
          <FieldRow>
            <Field
              label="Sandbox provider"
              hint="Connections are project-scoped; keys are encrypted and never copied into an agent version."
            >
              <Select
                value={sandboxProvider}
                onChange={(event) => {
                  setSandboxProvider(event.target.value);
                  setSnapshotId("");
                }}
                disabled={!isLatest}
              >
                {sandboxProviders.map((provider) => (
                  <option key={provider.id} value={provider.key}>
                    {provider.displayName} · Daytona
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Daytona snapshot"
              hint="Snapshot identity is frozen into the new agent version."
            >
              <Select
                value={snapshotId}
                onChange={(event) => setSnapshotId(event.target.value)}
                disabled={
                  !isLatest ||
                  !sandboxEnabled ||
                  !selectedSandboxProvider ||
                  snapshots.isPending ||
                  snapshots.isError
                }
              >
                <option value="" disabled>
                  Select an active Daytona snapshot
                </option>
                {snapshotId &&
                snapshots.data &&
                !snapshots.data.data.some(
                  (snapshot) => snapshot.id === snapshotId,
                ) ? (
                  <option value={snapshotId} disabled>
                    Unavailable snapshot · {snapshotId}
                  </option>
                ) : null}
                {(snapshots.data?.data ?? []).map((snapshot) => (
                  <option
                    key={snapshot.id}
                    value={snapshot.id}
                    disabled={!snapshot.available}
                  >
                    {snapshotLabel(snapshot)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Network policy">
              <Select
                value={network}
                onChange={(event) =>
                  setNetwork(event.target.value as "none" | "restricted")
                }
                disabled={!isLatest || !sandboxEnabled}
              >
                <option value="none">No network</option>
                <option value="restricted">Restricted</option>
              </Select>
            </Field>
            <Field label="Run timeout (ms)">
              <Input
                type="number"
                min={1000}
                max={3600000}
                value={timeout}
                onChange={(event) =>
                  setTimeoutValue(Number(event.target.value))
                }
                disabled={!isLatest}
              />
            </Field>
            <Field label="Maximum turns">
              <Input type="number" value={32} disabled readOnly />
            </Field>
          </FieldRow>
          <div className="stack">
            <p className="muted">
              Model-facing sandbox tools are derived from these immutable
              capabilities. Manage provider credentials and network policy in{" "}
              <Link to="/sandbox-providers">Sandbox providers</Link>.
            </p>
            <div className="field-row">
              {sandboxCapabilityOptions.map(
                ([capability, label, description]) => (
                  <CheckboxRow
                    key={capability}
                    label={label}
                    description={description}
                    checked={sandboxCapabilities.includes(capability)}
                    disabled={!isLatest || !sandboxEnabled}
                    onChange={(event) =>
                      setSandboxCapabilities((current) =>
                        event.target.checked
                          ? [...current, capability]
                          : current.filter((entry) => entry !== capability),
                      )
                    }
                  />
                ),
              )}
            </div>
          </div>
        </Panel>
        <ValidationPanel
          errors={validation}
          readyMessage="Ready to publish a new immutable version."
        />
        {publishError ? <FormError>{publishError.message}</FormError> : null}
        <RecentAgentSessions agentId={agent.id} />
      </div>
      {toolEditor !== null ? (
        <ToolEditorDialog
          tool={toolEditor === "new" ? null : (tools[toolEditor] ?? null)}
          readOnly={!isLatest}
          onClose={() => setToolEditor(null)}
          onSave={(tool) => {
            setTools((current) =>
              toolEditor === "new"
                ? [...current, tool]
                : current.map((item, position) =>
                    position === toolEditor ? tool : item,
                  ),
            );
            setToolEditor(null);
          }}
        />
      ) : null}
      {bulkToolEditor ? (
        <ToolsJsonDialog
          tools={tools}
          onClose={() => setBulkToolEditor(false)}
          onApply={(next) => {
            setTools(next);
            setBulkToolEditor(false);
          }}
        />
      ) : null}
    </Page>
  );
}

/** One tool definition, collapsed to a single row until it is opened. */
function ToolListItem({
  tool,
  editable,
  onEdit,
  onRemove,
}: {
  readonly tool: ToolDefinition;
  readonly editable: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <article className="tool-item">
      <button
        type="button"
        className="tool-item-row"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className="caret" size={13} aria-hidden="true" />
        <Wrench size={14} aria-hidden="true" />
        <code>{tool.name || "unnamed tool"}</code>
        <span className="tool-item-summary">{tool.description}</span>
        <span className="tool-item-meta">
          {tool.owner ? <StatusChip value={tool.owner} /> : null}
          {tool.approval ? <span>approval: {tool.approval}</span> : null}
        </span>
      </button>
      <div id={detailId} hidden={!open} className="tool-item-body">
        {open ? (
          <>
            <p>{tool.description}</p>
            <div className="tool-item-schemas">
              <div>
                <h4>Input schema</h4>
                <JsonBlock
                  value={tool.inputSchema}
                  label={`Input schema for ${tool.name}`}
                />
              </div>
              <div>
                <h4>Output schema</h4>
                <JsonBlock
                  value={tool.outputSchema}
                  label={`Output schema for ${tool.name}`}
                />
              </div>
            </div>
            <div className="tool-item-actions">
              <Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
                {editable ? "Edit definition" : "View definition"}
              </Button>
              {editable ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 size={14} />}
                  onClick={onRemove}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </article>
  );
}

/** Modal editor for a single tool definition. */
function ToolEditorDialog({
  tool,
  readOnly,
  onClose,
  onSave,
}: {
  readonly tool: ToolDefinition | null;
  readonly readOnly: boolean;
  readonly onClose: () => void;
  readonly onSave: (tool: ToolDefinition) => void;
}) {
  const [json, setJson] = useState(() =>
    JSON.stringify(tool ?? TOOL_TEMPLATE, null, 2),
  );
  const parsed = parseToolJson(json);
  return (
    <Dialog
      title={tool ? `Tool · ${tool.name}` : "Add tool"}
      description="One tool definition as JSON. Property descriptions and nested schemas are sent to the model and enforced at execution."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!readOnly && parsed.tool) onSave(parsed.tool);
      }}
      footer={
        <>
          <Button onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
          {readOnly ? null : (
            <Button variant="primary" type="submit" disabled={!parsed.tool}>
              {tool ? "Save tool" : "Add tool"}
            </Button>
          )}
        </>
      }
    >
      <Field
        label="Tool definition (JSON)"
        hint="The API validates the supported schema subset on publish and reports the exact failing path."
      >
        <Textarea
          rows={18}
          className="textarea--code"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          readOnly={readOnly}
          autoFocus
          aria-invalid={Boolean(parsed.error)}
        />
      </Field>
      {parsed.error ? (
        <Alert tone="danger" role="alert">
          <strong>Invalid tool JSON</strong>
          <span>{parsed.error}</span>
        </Alert>
      ) : parsed.tool ? (
        <div className="tool-preview">
          <Wrench size={14} aria-hidden="true" />
          <code>{parsed.tool.name}</code>
          {parsed.tool.owner ? <StatusChip value={parsed.tool.owner} /> : null}
          {parsed.tool.approval ? (
            <span className="mono">approval: {parsed.tool.approval}</span>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** Modal for authoring or pasting the complete tool list as one JSON array. */
function ToolsJsonDialog({
  tools,
  onClose,
  onApply,
}: {
  readonly tools: readonly ToolDefinition[];
  readonly onClose: () => void;
  readonly onApply: (tools: readonly ToolDefinition[]) => void;
}) {
  const [json, setJson] = useState(() => JSON.stringify(tools, null, 2));
  const parsed = parseToolsJson(json);
  return (
    <Dialog
      title="Edit tools as JSON"
      description="The complete tool list for this draft. Applying replaces the draft's tools; nothing changes until you publish a new version."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!parsed.error) onApply(parsed.tools);
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={Boolean(parsed.error)}
          >
            Apply tools
          </Button>
        </>
      }
    >
      <Field
        label="Tool definitions (JSON)"
        hint="The API validates the supported schema subset and reports the exact failing path. Published versions remain immutable."
      >
        <Textarea
          rows={18}
          className="textarea--code"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          autoFocus
          aria-invalid={Boolean(parsed.error)}
        />
      </Field>
      {parsed.error ? (
        <Alert tone="danger" role="alert">
          <strong>Invalid tools JSON</strong>
          <span>{parsed.error}</span>
        </Alert>
      ) : null}
    </Dialog>
  );
}

function RecentAgentSessions({ agentId }: { readonly agentId: string }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ["sessions", "agent", agentId],
    queryFn: () => api.listSessions({}),
  });
  const sessions =
    query.data?.data
      .filter((session) => session.agentId === agentId)
      .slice(0, 4) ?? [];
  return (
    <Panel
      title="Recent sessions"
      description="Runs pinned to immutable agent versions."
      actions={<Link to={`/sessions?agent=${agentId}`}>View all</Link>}
      flush
    >
      {sessions.length === 0 ? (
        <p className="muted" style={{ padding: "var(--sp-5)" }}>
          No sessions yet.
        </p>
      ) : (
        <div className="compact-list">
          {sessions.map((session) => (
            <Link key={session.id} to={`/sessions/${session.id}`}>
              <span className="who">
                <strong>{session.title}</strong>
                <small>{formatDate(session.lastActivityAt)}</small>
              </span>
              <StatusChip value={session.status} />
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

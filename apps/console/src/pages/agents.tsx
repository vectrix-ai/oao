import { ArrowLeft, Bot, Check, Plus, Save, ShieldCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api/context";
import type { AgentVersionConfig } from "../api/types";
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  PageHeader,
  Pagination,
  SearchField,
  StatusPill,
  formatDate,
} from "../components/ui";

const agentStatuses = ["", "published", "draft", "archived"];

function initialAgentConfig(name: string): AgentVersionConfig {
  return {
    systemPrompt: `You are ${name}, a helpful managed agent. Complete the user's request carefully and do not expose secrets or internal reasoning.`,
    modelPreset: "local-default",
    tools: [],
    sandbox: { enabled: false, network: "none" },
    limits: { maxTurns: 32, timeoutMs: 60_000 },
  };
}

export function AgentsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["agents", { search, status, date, page }],
    queryFn: () => api.listAgents({ search, status, date, page }),
  });
  const create = useMutation({
    mutationFn: (input: { name: string; description: string }) =>
      api.createAgent({
        ...input,
        initialConfig: initialAgentConfig(input.name),
      }),
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      setCreating(false);
      navigate(`/agents/${agent.id}`);
    },
  });
  return (
    <div className="page">
      <PageHeader
        eyebrow="Build"
        title="Agents"
        description="Versioned agent definitions, approved models, tools, and sandbox policies."
        actions={
          <button className="button" onClick={() => setCreating(true)}>
            <Plus size={16} />
            Create agent
          </button>
        }
      />
      <section className="filter-bar" aria-label="Agent filters">
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          label="Search agents"
        />
        <label>
          Status
          <select
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
          </select>
        </label>
        <label>
          Created on
          <input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setPage(1);
            }}
          />
        </label>
      </section>
      {query.isPending ? (
        <LoadingState label="Loading agents" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState
          title={
            search || status || date ? "No matching agents" : "No agents yet"
          }
          description={
            search || status || date
              ? "Try clearing one or more filters."
              : "Create an agent to define its instructions, tools, and runtime policy."
          }
          action={
            !search && !status && !date ? (
              <button className="button" onClick={() => setCreating(true)}>
                Create agent
              </button>
            ) : undefined
          }
        />
      ) : (
        <section className="table-card">
          <div className="table-scroll">
            <table>
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
                      <Link className="entity-link" to={`/agents/${agent.id}`}>
                        <span className="entity-icon">
                          <Bot size={16} />
                        </span>
                        <span>
                          <strong>{agent.name}</strong>
                          <small>{agent.key}</small>
                        </span>
                      </Link>
                    </td>
                    <td>{agent.model}</td>
                    <td>
                      <StatusPill value={agent.status} />
                    </td>
                    <td>v{agent.version}</td>
                    <td>{formatDate(agent.createdAt)}</td>
                    <td>{formatDate(agent.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onChange={setPage}
          />
        </section>
      )}
      {creating ? (
        <CreateAgentModal
          pending={create.isPending}
          error={create.error}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
        />
      ) : null}
    </div>
  );
}

function CreateAgentModal({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: { name: string; description: string }) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      name: String(data.get("name") ?? ""),
      description: String(data.get("description") ?? ""),
    });
  };
  return (
    <Modal title="Create agent" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p>Create the definition with a valid immutable first version.</p>
        <Field label="Name">
          <input
            name="name"
            required
            minLength={2}
            autoFocus
            placeholder="e.g. Support operator"
          />
        </Field>
        <Field label="Description">
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            placeholder="What should this agent do?"
          />
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            {error.message}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button" disabled={pending}>
            {pending ? "Creating…" : "Create agent"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AgentDetailPage() {
  const { agentId = "" } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId),
  });
  const context = useQuery({
    queryKey: ["context"],
    queryFn: () => api.getContext(),
  });
  const publish = useMutation({
    mutationFn: (config: AgentVersionConfig) =>
      api.publishAgentVersion(agentId, config),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  if (query.isPending)
    return (
      <div className="page">
        <LoadingState label="Loading agent" />
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <AgentEditor
      key={`${query.data.id}:${query.data.version}`}
      agent={query.data}
      publishing={publish.isPending}
      publishError={publish.error}
      onPublish={(config) => publish.mutate(config)}
      modelPresets={context.data?.activeModelPresets ?? ["local-default"]}
    />
  );
}

function AgentEditor({
  agent,
  publishing,
  publishError,
  onPublish,
  modelPresets,
}: {
  readonly agent: Awaited<ReturnType<ReturnType<typeof useApi>["getAgent"]>>;
  readonly publishing: boolean;
  readonly publishError: Error | null;
  readonly onPublish: (config: AgentVersionConfig) => void;
  readonly modelPresets: readonly string[];
}) {
  const [selectedVersion, setSelectedVersion] = useState(agent.version);
  const selected =
    agent.versions.find((version) => version.version === selectedVersion) ??
    agent.versions[0];
  const baseConfig = selected?.config ?? initialAgentConfig(agent.name);
  const [instructions, setInstructions] = useState(baseConfig.systemPrompt);
  const [modelPreset, setModelPreset] = useState(baseConfig.modelPreset);
  const [sandboxEnabled, setSandboxEnabled] = useState(
    baseConfig.sandbox.enabled,
  );
  const [network, setNetwork] = useState(baseConfig.sandbox.network);
  const [timeout, setTimeoutValue] = useState(baseConfig.limits.timeoutMs);
  const isLatest = !selected || selectedVersion === agent.version;
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (instructions.trim().length < 20)
      errors.push("System instructions must contain at least 20 characters.");
    if (timeout < 1_000 || timeout > 3_600_000)
      errors.push("Run timeout must be between 1,000 and 3,600,000 ms.");
    if (!modelPreset) errors.push("An approved model preset is required.");
    return errors;
  }, [instructions, modelPreset, timeout]);
  const chooseVersion = (version: number) => {
    const next = agent.versions.find((item) => item.version === version);
    if (!next) return;
    setSelectedVersion(version);
    setInstructions(next.config.systemPrompt);
    setModelPreset(next.config.modelPreset);
    setSandboxEnabled(next.config.sandbox.enabled);
    setNetwork(next.config.sandbox.network);
    setTimeoutValue(next.config.limits.timeoutMs);
  };
  const config: AgentVersionConfig = {
    ...baseConfig,
    systemPrompt: instructions,
    modelPreset,
    sandbox: {
      ...baseConfig.sandbox,
      enabled: sandboxEnabled,
      network,
    },
    limits: { maxTurns: 32, timeoutMs: timeout },
  };
  return (
    <div className="page">
      <Link className="back-link" to="/agents">
        <ArrowLeft size={16} />
        Agents
      </Link>
      <PageHeader
        eyebrow={`${agent.key} · v${agent.version}`}
        title={agent.name}
        description={agent.description}
        actions={
          <>
            <StatusPill value={agent.status} />
            <button
              className="button"
              disabled={publishing || validation.length > 0 || !isLatest}
              onClick={() => onPublish(config)}
            >
              <Save size={16} />
              {publishing ? "Publishing…" : "Publish new version"}
            </button>
          </>
        }
      />
      <div className="detail-grid">
        <aside className="version-rail">
          <div className="section-heading">
            <div>
              <h2>Versions</h2>
              <p>Immutable history</p>
            </div>
          </div>
          {agent.versions.length === 0 ? (
            <p className="muted">
              No versions yet. Publish the default draft below.
            </p>
          ) : null}
          {agent.versions.map((version) => (
            <button
              key={version.id}
              className={
                version.version === selectedVersion
                  ? "version-item version-item--active"
                  : "version-item"
              }
              onClick={() => chooseVersion(version.version)}
            >
              <span>
                <strong>Version {version.version}</strong>
                {version.version === agent.version ? <em>Latest</em> : null}
              </span>
              <small>{formatDate(version.createdAt)}</small>
              <code>{version.contentHash}</code>
            </button>
          ))}
        </aside>
        <div className="editor-stack">
          {!isLatest ? (
            <div className="notice">
              <ShieldCheck size={18} />
              <div>
                <strong>Viewing an immutable version</strong>
                <span>Select the latest version to prepare a new publish.</span>
              </div>
            </div>
          ) : null}
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Agent definition</h2>
                <p>Changes become immutable when published.</p>
              </div>
            </div>
            <div className="form-grid">
              <Field
                label="Approved model preset"
                hint="Provider routing remains behind the model adapter."
              >
                <select
                  value={modelPreset}
                  onChange={(event) => setModelPreset(event.target.value)}
                  disabled={!isLatest}
                >
                  {!modelPresets.includes(modelPreset) ? (
                    <option value={modelPreset}>{modelPreset}</option>
                  ) : null}
                  {modelPresets.map((preset) => (
                    <option key={preset} value={preset}>
                      {preset === "local-default"
                        ? "Local deterministic"
                        : preset}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="System instructions"
                hint="Raw reasoning is never included in console events or traces."
              >
                <textarea
                  rows={9}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  disabled={!isLatest}
                />
              </Field>
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Tools</h2>
                <p>Public schemas, execution owner, and approval policy.</p>
              </div>
              <button className="button button--secondary" disabled={!isLatest}>
                <Plus size={15} />
                Add tool
              </button>
            </div>
            <div className="tool-list">
              {baseConfig.tools.length === 0 ? (
                <EmptyState
                  title="No tools configured"
                  description="This version can only use model capabilities."
                />
              ) : (
                baseConfig.tools.map((tool) => (
                  <article className="tool-card" key={tool.name}>
                    <div>
                      <code>{tool.name}</code>
                      <p>{tool.description}</p>
                    </div>
                    <dl>
                      <div>
                        <dt>Owner</dt>
                        <dd>{tool.owner}</dd>
                      </div>
                      <div>
                        <dt>Approval</dt>
                        <dd>{tool.approval}</dd>
                      </div>
                    </dl>
                    <details>
                      <summary>Input schema</summary>
                      <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                    </details>
                    <details>
                      <summary>Output schema</summary>
                      <pre>{JSON.stringify(tool.outputSchema, null, 2)}</pre>
                    </details>
                  </article>
                ))
              )}
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Sandbox policy</h2>
                <p>Execution settings are adapter-neutral and versioned.</p>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={sandboxEnabled}
                  onChange={(event) => setSandboxEnabled(event.target.checked)}
                  disabled={!isLatest}
                />
                <span>Enabled</span>
              </label>
            </div>
            <div className="inline-fields">
              <Field label="Network policy">
                <select
                  value={network}
                  onChange={(event) =>
                    setNetwork(event.target.value as "none" | "restricted")
                  }
                  disabled={!isLatest || !sandboxEnabled}
                >
                  <option value="none">No network</option>
                  <option value="restricted">Restricted</option>
                </select>
              </Field>
              <Field label="Run timeout (ms)">
                <input
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
                <input type="number" value={32} disabled />
              </Field>
            </div>
          </section>
          <section className="validation-panel" aria-live="polite">
            <h2>
              <Check size={17} />
              Validation
            </h2>
            {validation.length === 0 ? (
              <p className="valid">Ready to publish a new immutable version.</p>
            ) : (
              <ul>
                {validation.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            {publishError ? (
              <p className="form-error" role="alert">
                {publishError.message}
              </p>
            ) : null}
          </section>
          <RecentAgentSessions agentId={agent.id} />
        </div>
      </div>
    </div>
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
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Recent sessions</h2>
          <p>Runs pinned to immutable agent versions.</p>
        </div>
        <Link to={`/sessions?agent=${agentId}`}>View all</Link>
      </div>
      {sessions.length === 0 ? (
        <p className="muted">No sessions yet.</p>
      ) : (
        <div className="compact-list">
          {sessions.map((session) => (
            <Link key={session.id} to={`/sessions/${session.id}`}>
              <span>
                <strong>{session.title}</strong>
                <small>{formatDate(session.lastActivityAt)}</small>
              </span>
              <StatusPill value={session.status} />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

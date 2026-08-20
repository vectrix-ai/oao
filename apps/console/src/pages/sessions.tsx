import {
  Activity,
  ArrowLeft,
  Ban,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  GitBranch,
  Play,
  Plus,
  RotateCcw,
  SearchCode,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useApi } from "../api/context";
import type { SessionDetail, TimelineEvent, TimelineKind } from "../api/types";
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
  formatCost,
  formatDate,
  formatNumber,
  shortId,
} from "../components/ui";

const runStatuses = [
  "",
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

export function SessionsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["sessions", { search, status, date, page }],
    queryFn: () => api.listSessions({ search, status, date, page }),
  });
  const agents = useQuery({
    queryKey: ["agents", "session-picker"],
    queryFn: () => api.listAgents({}),
  });
  const create = useMutation({
    mutationFn: (input: {
      agentId: string;
      title: string;
      initialMessage: string;
    }) => api.createSession(input),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setCreating(false);
      navigate(`/sessions/${session.id}`);
    },
  });
  const selectedAgent = searchParams.get("agent");
  const rows = selectedAgent
    ? query.data?.data.filter((session) => session.agentId === selectedAgent)
    : query.data?.data;
  return (
    <div className="page">
      <PageHeader
        eyebrow="Observe"
        title="Sessions"
        description="Durable runs, public status, measured usage, and observed provider cost."
        actions={
          <button className="button" onClick={() => setCreating(true)}>
            <Plus size={16} />
            Create session
          </button>
        }
      />
      <section className="filter-bar" aria-label="Session filters">
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          label="Search ID, title, or agent"
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
            {runStatuses.map((value) => (
              <option key={value} value={value}>
                {value ? value.replaceAll("_", " ") : "All statuses"}
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
        <LoadingState label="Loading sessions" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : rows?.length === 0 ? (
        <EmptyState
          title={
            search || status || date || selectedAgent
              ? "No matching sessions"
              : "No sessions yet"
          }
          description={
            search || status || date || selectedAgent
              ? "Try clearing one or more filters."
              : "Create a session against a published agent version."
          }
          action={
            !search && !status && !date && !selectedAgent ? (
              <button className="button" onClick={() => setCreating(true)}>
                Create session
              </button>
            ) : undefined
          }
        />
      ) : query.data ? (
        <section className="table-card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Status</th>
                  <th>Agent</th>
                  <th className="numeric">Input</th>
                  <th className="numeric">Output</th>
                  <th className="numeric">Observed cost</th>
                  <th>Created</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {rows?.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <Link
                        className="session-link"
                        to={`/sessions/${session.id}`}
                      >
                        <strong>{session.title}</strong>
                        <code>{shortId(session.id)}</code>
                      </Link>
                    </td>
                    <td>
                      <StatusPill value={session.status} />
                    </td>
                    <td>{session.agentName}</td>
                    <td className="numeric">
                      {formatNumber(session.inputTokens)}
                    </td>
                    <td className="numeric">
                      {formatNumber(session.outputTokens)}
                    </td>
                    <td className="numeric">
                      <span title={costLabel(session.costProvenance)}>
                        {formatCost(session.observedCostUsd)}
                        <small className="provenance">
                          {session.costProvenance === "estimated"
                            ? "est."
                            : session.costProvenance === "unavailable"
                              ? "n/a"
                              : "observed"}
                        </small>
                      </span>
                    </td>
                    <td>{formatDate(session.createdAt)}</td>
                    <td>{formatDate(session.lastActivityAt)}</td>
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
      ) : null}
      {creating ? (
        <CreateSessionModal
          agents={agents.data?.data ?? []}
          pending={create.isPending}
          error={create.error}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
        />
      ) : null}
    </div>
  );
}

function costLabel(provenance: string): string {
  return provenance === "provider_observed"
    ? "Reported by the model provider and stored with the run."
    : provenance === "estimated"
      ? "Estimated from the configured price table."
      : "Cost data was not available.";
}

function CreateSessionModal({
  agents,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly agents: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  }[];
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: {
    agentId: string;
    title: string;
    initialMessage: string;
  }) => void;
}) {
  const published = agents.filter((agent) => agent.status === "published");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit({
      agentId: String(data.get("agentId") ?? ""),
      title: String(data.get("title") ?? ""),
      initialMessage: String(data.get("initialMessage") ?? ""),
    });
  };
  return (
    <Modal title="Create session" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p>The session pins the latest published agent version.</p>
        <Field label="Agent">
          <select name="agentId" required autoFocus defaultValue="">
            <option value="" disabled>
              Select an agent
            </option>
            {published.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input
            name="title"
            required
            minLength={2}
            placeholder="What is this session for?"
          />
        </Field>
        <Field label="First message">
          <textarea
            name="initialMessage"
            required
            minLength={1}
            rows={5}
            placeholder="What should the agent do?"
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
          <button
            className="button"
            disabled={pending || published.length === 0}
          >
            {pending ? "Creating…" : "Create session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SessionDetailPage() {
  const { sessionId = "" } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
  });
  const action = useMutation({
    mutationFn: (value: "cancel" | "resume" | "branch-replay") =>
      api.runSessionAction(sessionId, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const submitMessage = useMutation({
    mutationFn: (message: string) => api.submitMessage(sessionId, message),
    onSuccess: async (session) => {
      queryClient.setQueryData(["session", sessionId], session);
      await queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  if (query.isPending)
    return (
      <div className="page">
        <LoadingState label="Loading session" />
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <SessionDetailView
      session={query.data}
      actionPending={action.isPending}
      onAction={(value) => action.mutate(value)}
      messagePending={submitMessage.isPending}
      messageError={submitMessage.error}
      onSubmitMessage={(message) => submitMessage.mutate(message)}
    />
  );
}

function SessionDetailView({
  session,
  actionPending,
  onAction,
  messagePending,
  messageError,
  onSubmitMessage,
}: {
  readonly session: SessionDetail;
  readonly actionPending: boolean;
  readonly onAction: (action: "cancel" | "resume" | "branch-replay") => void;
  readonly messagePending: boolean;
  readonly messageError: Error | null;
  readonly onSubmitMessage: (message: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "debug" ? "debug" : "transcript";
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | TimelineKind>("all");
  const [selectedId, setSelectedId] = useState(
    session.events.find((event) => event.payload)?.id ??
      session.events[0]?.id ??
      "",
  );
  const selected =
    session.events.find((event) => event.id === selectedId) ?? null;
  const events = useMemo(
    () =>
      session.events.filter(
        (event) =>
          (kind === "all" || event.kind === kind) &&
          (!search ||
            `${event.title} ${event.summary}`
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [session.events, kind, search],
  );
  const settled = ["completed", "failed", "cancelled", "timed_out"].includes(
    session.status,
  );
  const submitNextMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = String(new FormData(form).get("message") ?? "").trim();
    if (!message) return;
    onSubmitMessage(message);
    form.reset();
  };
  return (
    <div className="page page--wide">
      <Link className="back-link" to="/sessions">
        <ArrowLeft size={16} />
        Sessions
      </Link>
      <PageHeader
        eyebrow={shortId(session.id)}
        title={session.title}
        description={`${session.agentName} · agent v${session.agentVersion}`}
        actions={
          <>
            <StatusPill value={session.status} />
            {session.capabilities.canCancel ? (
              <button
                className="button button--danger"
                disabled={actionPending}
                onClick={() => onAction("cancel")}
              >
                <Ban size={15} />
                Cancel
              </button>
            ) : null}
            {session.capabilities.canResume ? (
              <button
                className="button button--secondary"
                disabled={actionPending}
                onClick={() => onAction("resume")}
              >
                <Play size={15} />
                Resume
              </button>
            ) : null}
            {session.capabilities.canBranchReplay ? (
              <button
                className="button button--secondary"
                disabled={actionPending}
                onClick={() => onAction("branch-replay")}
              >
                <GitBranch size={15} />
                Branch replay
              </button>
            ) : null}
          </>
        }
      />
      <dl className="metadata-strip">
        <div>
          <dt>Run</dt>
          <dd>
            <code>{shortId(session.runId)}</code>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(session.createdAt)}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{formatDate(session.lastActivityAt)}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{session.attempt}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {formatNumber(session.inputTokens)} in ·{" "}
            {formatNumber(session.outputTokens)} out
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd title={costLabel(session.costProvenance)}>
            {formatCost(session.observedCostUsd)}{" "}
            <small>{session.costProvenance.replaceAll("_", " ")}</small>
          </dd>
        </div>
      </dl>
      {settled ? (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Continue session</h2>
              <p>A new message creates another durable run on this session.</p>
            </div>
          </div>
          <form className="form-stack" onSubmit={submitNextMessage}>
            <Field label="Message">
              <textarea
                name="message"
                rows={4}
                required
                placeholder="Send a follow-up to the same agent and thread"
              />
            </Field>
            {messageError ? (
              <p className="form-error" role="alert">
                {messageError.message}
              </p>
            ) : null}
            <div>
              <button className="button" disabled={messagePending}>
                {messagePending ? "Submitting…" : "Submit next message"}
              </button>
            </div>
          </form>
        </section>
      ) : null}
      <div className="tabs" role="tablist" aria-label="Session views">
        <button
          role="tab"
          aria-selected={tab === "transcript"}
          onClick={() => setParams({ tab: "transcript" })}
        >
          Transcript
        </button>
        <button
          role="tab"
          aria-selected={tab === "debug"}
          onClick={() => setParams({ tab: "debug" })}
        >
          Debug
        </button>
      </div>
      <section className="session-workspace">
        <div className="timeline-pane">
          <div className="timeline-toolbar">
            <SearchField
              value={search}
              onChange={setSearch}
              label="Search events"
            />
            <label>
              <span className="sr-only">Event type</span>
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as "all" | TimelineKind)
                }
              >
                <option value="all">All events</option>
                <option value="user">User</option>
                <option value="assistant">Assistant</option>
                <option value="tool">Tools</option>
                <option value="approval">Approvals</option>
                <option value="error">Errors</option>
                <option value="retry">Retries</option>
                <option value="recovery">Recovery</option>
              </select>
            </label>
          </div>
          {events.length === 0 ? (
            <EmptyState
              title="No matching events"
              description="Adjust the search or event type filter."
            />
          ) : tab === "transcript" ? (
            <Transcript
              events={events}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : (
            <DebugTimeline
              events={events}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
        <Inspector event={selected} />
      </section>
    </div>
  );
}

function EventIcon({ kind }: { readonly kind: TimelineKind }) {
  if (kind === "tool") return <Wrench size={16} />;
  if (kind === "error") return <Ban size={16} />;
  if (kind === "retry" || kind === "recovery") return <RotateCcw size={16} />;
  if (kind === "approval") return <Activity size={16} />;
  if (kind === "assistant") return <TerminalSquare size={16} />;
  return <Clock3 size={16} />;
}

function Transcript({
  events,
  selectedId,
  onSelect,
}: {
  readonly events: readonly TimelineEvent[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ol className="transcript">
      {events.map((event) => (
        <li
          key={event.id}
          className={`message-row message-row--${event.kind}${selectedId === event.id ? " message-row--selected" : ""}`}
        >
          <button
            onClick={() => onSelect(event.id)}
            aria-label={`Inspect ${event.title}`}
          >
            <span className="event-icon">
              <EventIcon kind={event.kind} />
            </span>
            <span className="message-content">
              <span className="message-heading">
                <strong>{event.title}</strong>
                <time>{formatDate(event.createdAt)}</time>
              </span>
              <span>{event.summary}</span>
              {event.tokens || event.durationMs !== null ? (
                <small>
                  {event.durationMs !== null
                    ? `${formatNumber(event.durationMs)} ms`
                    : null}
                  {event.tokens
                    ? ` · ${formatNumber(event.tokens.input)} in / ${formatNumber(event.tokens.output)} out`
                    : null}
                  {event.costUsd ? ` · ${formatCost(event.costUsd)}` : null}
                </small>
              ) : null}
            </span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ol>
  );
}

function DebugTimeline({
  events,
  selectedId,
  onSelect,
}: {
  readonly events: readonly TimelineEvent[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}) {
  const maxDuration = Math.max(
    ...events.map((event) => event.durationMs ?? 0),
    1,
  );
  return (
    <div className="debug-view">
      <div className="debug-legend">
        <span>
          <i className="bar bar--success" />
          Success
        </span>
        <span>
          <i className="bar bar--error" />
          Error
        </span>
        <span>
          <i className="bar bar--pending" />
          Pending
        </span>
      </div>
      <ol className="waterfall">
        {events.map((event) => {
          const width =
            event.durationMs === null
              ? 8
              : Math.max(3, (event.durationMs / maxDuration) * 100);
          return (
            <li key={event.id}>
              <button
                className={selectedId === event.id ? "selected" : ""}
                onClick={() => onSelect(event.id)}
              >
                <span>
                  <EventIcon kind={event.kind} />
                  <strong>{event.title}</strong>
                </span>
                <span className="waterfall-track">
                  <i
                    className={`bar bar--${event.status}`}
                    style={{ width: `${width}%` }}
                  />
                </span>
                <code>
                  {event.durationMs === null
                    ? "waiting"
                    : `${formatNumber(event.durationMs)} ms`}
                </code>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Inspector({ event }: { readonly event: TimelineEvent | null }) {
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const [reveal, setReveal] = useState(false);
  if (!event)
    return (
      <aside className="inspector">
        <EmptyState
          title="Nothing selected"
          description="Select an event to inspect its safe metadata."
        />
      </aside>
    );
  return (
    <aside className="inspector" aria-label="Event inspector">
      <header>
        <div>
          <p className="eyebrow">Event inspector</p>
          <h2>{event.title}</h2>
        </div>
        <StatusPill value={event.status} />
      </header>
      <dl className="inspector-meta">
        <div>
          <dt>Type</dt>
          <dd>{event.kind}</dd>
        </div>
        <div>
          <dt>Timestamp</dt>
          <dd>{formatDate(event.createdAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {event.durationMs === null
              ? "—"
              : `${formatNumber(event.durationMs)} ms`}
          </dd>
        </div>
        {event.tokens ? (
          <>
            <div>
              <dt>Input tokens</dt>
              <dd>{formatNumber(event.tokens.input)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{formatNumber(event.tokens.output)}</dd>
            </div>
          </>
        ) : null}
        {event.costUsd ? (
          <div>
            <dt>Observed cost</dt>
            <dd>{formatCost(event.costUsd)}</dd>
          </div>
        ) : null}
      </dl>
      <section>
        <h3>Summary</h3>
        <p>{event.summary}</p>
      </section>
      {event.payload ? (
        <section>
          <div className="inspector-tabs">
            <h3>Payload</h3>
            <div role="tablist" aria-label="Payload view">
              <button
                role="tab"
                aria-selected={view === "rendered"}
                onClick={() => setView("rendered")}
              >
                Rendered
              </button>
              <button
                role="tab"
                aria-selected={view === "raw"}
                onClick={() => setView("raw")}
              >
                Raw
              </button>
            </div>
          </div>
          {view === "rendered" ? (
            <dl className="payload-list">
              {Object.entries(event.payload.rendered).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll("_", " ")}</dt>
                  <dd>
                    <code>{String(value)}</code>
                  </dd>
                </div>
              ))}
            </dl>
          ) : event.payload.raw ? (
            <pre className="raw-payload">{event.payload.raw}</pre>
          ) : (
            <div className="redacted-panel">
              <SearchCode size={20} />
              <strong>Raw payload redacted</strong>
              <p>
                {reveal
                  ? event.payload.redactionReason
                  : "Raw secrets and sensitive tool payloads are not present in this public read model."}
              </p>
              {event.payload.redactionReason ? (
                <button
                  className="button button--secondary"
                  onClick={() => setReveal(!reveal)}
                >
                  {reveal ? "Hide policy detail" : "Reveal redaction detail"}
                </button>
              ) : null}
            </div>
          )}
        </section>
      ) : (
        <section className="muted-box">
          <CircleDollarSign size={18} />
          <p>
            No tool payload is associated with this event. Internal reasoning is
            never exposed.
          </p>
        </section>
      )}
    </aside>
  );
}

import {
  Ban,
  Bot,
  Bug,
  ChevronRight,
  Clock3,
  Coins,
  Copy,
  Download,
  FileText,
  GitBranch,
  Hash,
  Layers,
  MessagesSquare,
  Play,
  Plus,
  RotateCcw,
  SearchCode,
  Send,
  ShieldQuestion,
  Sparkles,
  TerminalSquare,
  PanelRight,
  Timer,
  User,
  Wrench,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useApi } from "../api/context";
import type { SessionDetail, TimelineEvent, TimelineKind } from "../api/types";
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  FormError,
  IconButton,
  Input,
  LoadingState,
  MarkdownContent,
  Page,
  PageHeader,
  Pagination,
  SearchField,
  Select,
  StatusChip,
  TableCard,
  Tabs,
  Textarea,
  formatCompactDuration,
  formatCompactNumber,
  formatCost,
  formatDate,
  formatDuration,
  formatNumber,
  formatTime,
  formatTimestamp,
  humanize,
  shortId,
  useToast,
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

const settledStates = ["completed", "failed", "cancelled", "timed_out"];

function costLabel(provenance: string): string {
  return provenance === "provider_observed"
    ? "Reported by the model provider and stored with the run."
    : provenance === "estimated"
      ? "Estimated from the configured price table."
      : "Cost data was not available.";
}

function costSuffix(provenance: string): string {
  return provenance === "estimated"
    ? "est."
    : provenance === "unavailable"
      ? "n/a"
      : "observed";
}

export function SessionsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notify = useToast();
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
      notify("Session created.");
      navigate(`/sessions/${session.id}`);
    },
  });
  const selectedAgent = searchParams.get("agent");
  const rows = selectedAgent
    ? query.data?.data.filter((session) => session.agentId === selectedAgent)
    : query.data?.data;
  const filtered = Boolean(search || status || date || selectedAgent);

  return (
    <Page>
      <PageHeader
        eyebrow="Observe"
        title="Sessions"
        description="Durable runs, public status, measured usage, and observed provider cost."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => setCreating(true)}
          >
            Create session
          </Button>
        }
      />
      <FilterBar label="Session filters">
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          label="Search ID, title, or agent"
        />
        <Field label="Status">
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            {runStatuses.map((value) => (
              <option key={value} value={value}>
                {value ? humanize(value) : "All statuses"}
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
        {search || status || date ? (
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
        <LoadingState label="Loading sessions" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : rows?.length === 0 ? (
        <EmptyState
          title={filtered ? "No matching sessions" : "No sessions yet"}
          description={
            filtered
              ? "Try clearing one or more filters."
              : "A session is a durable thread of runs against one published agent version."
          }
          action={
            filtered ? undefined : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCreating(true)}
              >
                Create session
              </Button>
            )
          }
        />
      ) : query.data ? (
        <TableCard
          label="Sessions table"
          caption="Sessions in this project"
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
                  <Link to={`/sessions/${session.id}`}>
                    <span className="entity-text">
                      <strong>{session.title}</strong>
                      <small>{shortId(session.id)}</small>
                    </span>
                  </Link>
                </td>
                <td>
                  <StatusChip value={session.status} />
                </td>
                <td>{session.agentName}</td>
                <td className="numeric">{formatNumber(session.inputTokens)}</td>
                <td className="numeric">
                  {formatNumber(session.outputTokens)}
                </td>
                <td
                  className="numeric"
                  title={costLabel(session.costProvenance)}
                >
                  {formatCost(session.observedCostUsd)}{" "}
                  <small className="cell-sub">
                    {costSuffix(session.costProvenance)}
                  </small>
                </td>
                <td>{formatDate(session.createdAt)}</td>
                <td>{formatDate(session.lastActivityAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableCard>
      ) : null}
      {creating ? (
        <CreateSessionDialog
          agents={agents.data?.data ?? []}
          pending={create.isPending}
          error={create.error}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
        />
      ) : null}
    </Page>
  );
}

function CreateSessionDialog({
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
  return (
    <Dialog
      title="Create session"
      description="The session pins the latest published version of the agent you pick."
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({
          agentId: String(data.get("agentId") ?? ""),
          title: String(data.get("title") ?? ""),
          initialMessage: String(data.get("initialMessage") ?? ""),
        });
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            loading={pending}
            disabled={published.length === 0}
          >
            {pending ? "Creating…" : "Create session"}
          </Button>
        </>
      }
    >
      <Field label="Agent">
        <Select name="agentId" required autoFocus defaultValue="">
          <option value="" disabled>
            Select an agent
          </option>
          {published.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Title">
        <Input
          name="title"
          required
          minLength={2}
          placeholder="What is this session for?"
        />
      </Field>
      <Field label="First message">
        <Textarea
          name="initialMessage"
          required
          minLength={1}
          rows={5}
          placeholder="What should the agent do?"
        />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

export function SessionDetailPage() {
  const { sessionId = "" } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
  });
  const action = useMutation({
    mutationFn: (value: "cancel" | "resume" | "branch-replay") =>
      api.runSessionAction(sessionId, value),
    onSuccess: async (_session, value) => {
      await queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      notify(
        value === "cancel"
          ? "Run cancelled."
          : value === "resume"
            ? "Run resumed."
            : "Replay branched.",
      );
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
      <Page wide>
        <LoadingState label="Loading session" rows={7} />
      </Page>
    );
  if (query.isError)
    return (
      <Page wide>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </Page>
    );
  return (
    <SessionDetailView
      session={query.data}
      actionPending={action.isPending}
      actionError={action.error}
      onAction={(value) => action.mutate(value)}
      messagePending={submitMessage.isPending}
      messageError={submitMessage.error}
      onSubmitMessage={(message) => submitMessage.mutate(message)}
    />
  );
}

/**
 * Session detail.
 *
 * The transcript is conversation-first: durable user and assistant messages
 * read as messages, the work behind them collapses into one-line activity rows
 * that expand in place, and platform telemetry clusters so it can never bury
 * the exchange. The debug tab keeps the flat waterfall plus side inspector for
 * when the ordering and the raw metadata are the point.
 */
function SessionDetailView({
  session,
  actionPending,
  actionError,
  onAction,
  messagePending,
  messageError,
  onSubmitMessage,
}: {
  readonly session: SessionDetail;
  readonly actionPending: boolean;
  readonly actionError: Error | null;
  readonly onAction: (action: "cancel" | "resume" | "branch-replay") => void;
  readonly messagePending: boolean;
  readonly messageError: Error | null;
  readonly onSubmitMessage: (message: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "debug" ? "debug" : "transcript";
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | TimelineKind>("all");
  const [confirmCancel, setConfirmCancel] = useState(false);
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
  const transcript = useMemo(
    () => events.filter((event) => blockType(event) !== "runtime"),
    [events],
  );
  const [flashId, setFlashId] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(true);
  const flashTimer = useRef<number>(0);
  const jumpTo = (id: string) => {
    setSelectedId(id);
    setFlashId(id);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(""), 1600);
    // Instant, not smooth: some engines silently drop smooth scrolls started
    // inside click handlers, and the flash ring already marks the landing.
    document.getElementById(`event-${id}`)?.scrollIntoView({ block: "center" });
  };
  const settled = settledStates.includes(session.status);

  return (
    <Page wide fill>
      <PageHeader
        breadcrumbs={[
          { label: "Sessions", to: "/sessions" },
          { label: session.title },
        ]}
        eyebrow={shortId(session.id)}
        title={session.title}
        actions={
          <>
            <StatusChip value={session.status} />
            {session.capabilities.canResume ? (
              <Button
                icon={<Play size={14} />}
                disabled={actionPending}
                onClick={() => onAction("resume")}
              >
                Resume
              </Button>
            ) : null}
            {session.capabilities.canBranchReplay ? (
              <Button
                icon={<GitBranch size={14} />}
                disabled={actionPending}
                onClick={() => onAction("branch-replay")}
              >
                Branch replay
              </Button>
            ) : null}
            {session.capabilities.canCancel ? (
              <Button
                variant="danger"
                icon={<Ban size={14} />}
                disabled={actionPending}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel run
              </Button>
            ) : null}
          </>
        }
      />
      <SessionFacts session={session} />
      {actionError ? <FormError>{actionError.message}</FormError> : null}
      <div className="session-controls">
        <Tabs
          label="Session views"
          variant="segmented"
          value={tab}
          onChange={(value) => setParams({ tab: value })}
          tabs={[
            {
              value: "transcript",
              label: "Transcript",
              icon: <MessagesSquare size={14} />,
            },
            { value: "debug", label: "Debug", icon: <Bug size={14} /> },
          ]}
        />
        <div className="session-filters">
          <SearchField
            value={search}
            onChange={setSearch}
            label="Filter events"
          />
          {tab === "debug" ? (
            <Field label="Event type" className="field--inline">
              <Select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as "all" | TimelineKind)
                }
              >
                <option value="all">All events</option>
                <option value="user">User</option>
                <option value="assistant">Assistant</option>
                <option value="reasoning">Reasoning</option>
                <option value="tool">Tools</option>
                <option value="approval">Approvals</option>
                <option value="error">Errors</option>
                <option value="retry">Retries</option>
                <option value="recovery">Recovery</option>
              </Select>
            </Field>
          ) : null}
          <ThreadActions session={session} />
          {tab === "transcript" && !showPanel ? (
            <IconButton
              label="Show session details"
              onClick={() => setShowPanel(true)}
            >
              <PanelRight size={15} aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      </div>
      {session.events.length > 0 ? (
        <SessionMinimap
          events={session.events}
          highlightId={hoverId}
          onJump={jumpTo}
        />
      ) : null}
      {tab === "transcript" ? (
        transcript.length === 0 ? (
          <EmptyState
            title={search ? "No matching messages" : "No conversation yet"}
            description={
              search
                ? "Clear the filter, or switch to Debug for the full event stream."
                : "Nothing has been said on this thread yet. Runtime events live in the Debug tab."
            }
          />
        ) : (
          <div
            className={`session-body${showPanel ? " session-body--with-panel" : ""}`}
          >
            <div className="conversation-scroll">
              <section className="conversation-pane" aria-label="Conversation">
                <Transcript
                  events={transcript}
                  agentName={session.agentName}
                  flashId={flashId}
                  onHoverEvent={setHoverId}
                />
                <Composer
                  settled={settled}
                  status={session.status}
                  pending={messagePending}
                  error={messageError}
                  onSubmit={onSubmitMessage}
                />
              </section>
            </div>
            {showPanel ? (
              <SessionSidebar
                session={session}
                onClose={() => setShowPanel(false)}
              />
            ) : null}
          </div>
        )
      ) : events.length === 0 ? (
        <EmptyState
          title="No matching events"
          description="Adjust the filter or the event type."
        />
      ) : (
        <section className="session-workspace">
          <div className="timeline-pane">
            <DebugTimeline
              events={events}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
          <Inspector event={selected} />
        </section>
      )}
      {confirmCancel ? (
        <ConfirmDialog
          title={`Cancel the run on “${session.title}”?`}
          description="The current run stops at its next safe checkpoint. The transcript stays readable and you can start a new run afterwards."
          confirmLabel="Cancel run"
          cancelLabel="Keep running"
          pending={actionPending}
          onClose={() => setConfirmCancel(false)}
          onConfirm={() => {
            onAction("cancel");
            setConfirmCancel(false);
          }}
        />
      ) : null}
    </Page>
  );
}

/** One dense strip of session facts, so the transcript starts near the top. */
function SessionFacts({ session }: { readonly session: SessionDetail }) {
  const elapsed = session.completedAt
    ? Date.parse(session.completedAt) - Date.parse(session.startedAt)
    : null;
  return (
    <div className="session-facts">
      <span className="fact">
        <Bot size={13} aria-hidden="true" />
        {session.agentName}
        <span className="fact-sub">v{session.agentVersion}</span>
      </span>
      <span className="fact" title="Latest run on this thread">
        <Hash size={13} aria-hidden="true" />
        <span className="mono">{shortId(session.runId)}</span>
        {session.attempt > 1 ? (
          <span className="fact-sub">attempt {session.attempt}</span>
        ) : null}
      </span>
      {elapsed !== null && elapsed >= 0 ? (
        <span className="fact" title="Elapsed time of the latest run">
          <Timer size={13} aria-hidden="true" />
          {formatCompactDuration(elapsed)}
        </span>
      ) : null}
      <span className="fact" title="Input / output tokens">
        <Layers size={13} aria-hidden="true" />
        <span className="mono">
          {formatCompactNumber(session.inputTokens)}/
          {formatCompactNumber(session.outputTokens)}
        </span>
      </span>
      <span className="fact" title={costLabel(session.costProvenance)}>
        <Coins size={13} aria-hidden="true" />
        <span className="mono">{formatCost(session.observedCostUsd)}</span>
        <span className="fact-sub">{costSuffix(session.costProvenance)}</span>
      </span>
      <span className="fact" title="Last activity">
        <Clock3 size={13} aria-hidden="true" />
        {formatDate(session.lastActivityAt)}
      </span>
    </div>
  );
}

interface CostPoint {
  readonly at: number;
  readonly total: number;
}

/** Cumulative observed cost over the session, one point per costed event. */
function costSeries(session: SessionDetail): readonly CostPoint[] {
  const costed = session.events
    .map((event) => ({
      at: Date.parse(event.createdAt),
      cost: event.costUsd ?? 0,
    }))
    .filter((point) => Number.isFinite(point.at) && point.cost > 0)
    .sort((a, b) => a.at - b.at);
  let runningTotal = 0;
  return costed.map((point) => ({
    at: point.at,
    total: (runningTotal += point.cost),
  }));
}

/** Smallest 1/2/5 × 10^k at or above the value, for a clean axis ceiling. */
function niceCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10])
    if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}

function clockLabel(at: number): string {
  return new Intl.DateTimeFormat("en-BE", { timeStyle: "short" }).format(
    new Date(at),
  );
}

/**
 * Cumulative cost as a step chart: a single accent series over an area wash,
 * with a crosshair tooltip on hover. Steps, not slopes — cost arrives in
 * discrete provider invoices, and a slope would invent spending between them.
 */
function CostChart({
  points,
  start,
  end,
}: {
  readonly points: readonly CostPoint[];
  readonly start: number;
  readonly end: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 132;
  const PAD = { top: 10, right: 10, bottom: 18, left: 40 };
  const span = Math.max(end - start, 1);
  const maxCost = niceCeiling(points.at(-1)?.total ?? 1);
  const x = (at: number) =>
    PAD.left + ((at - start) / span) * (W - PAD.left - PAD.right);
  const y = (cost: number) =>
    H - PAD.bottom - (cost / maxCost) * (H - PAD.top - PAD.bottom);
  // Step-after: hold each total until the next invoice, then jump.
  let path = `M ${x(start)} ${y(0)}`;
  let previous = 0;
  for (const point of points) {
    path += ` H ${x(point.at)} V ${y(point.total)}`;
    previous = point.total;
  }
  path += ` H ${x(end)}`;
  const area = `${path} V ${y(0)} Z`;
  const last = points.at(-1);
  const hovered = hover === null ? null : points[hover];
  const ticks = [0, maxCost / 2, maxCost];
  // Enough decimals that half-scale ticks stay distinct at micro-cost scales.
  const tickDecimals = Math.max(2, 1 - Math.floor(Math.log10(maxCost)));
  const pick = (clientX: number, rect: DOMRect) => {
    const at = start + ((clientX - rect.left) / rect.width) * span;
    let best = 0;
    points.forEach((point, index) => {
      if (Math.abs(point.at - at) < Math.abs(points[best]!.at - at))
        best = index;
    });
    return best;
  };
  return (
    <svg
      className="cost-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Cumulative cost over the session, ending at ${formatCost(previous)}`}
      onMouseMove={(event) =>
        points.length > 0
          ? setHover(
              pick(event.clientX, event.currentTarget.getBoundingClientRect()),
            )
          : null
      }
      onMouseLeave={() => setHover(null)}
    >
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(tick)}
            y2={y(tick)}
            className="chart-grid"
          />
          <text
            x={PAD.left - 5}
            y={y(tick) + 3}
            className="chart-tick chart-tick--y"
          >
            ${tick.toFixed(tickDecimals)}
          </text>
        </g>
      ))}
      <text x={PAD.left} y={H - 5} className="chart-tick">
        {clockLabel(start)}
      </text>
      <text x={W - PAD.right} y={H - 5} className="chart-tick chart-tick--end">
        {clockLabel(end)}
      </text>
      <path d={area} className="chart-area" />
      <path d={path} className="chart-line" />
      {last ? (
        <circle
          cx={x(last.at)}
          cy={y(last.total)}
          r={4}
          className="chart-dot"
        />
      ) : null}
      {hovered ? (
        <g>
          <line
            x1={x(hovered.at)}
            x2={x(hovered.at)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            className="chart-crosshair"
          />
          <text
            x={x(hovered.at) > W / 2 ? x(hovered.at) - 6 : x(hovered.at) + 6}
            y={PAD.top + 8}
            className={`chart-tip${x(hovered.at) > W / 2 ? " chart-tip--left" : ""}`}
          >
            {clockLabel(hovered.at)} · {formatCost(hovered.total)}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

/**
 * Right-hand session panel, in the spirit of hosted agent consoles: identity,
 * cumulative cost, and usage beside the conversation rather than above it.
 */
function SessionSidebar({
  session,
  onClose,
}: {
  readonly session: SessionDetail;
  readonly onClose: () => void;
}) {
  const points = costSeries(session);
  const start = Date.parse(session.startedAt ?? session.createdAt);
  const end = Math.max(
    Date.parse(session.lastActivityAt ?? session.createdAt),
    start + 1,
  );
  return (
    <aside className="session-panel" aria-label="Session details">
      <header className="panel-head">
        <h2>Session</h2>
        <IconButton label="Close session details" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </header>
      <dl className="panel-facts">
        <div>
          <dt>ID</dt>
          <dd className="mono">{session.id}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusChip value={session.status} />
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(session.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(session.lastActivityAt)}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>
            <Link to={`/agents/${session.agentId}`}>{session.agentName}</Link>
          </dd>
        </div>
        {session.model ? (
          <div>
            <dt>Model</dt>
            <dd className="mono">{session.model}</dd>
          </div>
        ) : null}
      </dl>
      {session.workspaceFiles.length > 0 ? (
        <section>
          <header className="panel-row">
            <h3>Files</h3>
            <span className="panel-sub">
              {session.workspaceFiles.length} in workspace
            </span>
          </header>
          <ul className="workspace-file-list">
            {session.workspaceFiles.map((file) => (
              <li key={file.path}>
                <FileText size={15} aria-hidden="true" />
                <span className="workspace-file-name">
                  <strong>{file.name}</strong>
                  <span className="mono" title={file.path}>
                    {file.path}
                  </span>
                </span>
                <span
                  className={`workspace-file-state${file.backedUp ? " workspace-file-state--backed-up" : ""}`}
                  title={
                    file.backedUpAt
                      ? `Backed up ${formatDate(file.backedUpAt)}`
                      : "Not present in a recorded workspace backup"
                  }
                >
                  {file.backedUp ? "Backed up" : "Sandbox only"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <header className="panel-row">
          <h3>Cost</h3>
          <span
            className="panel-total"
            title={costLabel(session.costProvenance)}
          >
            {formatCost(session.observedCostUsd)}
          </span>
        </header>
        {points.length > 0 ? (
          <CostChart points={points} start={start} end={end} />
        ) : (
          <p className="panel-note">
            No per-event cost was observed for this session yet.
          </p>
        )}
      </section>
      <section>
        <header className="panel-row">
          <h3>Usage</h3>
          <span className="panel-sub">Session total</span>
        </header>
        <dl className="usage-rows">
          <div>
            <dt>Input tokens</dt>
            <dd className="mono">{formatNumber(session.inputTokens)}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd className="mono">{formatNumber(session.outputTokens)}</dd>
          </div>
          <div>
            <dt>Cost provenance</dt>
            <dd>{humanize(session.costProvenance)}</dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}

/**
 * Renders the whole thread as Markdown.
 *
 * Exports the conversation the transcript shows — messages and the work behind
 * them — and not the platform telemetry, so a pasted thread reads the way the
 * screen does. It ignores the filter on purpose: this is the whole thread.
 */
function threadMarkdown(session: SessionDetail): string {
  const lines = [
    `# ${session.title}`,
    "",
    `- Session: \`${session.id}\``,
    `- Agent: ${session.agentName} (v${session.agentVersion})`,
    `- Status: ${humanize(session.status)}`,
    `- Created: ${formatDate(session.createdAt)}`,
    `- Last activity: ${formatDate(session.lastActivityAt)}`,
    `- Usage: ${formatNumber(session.inputTokens)} in / ${formatNumber(session.outputTokens)} out`,
    `- Cost: ${formatCost(session.observedCostUsd)} (${humanize(session.costProvenance)})`,
    "",
  ];
  for (const event of session.events) {
    const type = blockType(event);
    if (type === "runtime") continue;
    if (type === "message") {
      const who = event.kind === "user" ? "You" : session.agentName;
      lines.push(
        `## ${who} — ${formatTimestamp(event.createdAt)}`,
        "",
        event.summary,
        "",
      );
      continue;
    }
    const duration =
      event.durationMs === null
        ? ""
        : ` (${formatCompactDuration(event.durationMs)})`;
    const failed = event.status === "error" ? " — FAILED" : "";
    lines.push(
      `> **${event.title}**${duration}${failed}`,
      `> ${event.summary}`,
    );
    for (const [key, value] of Object.entries(event.payload?.rendered ?? {}))
      lines.push(`> - ${payloadLabel(key)}: ${payloadValue(value)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Copy or download the whole thread as Markdown. */
function ThreadActions({ session }: { readonly session: SessionDetail }) {
  const notify = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(threadMarkdown(session));
      notify("Thread copied as Markdown.");
    } catch {
      // Clipboard access is refused on insecure origins and by some policies.
      notify("Could not reach the clipboard. Use Download instead.");
    }
  };
  const download = () => {
    const blob = new Blob([threadMarkdown(session)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `session-${session.id}.md`;
    link.click();
    URL.revokeObjectURL(url);
    notify("Thread downloaded.");
  };
  return (
    <div className="thread-actions">
      <IconButton label="Copy thread as Markdown" onClick={() => void copy()}>
        <Copy size={15} aria-hidden="true" />
      </IconButton>
      <IconButton label="Download thread as Markdown" onClick={download}>
        <Download size={15} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

type MinimapActor =
  "user" | "agent" | "reasoning" | "tool" | "error" | "approval" | "retry";

interface MinimapSegment {
  readonly kind: "event" | "idle";
  readonly key: string;
  readonly id?: string;
  readonly actor?: MinimapActor;
  readonly chip: string;
  readonly snippet: string;
  readonly durationMs: number;
  readonly offsetMs: number;
  readonly weight: number;
}

const IDLE_MIN_MS = 3000;

function minimapActor(event: TimelineEvent): {
  readonly actor: MinimapActor;
  readonly chip: string;
} {
  if (event.status === "error" || event.kind === "error")
    return { actor: "error", chip: "Error" };
  if (event.kind === "user") return { actor: "user", chip: "User" };
  if (event.kind === "reasoning")
    return { actor: "reasoning", chip: "Reasoning" };
  if (event.kind === "assistant") return { actor: "agent", chip: "Agent" };
  if (event.kind === "approval") return { actor: "approval", chip: "Approval" };
  if (event.kind === "retry" || event.kind === "recovery")
    return { actor: "retry", chip: "Retry" };
  return { actor: "tool", chip: "Tool" };
}

/** Elapsed offset from session start, `0:00:36` style. */
function offsetLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function snippetOf(event: TimelineEvent): string {
  const text =
    event.kind === "user" || event.kind === "assistant"
      ? event.summary
      : event.title;
  return text.length > 44 ? `${text.slice(0, 42)}…` : text;
}

/**
 * Lays the thread out as a contiguous strip of states: user messages, agent
 * work, and tool runs, with waiting time as striped idle segments. Every
 * moment of the session belongs to a block — the bar has no dead track.
 *
 * An agent reply with no recorded duration is credited the whole gap since the
 * previous event: that gap IS how long the agent took to answer. Square-root
 * weights keep one long wait from crushing the working blocks into slivers.
 */
function minimapSegments(
  events: readonly TimelineEvent[],
): readonly MinimapSegment[] {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);
  const visible = events.filter((event) => blockType(event) !== "runtime");
  const segments: MinimapSegment[] = [];
  let sessionStart: number | null = null;
  let previousEnd: number | null = null;
  for (const event of visible) {
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at)) continue;
    sessionStart ??= at;
    previousEnd ??= at;
    const gap = Math.max(0, at - previousEnd);
    const isAgentReply =
      blockType(event) === "message" && event.kind === "assistant";
    if (!isAgentReply && gap > IDLE_MIN_MS) {
      segments.push({
        kind: "idle",
        key: `idle-${event.id}`,
        chip: "Idle",
        snippet: "Waiting",
        durationMs: gap,
        offsetMs: previousEnd - sessionStart,
        weight: clamp(Math.sqrt(gap), 30, 90),
      });
      previousEnd = at;
    }
    const own = event.durationMs ?? 0;
    const duration = isAgentReply ? Math.max(own, gap) : own;
    const segmentStart = isAgentReply ? at - Math.max(gap - own, 0) : at;
    segments.push({
      kind: "event",
      key: event.id,
      id: event.id,
      ...minimapActor(event),
      snippet: snippetOf(event),
      durationMs: duration,
      offsetMs: segmentStart - sessionStart,
      weight: clamp(Math.sqrt(Math.max(duration, 500)), 26, 140),
    });
    previousEnd = Math.max(previousEnd, at + own, at);
  }
  return segments;
}

/**
 * Clickable overview of the thread. Hovering a block names the state and how
 * long it lasted; clicking an event block jumps the transcript to it.
 */
function SessionMinimap({
  events,
  highlightId,
  onJump,
}: {
  readonly events: readonly TimelineEvent[];
  readonly highlightId?: string | null;
  readonly onJump: (id: string) => void;
}) {
  const segments = useMemo(() => minimapSegments(events), [events]);
  const totalDurationMs = useMemo(
    () =>
      segments.reduce(
        (total, segment) =>
          Math.max(total, segment.offsetMs + segment.durationMs),
        0,
      ),
    [segments],
  );
  const elapsedTicks = useMemo(() => {
    const ratios = totalDurationMs > 0 ? [0, 0.25, 0.5, 0.75, 1] : [0];
    return ratios.map((ratio) => ({
      ratio,
      label: `${Math.round((totalDurationMs * ratio) / 100) / 10}s`,
    }));
  }, [totalDurationMs]);
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{
    readonly segment: MinimapSegment;
    readonly left: number;
  } | null>(null);
  const showTip = (segment: MinimapSegment, target: HTMLElement) => {
    const width = wrap.current?.clientWidth ?? 0;
    const center = target.offsetLeft + target.offsetWidth / 2;
    setTip({ segment, left: clampTip(center, width) });
  };
  const tipMeta = (segment: MinimapSegment) =>
    [
      segment.durationMs >= 100
        ? formatCompactDuration(segment.durationMs)
        : null,
      offsetLabel(segment.offsetMs),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <div className="minimap-wrap" ref={wrap} onMouseLeave={() => setTip(null)}>
      {tip ? (
        <div
          className="minimap-tip"
          style={{ left: `${tip.left}px` }}
          aria-hidden="true"
        >
          <span
            className={`minimap-chip minimap-chip--${tip.segment.actor ?? "idle"}`}
          >
            {tip.segment.chip}
          </span>
          <span className="minimap-tip-text">{tip.segment.snippet}</span>
          <span className="minimap-tip-meta">{tipMeta(tip.segment)}</span>
        </div>
      ) : null}
      <div
        className="minimap-axis"
        role="group"
        aria-label={`Elapsed timeline from 0 seconds to ${Math.round(totalDurationMs / 100) / 10} seconds`}
      >
        {elapsedTicks.map((tick, index) => (
          <span
            key={tick.ratio}
            className={`minimap-axis-tick${index === 0 ? " minimap-axis-tick--start" : index === elapsedTicks.length - 1 ? " minimap-axis-tick--end" : ""}`}
            style={{ left: `${tick.ratio * 100}%` }}
          >
            <span className="minimap-axis-label">{tick.label}</span>
          </span>
        ))}
      </div>
      <div
        className="session-minimap"
        role="group"
        aria-label="Session timeline"
      >
        {segments.map((segment) =>
          segment.kind === "idle" ? (
            <span
              key={segment.key}
              role="img"
              className="minimap-seg minimap-seg--idle"
              style={{ flexGrow: segment.weight }}
              aria-label={`Idle for ${formatCompactDuration(segment.durationMs)}`}
              onMouseEnter={(event) => showTip(segment, event.currentTarget)}
            />
          ) : (
            <button
              key={segment.key}
              type="button"
              className={`minimap-seg minimap-seg--${segment.actor}${segment.id === highlightId ? " minimap-seg--hot" : ""}`}
              style={{ flexGrow: segment.weight }}
              aria-label={`Jump to ${segment.chip}: ${segment.snippet}`}
              onMouseEnter={(event) => showTip(segment, event.currentTarget)}
              onFocus={(event) => showTip(segment, event.currentTarget)}
              onBlur={() => setTip(null)}
              onClick={() => onJump(segment.id!)}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** Keeps the floating tooltip's center inside the strip. */
function clampTip(center: number, width: number): number {
  const margin = 110;
  if (width <= margin * 2) return width / 2;
  return Math.min(Math.max(center, margin), width - margin);
}

function EventIcon({ kind }: { readonly kind: TimelineKind }) {
  if (kind === "tool") return <Wrench size={13} />;
  if (kind === "reasoning") return <Sparkles size={13} />;
  if (kind === "error") return <Ban size={13} />;
  if (kind === "retry" || kind === "recovery") return <RotateCcw size={13} />;
  if (kind === "approval") return <ShieldQuestion size={13} />;
  if (kind === "assistant") return <TerminalSquare size={13} />;
  if (kind === "user") return <User size={13} />;
  return <Clock3 size={13} />;
}

const MESSAGE_KINDS = new Set<TimelineKind>(["user", "assistant"]);

type BlockType = "message" | "activity" | "runtime";

/**
 * Where an event belongs in the transcript.
 *
 * Fixtures and older read models omit `source`, so plain conversation kinds
 * still read as messages. A failed runtime event is promoted to activity: a
 * failure must never be filtered out of the story of the turn.
 */
function blockType(event: TimelineEvent): BlockType {
  const source =
    event.source ?? (MESSAGE_KINDS.has(event.kind) ? "message" : "activity");
  if (source === "message")
    return MESSAGE_KINDS.has(event.kind) ? "message" : "activity";
  if (source === "runtime" && event.status === "error") return "activity";
  return source;
}

interface TranscriptBlock {
  readonly key: string;
  readonly type: BlockType;
  readonly event: TimelineEvent;
}

interface Turn {
  readonly key: string;
  readonly prompt: TimelineEvent | null;
  readonly blocks: readonly TranscriptBlock[];
}

/** Splits the flat event stream into one turn per durable user message. */
function buildTurns(events: readonly TimelineEvent[]): readonly Turn[] {
  const turns: {
    key: string;
    prompt: TimelineEvent | null;
    events: TimelineEvent[];
  }[] = [];
  for (const event of events) {
    if (blockType(event) === "message" && event.kind === "user") {
      turns.push({ key: event.id, prompt: event, events: [] });
      continue;
    }
    const current = turns.at(-1);
    if (current) current.events.push(event);
    else turns.push({ key: `turn:${event.id}`, prompt: null, events: [event] });
  }
  return turns.map((turn) => ({
    key: turn.key,
    prompt: turn.prompt,
    blocks: groupBlocks(turn.events),
  }));
}

/** Telemetry is dropped before the transcript, so a turn is a flat block list. */
function groupBlocks(events: readonly TimelineEvent[]): TranscriptBlock[] {
  return events
    .filter((event) => blockType(event) !== "runtime")
    .map((event) => ({ key: event.id, type: blockType(event), event }));
}

function Transcript({
  events,
  agentName,
  flashId,
  onHoverEvent,
}: {
  readonly events: readonly TimelineEvent[];
  readonly agentName: string;
  readonly flashId: string;
  readonly onHoverEvent: (id: string | null) => void;
}) {
  const turns = useMemo(() => buildTurns(events), [events]);
  return (
    <ol
      className="conversation"
      onMouseOver={(event) => {
        const block = (event.target as HTMLElement).closest('[id^="event-"]');
        onHoverEvent(block ? block.id.slice("event-".length) : null);
      }}
      onMouseLeave={() => onHoverEvent(null)}
    >
      {turns.map((turn) => (
        <li key={turn.key} className="turn">
          {turn.prompt ? (
            <UserMessage
              event={turn.prompt}
              flashed={turn.prompt.id === flashId}
            />
          ) : null}
          {turn.blocks.length > 0 ? (
            <div className="turn-response">
              {turn.blocks.map((block) =>
                block.type === "message" ? (
                  <AssistantMessage
                    key={block.key}
                    event={block.event}
                    agentName={agentName}
                    flashed={block.event.id === flashId}
                  />
                ) : (
                  <ActivityRow
                    key={block.key}
                    event={block.event}
                    flashed={block.event.id === flashId}
                  />
                ),
              )}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function UserMessage({
  event,
  flashed,
}: {
  readonly event: TimelineEvent;
  readonly flashed: boolean;
}) {
  return (
    <article
      id={`event-${event.id}`}
      className={`msg msg--user${flashed ? " is-flashed" : ""}`}
    >
      <header className="msg-head">
        <span className="msg-avatar msg-avatar--user" aria-hidden="true">
          <User size={13} />
        </span>
        <span className="msg-author">You</span>
        <time
          className="msg-time"
          dateTime={event.createdAt}
          title={formatDate(event.createdAt)}
        >
          {formatTime(event.createdAt)}
        </time>
      </header>
      <MarkdownContent>{event.summary}</MarkdownContent>
    </article>
  );
}

function AssistantMessage({
  event,
  agentName,
  flashed,
}: {
  readonly event: TimelineEvent;
  readonly agentName: string;
  readonly flashed: boolean;
}) {
  const meta = [
    event.durationMs === null ? null : formatCompactDuration(event.durationMs),
    event.tokens
      ? `${formatNumber(event.tokens.input)} in / ${formatNumber(event.tokens.output)} out`
      : null,
    event.costUsd ? formatCost(event.costUsd) : null,
  ].filter(Boolean);
  return (
    <article
      id={`event-${event.id}`}
      className={`msg msg--assistant${flashed ? " is-flashed" : ""}`}
    >
      <header className="msg-head">
        <span className="msg-avatar msg-avatar--assistant" aria-hidden="true">
          <Sparkles size={13} />
        </span>
        <span className="msg-author">{agentName}</span>
        <time
          className="msg-time"
          dateTime={event.createdAt}
          title={formatDate(event.createdAt)}
        >
          {formatTime(event.createdAt)}
        </time>
      </header>
      <MarkdownContent>{event.summary}</MarkdownContent>
      {meta.length > 0 ? (
        <footer className="msg-meta">{meta.join(" · ")}</footer>
      ) : null}
    </article>
  );
}

/** One-line record of work the agent did, expanding in place to its metadata. */
function ActivityRow({
  event,
  flashed = false,
}: {
  readonly event: TimelineEvent;
  readonly flashed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (event.kind === "reasoning")
    return (
      <ReasoningActivity
        event={event}
        flashed={flashed}
        open={open}
        onToggle={() => setOpen(!open)}
      />
    );
  if (event.kind === "tool")
    return (
      <ToolActivity
        event={event}
        flashed={flashed}
        open={open}
        onToggle={() => setOpen(!open)}
      />
    );
  const compactSandboxCommand =
    event.id.startsWith("debug:sandboxCommands:") && !event.payload;
  if (compactSandboxCommand)
    return (
      <div
        id={`event-${event.id}`}
        className={`activity activity--${event.status}${flashed ? " is-flashed" : ""}`}
      >
        <div className="activity-row activity-row--compact">
          <span className="activity-icon" aria-hidden="true">
            <EventIcon kind={event.kind} />
          </span>
          <span className="activity-name">{event.title}</span>
          <span className="activity-summary">
            {event.summary === event.title ? "" : event.summary}
          </span>
          {event.status === "error" ? (
            <span className="activity-flag activity-flag--error">Error</span>
          ) : event.status === "pending" ? (
            <span className="activity-flag activity-flag--pending">
              Pending
            </span>
          ) : null}
          <span className="activity-duration">
            {formatCompactDuration(event.durationMs)}
          </span>
        </div>
      </div>
    );
  const detailId = `detail-${event.id}`;
  return (
    <div
      id={`event-${event.id}`}
      className={`activity activity--${event.status}${flashed ? " is-flashed" : ""}`}
    >
      <button
        type="button"
        className="activity-row"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight className="caret" size={13} aria-hidden="true" />
        <span className="activity-icon" aria-hidden="true">
          <EventIcon kind={event.kind} />
        </span>
        <span className="activity-name">{event.title}</span>
        <span className="activity-summary" />
        {event.status === "error" ? (
          <span className="activity-flag activity-flag--error">Error</span>
        ) : event.status === "pending" ? (
          <span className="activity-flag activity-flag--pending">Pending</span>
        ) : null}
        <span className="activity-duration">
          {formatCompactDuration(event.durationMs)}
        </span>
      </button>
      <div id={detailId} hidden={!open} className="activity-detail">
        {open ? <EventDetail event={event} /> : null}
      </div>
    </div>
  );
}

/** Reasoning reads as transcript prose with only the facts useful to a user. */
function ReasoningActivity({
  event,
  flashed,
  open,
  onToggle,
}: {
  readonly event: TimelineEvent;
  readonly flashed: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const detailId = `detail-${event.id}`;
  return (
    <article
      id={`event-${event.id}`}
      className={`activity activity--reasoning activity--${event.status}${flashed ? " is-flashed" : ""}`}
    >
      <button
        type="button"
        className="activity-row"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <ChevronRight className="caret" size={13} aria-hidden="true" />
        <span className="activity-icon" aria-hidden="true">
          <EventIcon kind={event.kind} />
        </span>
        <span className="activity-name">Reasoning</span>
        <span className="activity-summary" />
        <span className="activity-duration">
          {formatCompactDuration(event.durationMs)}
        </span>
      </button>
      <div id={detailId} hidden={!open} className="reasoning-detail">
        {open ? (
          <>
            <p className="reasoning-copy">{event.summary}</p>
            <dl className="detail-facts reasoning-facts">
              <div>
                <dt>Type</dt>
                <dd>reasoning</dd>
              </div>
              <div>
                <dt>Timestamp</dt>
                <dd>{formatDate(event.createdAt)}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd className="mono">{formatDuration(event.durationMs)}</dd>
              </div>
              {event.tokens ? (
                <div>
                  <dt>Tokens</dt>
                  <dd className="mono">
                    {formatNumber(event.tokens.input)} in /{" "}
                    {formatNumber(event.tokens.output)} out
                  </dd>
                </div>
              ) : null}
            </dl>
          </>
        ) : null}
      </div>
    </article>
  );
}

function transcriptPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Tool use shows its input and outcome directly, without inspector tabs. */
function ToolActivity({
  event,
  flashed,
  open,
  onToggle,
}: {
  readonly event: TimelineEvent;
  readonly flashed: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const rendered = event.payload?.rendered;
  const hasTranscriptPayload = Boolean(
    rendered &&
    ("arguments" in rendered || "result" in rendered || "exitCode" in rendered),
  );
  return (
    <article
      id={`event-${event.id}`}
      className={`activity activity--tool activity--${event.status}${flashed ? " is-flashed" : ""}`}
    >
      {hasTranscriptPayload ? (
        <button
          type="button"
          className="activity-row"
          aria-expanded={open}
          aria-controls={`detail-${event.id}`}
          onClick={onToggle}
        >
          <ChevronRight className="caret" size={13} aria-hidden="true" />
          <span className="activity-icon" aria-hidden="true">
            <EventIcon kind={event.kind} />
          </span>
          <span className="activity-name">{event.title}</span>
          <span className="activity-summary" />
          {event.status === "error" ? (
            <span className="activity-flag activity-flag--error">Error</span>
          ) : event.status === "pending" ? (
            <span className="activity-flag activity-flag--pending">
              Pending
            </span>
          ) : null}
          <span className="activity-duration">
            {formatCompactDuration(event.durationMs)}
          </span>
        </button>
      ) : (
        <div className="activity-row activity-row--compact activity-row--static">
          <span className="activity-icon" aria-hidden="true">
            <EventIcon kind={event.kind} />
          </span>
          <span className="activity-name">{event.title}</span>
          <span className="activity-summary">
            {event.summary === event.title ? "" : event.summary}
          </span>
          {event.status === "error" ? (
            <span className="activity-flag activity-flag--error">Error</span>
          ) : event.status === "pending" ? (
            <span className="activity-flag activity-flag--pending">
              Pending
            </span>
          ) : null}
          <span className="activity-duration">
            {formatCompactDuration(event.durationMs)}
          </span>
        </div>
      )}
      {rendered && hasTranscriptPayload ? (
        <dl
          id={`detail-${event.id}`}
          hidden={!open}
          className="tool-transcript-detail"
        >
          {open ? (
            <>
              <div>
                <dt>Arguments</dt>
                <dd>
                  <code>{transcriptPayloadValue(rendered.arguments)}</code>
                </dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd>
                  <code>{transcriptPayloadValue(rendered.result)}</code>
                </dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : null}
    </article>
  );
}

/**
 * `timelineKind` falls back to `assistant` for anything it cannot classify, so
 * a runtime entry would otherwise claim to be a message. Report what the event
 * actually is in the transcript.
 */
function detailType(event: TimelineEvent): string {
  if (
    event.source &&
    event.source !== "message" &&
    MESSAGE_KINDS.has(event.kind)
  )
    return event.source;
  return humanize(event.kind);
}

/** Read-model payload keys are camelCase, which `humanize` alone leaves shouting. */
function payloadLabel(key: string): string {
  return humanize(key.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2"));
}

/** Nested payload values are objects; `String(value)` would print [object Object]. */
function payloadValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Safe metadata for one event, shared by the transcript and the inspector. */
function EventDetail({ event }: { readonly event: TimelineEvent }) {
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const [reveal, setReveal] = useState(false);
  return (
    <>
      <p className="detail-summary">{event.summary}</p>
      <dl className="detail-facts">
        <div>
          <dt>Type</dt>
          <dd>{detailType(event)}</dd>
        </div>
        <div>
          <dt>Timestamp</dt>
          <dd>{formatDate(event.createdAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd className="mono">{formatDuration(event.durationMs)}</dd>
        </div>
        {event.tokens ? (
          <div>
            <dt>Tokens</dt>
            <dd className="mono">
              {formatNumber(event.tokens.input)} in /{" "}
              {formatNumber(event.tokens.output)} out
            </dd>
          </div>
        ) : null}
        {event.costUsd ? (
          <div>
            <dt>Observed cost</dt>
            <dd className="mono">{formatCost(event.costUsd)}</dd>
          </div>
        ) : null}
      </dl>
      {event.payload ? (
        <>
          <div className="detail-tabs">
            <h4>Payload</h4>
            <Tabs
              label={`Payload view for ${event.title}`}
              variant="inline"
              value={view}
              onChange={setView}
              tabs={[
                { value: "rendered", label: "Rendered" },
                { value: "raw", label: "Raw" },
              ]}
            />
          </div>
          {view === "rendered" ? (
            <dl className="payload-list">
              {Object.entries(event.payload.rendered).map(([key, value]) => (
                <div key={key}>
                  <dt>{payloadLabel(key)}</dt>
                  <dd>
                    <code>{payloadValue(value)}</code>
                  </dd>
                </div>
              ))}
            </dl>
          ) : event.payload.raw ? (
            <pre className="code-block">{event.payload.raw}</pre>
          ) : (
            <div className="redacted-panel">
              <SearchCode size={18} aria-hidden="true" />
              <strong>Raw payload redacted</strong>
              <p>
                {reveal
                  ? event.payload.redactionReason
                  : "Raw secrets and sensitive tool payloads are not present in this public read model."}
              </p>
              {event.payload.redactionReason ? (
                <Button size="sm" onClick={() => setReveal(!reveal)}>
                  {reveal ? "Hide policy detail" : "Reveal redaction detail"}
                </Button>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <p className="detail-note">
          No additional payload is associated with this event.
        </p>
      )}
    </>
  );
}

/** Chat-style composer pinned under the conversation. */
function Composer({
  settled,
  status,
  pending,
  error,
  onSubmit,
}: {
  readonly settled: boolean;
  readonly status: string;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onSubmit: (message: string) => void;
}) {
  if (!settled)
    return (
      <div className="composer composer--waiting">
        <Clock3 size={14} aria-hidden="true" />
        <p>
          This session is {humanize(status)}. You can send the next message once
          the current run settles.
        </p>
      </div>
    );
  return (
    <form
      className="composer"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = String(new FormData(form).get("message") ?? "").trim();
        if (!message) return;
        onSubmit(message);
        form.reset();
      }}
    >
      <Field label="Message" labelHidden>
        <Textarea
          name="message"
          rows={3}
          required
          placeholder="Send a message to the agent"
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (
              event.key !== "Enter" ||
              !event.metaKey ||
              event.nativeEvent.isComposing ||
              pending
            )
              return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
      <div className="composer-actions">
        <span className="composer-hint">
          A new message starts another durable run on this same thread. Press
          ⌘+Enter to send.
        </span>
        <Button
          variant="primary"
          type="submit"
          loading={pending}
          icon={<Send size={14} />}
        >
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
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
          <i className="legend-swatch bar--success" aria-hidden="true" />
          Success
        </span>
        <span>
          <i className="legend-swatch bar--pending" aria-hidden="true" />
          Pending
        </span>
        <span>
          <i className="legend-swatch bar--error" aria-hidden="true" />
          Error
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
                type="button"
                id={`event-${event.id}`}
                className={selectedId === event.id ? "selected" : ""}
                onClick={() => onSelect(event.id)}
                aria-label={`Inspect ${event.title}`}
              >
                <span className="wf-name">
                  <EventIcon kind={event.kind} />
                  <strong>{event.title}</strong>
                </span>
                <span className="wf-track" aria-hidden="true">
                  <i
                    className={`bar bar--${event.status}`}
                    style={{ width: `${width}%` }}
                  />
                </span>
                <span className="wf-ms">
                  {event.durationMs === null
                    ? "waiting"
                    : formatDuration(event.durationMs)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Inspector({ event }: { readonly event: TimelineEvent | null }) {
  if (!event)
    return (
      <aside className="inspector" aria-label="Event inspector">
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
          <span className="eyebrow">Event inspector</span>
          <h2>{event.title}</h2>
        </div>
        <StatusChip value={event.status} />
      </header>
      <EventDetail key={event.id} event={event} />
    </aside>
  );
}

import { Check, ClipboardCheck, Hand, ShieldQuestion, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useApi } from "../api/context";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusPill,
  formatDate,
  shortId,
} from "../components/ui";

export function PendingWorkPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["pending-work"],
    queryFn: () => api.listPendingWork(),
  });
  const refresh = async () =>
    queryClient.invalidateQueries({ queryKey: ["pending-work"] });
  const claim = useMutation({
    mutationFn: (id: string) => api.claimTool(id),
    onSuccess: refresh,
  });
  const submit = useMutation({
    mutationFn: ({
      id,
      result,
    }: {
      id: string;
      result: Record<string, unknown>;
    }) => api.submitToolResult(id, result),
    onSuccess: async () => {
      setResultFor(null);
      await refresh();
    },
  });
  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
    }: {
      id: string;
      decision: "approved" | "denied";
    }) => api.decideApproval(id, decision),
    onSuccess: refresh,
  });
  const submitResult = (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault();
    setResultError(null);
    try {
      const raw = String(
        new FormData(event.currentTarget).get("result") ?? "{}",
      );
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Result must be a JSON object.");
      submit.mutate({ id, result: parsed as Record<string, unknown> });
    } catch (error) {
      setResultError(error instanceof Error ? error.message : "Invalid JSON");
    }
  };
  return (
    <div className="page">
      <PageHeader
        eyebrow="Human and caller handoff"
        title="Pending Work"
        description="Durable caller-owned tool calls and approval gates waiting for an authorized response."
      />
      {query.isPending ? (
        <LoadingState label="Loading pending work" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState
          title="Nothing needs attention"
          description="Pending caller tool calls and approvals will appear here."
        />
      ) : (
        <div className="work-list">
          {query.data.map((work) => (
            <article className="work-card" key={work.id}>
              <header>
                <span className={`work-icon work-icon--${work.kind}`}>
                  {work.kind === "tool" ? <Hand /> : <ShieldQuestion />}
                </span>
                <div>
                  <p className="eyebrow">
                    {work.kind === "tool" ? "Caller tool call" : "Approval"}
                  </p>
                  <h2>{work.kind === "tool" ? work.toolName : work.summary}</h2>
                  <Link to={`/sessions/${work.sessionId}`}>
                    {work.title} · {shortId(work.runId)}
                  </Link>
                </div>
                <StatusPill
                  value={work.kind === "tool" ? work.stage : work.status}
                />
              </header>
              <dl className="work-meta">
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(work.createdAt)}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{formatDate(work.expiresAt)}</dd>
                </div>
                {work.kind === "tool" ? (
                  <>
                    <div>
                      <dt>Claimed by</dt>
                      <dd>{work.claimedBy ?? "Unclaimed"}</dd>
                    </div>
                    <div>
                      <dt>Claim fence</dt>
                      <dd>{work.claimFence}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
              {work.kind === "tool" ? (
                <>
                  <div className="safe-arguments">
                    <h3>Safe arguments</h3>
                    <pre>{JSON.stringify(work.safeArguments, null, 2)}</pre>
                  </div>
                  <div className="work-actions">
                    {work.stage === "caller_pending" ? (
                      <button
                        className="button"
                        disabled={claim.isPending}
                        onClick={() => claim.mutate(work.id)}
                      >
                        <ClipboardCheck size={16} />
                        Claim request
                      </button>
                    ) : (
                      <button
                        className="button"
                        onClick={() =>
                          setResultFor(resultFor === work.id ? null : work.id)
                        }
                      >
                        <Check size={16} />
                        Submit result
                      </button>
                    )}
                  </div>
                  {resultFor === work.id ? (
                    <form
                      className="result-form"
                      onSubmit={(event) => submitResult(event, work.id)}
                    >
                      <label>
                        Result JSON
                        <textarea
                          name="result"
                          rows={5}
                          defaultValue={
                            '{\n  "quote_id": "quote_demo",\n  "amount": 425,\n  "currency": "EUR"\n}'
                          }
                        />
                      </label>
                      {resultError ? (
                        <p className="form-error" role="alert">
                          {resultError}
                        </p>
                      ) : null}
                      <button className="button" disabled={submit.isPending}>
                        Submit immutable result
                      </button>
                    </form>
                  ) : null}
                </>
              ) : (
                <div className="work-actions">
                  <button
                    className="button"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ id: work.id, decision: "approved" })
                    }
                  >
                    <Check size={16} />
                    Approve
                  </button>
                  <button
                    className="button button--danger"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ id: work.id, decision: "denied" })
                    }
                  >
                    <X size={16} />
                    Deny
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

import { Check, ClipboardCheck, Hand, ShieldQuestion, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useApi } from "../api/context";
import type { PendingWork } from "../api/types";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  LoadingState,
  MetaGrid,
  Page,
  PageHeader,
  StatusChip,
  Textarea,
  formatDate,
  shortId,
  useToast,
} from "../components/ui";

const RESULT_TEMPLATE =
  '{\n  "quote_id": "quote_demo",\n  "amount": 425,\n  "currency": "EUR"\n}';

export function PendingWorkPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [denying, setDenying] = useState<PendingWork | null>(null);
  const query = useQuery({
    queryKey: ["pending-work"],
    queryFn: () => api.listPendingWork(),
  });
  const refresh = async () =>
    queryClient.invalidateQueries({ queryKey: ["pending-work"] });
  const claim = useMutation({
    mutationFn: (id: string) => api.claimTool(id),
    onSuccess: async () => {
      await refresh();
      notify("Tool call claimed.");
    },
  });
  const submit = useMutation({
    mutationFn: ({
      id,
      result,
    }: {
      id: string;
      result: Record<string, unknown>;
    }) => {
      const work = query.data?.find(
        (item) => item.kind === "tool" && item.id === id,
      );
      if (!work || work.kind !== "tool")
        throw new Error("Claimed tool work was not found.");
      return api.submitToolResult(id, work.claimFence, {
        version: 1,
        status: "success",
        value: result,
      });
    },
    onSuccess: async () => {
      setResultFor(null);
      await refresh();
      notify("Immutable tool result recorded.");
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
    onSuccess: async (_result, { decision }) => {
      setDenying(null);
      await refresh();
      notify(
        decision === "approved" ? "Approval granted." : "Approval denied.",
      );
    },
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
    <Page>
      <PageHeader
        eyebrow="Human and caller handoff"
        title="Pending Work"
        description="Durable caller-owned tool calls and approval gates waiting for an authorized response."
      />
      {query.isPending ? (
        <LoadingState label="Loading pending work" rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState
          icon="✓"
          title="Nothing needs attention"
          description="Caller tool calls and approval gates appear here the moment a run waits on a human."
        />
      ) : (
        <div className="work-list">
          {query.data.map((work) => (
            <article
              className={`work-card work-card--${work.kind === "tool" ? "tool" : "approval"}`}
              key={work.id}
            >
              <header>
                <span
                  className={`work-icon work-icon--${work.kind}`}
                  aria-hidden="true"
                >
                  {work.kind === "tool" ? (
                    <Hand size={16} />
                  ) : (
                    <ShieldQuestion size={16} />
                  )}
                </span>
                <div>
                  <span className="eyebrow">
                    {work.kind === "tool" ? "Caller tool call" : "Approval"}
                  </span>
                  <h2>{work.kind === "tool" ? work.toolName : work.summary}</h2>
                  <Link to={`/sessions/${work.sessionId}`}>
                    {work.title} · {shortId(work.runId)}
                  </Link>
                </div>
                <StatusChip
                  value={work.kind === "tool" ? work.stage : work.status}
                />
              </header>
              <MetaGrid
                columns={work.kind === "tool" ? 4 : 2}
                items={[
                  { label: "Created", value: formatDate(work.createdAt) },
                  { label: "Expires", value: formatDate(work.expiresAt) },
                  ...(work.kind === "tool"
                    ? [
                        {
                          label: "Claimed by",
                          value: work.claimedBy ?? "Unclaimed",
                        },
                        {
                          label: "Claim fence",
                          value: (
                            <span className="mono">{work.claimFence}</span>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
              {work.kind === "tool" ? (
                <>
                  <div className="safe-arguments">
                    <h3>Safe arguments</h3>
                    <pre className="code-block">
                      {JSON.stringify(work.safeArguments, null, 2)}
                    </pre>
                  </div>
                  <div className="work-actions">
                    {work.stage === "caller_pending" ? (
                      <Button
                        variant="primary"
                        icon={<ClipboardCheck size={15} />}
                        loading={claim.isPending}
                        onClick={() => claim.mutate(work.id)}
                      >
                        Claim request
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        icon={<Check size={15} />}
                        aria-expanded={resultFor === work.id}
                        onClick={() =>
                          setResultFor(resultFor === work.id ? null : work.id)
                        }
                      >
                        Submit result
                      </Button>
                    )}
                  </div>
                  {resultFor === work.id ? (
                    <form
                      className="result-form"
                      onSubmit={(event) => submitResult(event, work.id)}
                    >
                      <Field
                        label="Successful result value"
                        hint="Validated against the published output schema before it is stored against the claim fence."
                      >
                        <Textarea
                          name="result"
                          rows={6}
                          className="input--mono"
                          defaultValue={RESULT_TEMPLATE}
                        />
                      </Field>
                      {resultError ? (
                        <FormError>{resultError}</FormError>
                      ) : null}
                      <div className="form-actions">
                        <Button
                          onClick={() => setResultFor(null)}
                          disabled={submit.isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          type="submit"
                          loading={submit.isPending}
                        >
                          Submit immutable result
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </>
              ) : (
                <div className="work-actions">
                  <Button
                    variant="primary"
                    icon={<Check size={15} />}
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ id: work.id, decision: "approved" })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    icon={<X size={15} />}
                    disabled={decide.isPending}
                    onClick={() => setDenying(work)}
                  >
                    Deny
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {denying && denying.kind === "approval" ? (
        <ConfirmDialog
          title="Deny this approval?"
          description={`“${denying.summary}” will not run. The agent continues with a denial recorded on the run, and this decision cannot be taken back.`}
          confirmLabel="Deny approval"
          cancelLabel="Keep pending"
          pending={decide.isPending}
          error={decide.error?.message ?? null}
          onClose={() => setDenying(null)}
          onConfirm={() =>
            decide.mutate({ id: denying.id, decision: "denied" })
          }
        />
      ) : null}
    </Page>
  );
}

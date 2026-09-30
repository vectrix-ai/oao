import {
  EventWebhookKindFilterSchema,
  EventWebhookSigningSecretSchema,
  ProductEventKindSchema,
} from "@oao/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import * as v from "valibot";
import { useApi } from "../api/context";
import type {
  CreateEventWebhookInput,
  EventWebhook,
  RotateEventWebhookCredentialInput,
  UpdateEventWebhookInput,
} from "../api/types";
import {
  Alert,
  Button,
  CheckboxRow,
  Chip,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  LoadingState,
  Panel,
  RadioRow,
  StatusChip,
  TableCard,
  Textarea,
  formatDate,
  formatNumber,
  humanize,
  useToast,
} from "../components/ui";

/** Standard Webhooks secret: `whsec_` plus base64 of 32 random bytes. */
export function generateSigningSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `whsec_${btoa(binary)}`;
}

const EVENT_KINDS: readonly string[] = ProductEventKindSchema.options;

/** Families a receiver most often wants come first. */
const FAMILY_LABELS: Readonly<Record<string, string>> = {
  run: "Runs",
  message: "Messages",
  tool_call: "Tool calls",
  approval: "Approvals",
  delegation: "Delegations",
  session: "Session summaries",
  harness: "Harness operations",
  model: "Model invocations",
  sandbox: "Sandboxes",
  skill: "Skills",
  mcp: "MCP",
  runtime: "Runtime",
};

const EVENT_FAMILIES = (() => {
  const families = [
    ...new Set(EVENT_KINDS.map((kind) => kind.slice(0, kind.indexOf(".")))),
  ];
  const order = Object.keys(FAMILY_LABELS);
  const rank = (family: string) =>
    order.includes(family) ? order.indexOf(family) : order.length;
  return families
    .sort((left, right) => rank(left) - rank(right))
    .map((family) => ({
      filter: `${family}.*`,
      label: FAMILY_LABELS[family] ?? humanize(family),
      count: EVENT_KINDS.filter((kind) => kind.startsWith(`${family}.`)).length,
    }));
})();

const FAMILY_FILTERS = new Set(EVENT_FAMILIES.map((family) => family.filter));
const MAX_EVENT_FILTERS = 100;
const PREVIOUS_SECRET_TTL_SECONDS = 86_400;

interface EventSelection {
  readonly all: boolean;
  readonly families: ReadonlySet<string>;
  /** Exact kinds or other wildcards, one per line. */
  readonly exact: string;
}

function selectionFrom(kinds: readonly string[] | null): EventSelection {
  return {
    all: kinds === null,
    families: new Set((kinds ?? []).filter((kind) => FAMILY_FILTERS.has(kind))),
    exact: (kinds ?? []).filter((kind) => !FAMILY_FILTERS.has(kind)).join("\n"),
  };
}

function exactKinds(selection: EventSelection): string[] {
  return selection.exact
    .split(/[\s,]+/u)
    .map((kind) => kind.trim())
    .filter(Boolean);
}

function selectionKinds(selection: EventSelection): string[] | null {
  if (selection.all) return null;
  return [
    ...new Set([
      ...EVENT_FAMILIES.map((family) => family.filter).filter((filter) =>
        selection.families.has(filter),
      ),
      ...exactKinds(selection),
    ]),
  ];
}

function selectionError(selection: EventSelection): string | undefined {
  if (selection.all) return undefined;
  const unknown = exactKinds(selection).filter(
    (kind) => !v.is(EventWebhookKindFilterSchema, kind),
  );
  if (unknown.length > 0)
    return `Unknown event ${unknown.length === 1 ? "kind" : "kinds"}: ${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? "…" : ""}. Use exact kinds such as message.created or families such as run.*.`;
  const kinds = selectionKinds(selection) ?? [];
  if (kinds.length === 0) return "Select at least one event family or kind.";
  if (kinds.length > MAX_EVENT_FILTERS)
    return `Select at most ${MAX_EVENT_FILTERS} event filters.`;
  return undefined;
}

function sameKinds(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    JSON.stringify([...new Set(left)].sort()) ===
    JSON.stringify([...new Set(right)].sort())
  );
}

function endpointError(
  value: string,
  allowPlainHttp: boolean,
): string | undefined {
  try {
    const url = new URL(value.trim());
    // The server reports whether it accepts plain HTTP, which only development
    // deployments with private-network endpoints enabled do.
    if (
      url.protocol !== "https:" &&
      !(allowPlainHttp && url.protocol === "http:")
    )
      return allowPlainHttp
        ? "Endpoint must use HTTP or HTTPS."
        : "Endpoint must use HTTPS.";
    if (url.username || url.password || url.hash)
      return "Remove credentials and the fragment from the URL.";
    return undefined;
  } catch {
    return "Enter an absolute HTTPS URL.";
  }
}

function displayNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Name is required.";
  if (name.length > 200) return "Name must contain at most 200 characters.";
  return undefined;
}

function errorCodeLabel(webhook: EventWebhook): string {
  switch (webhook.lastErrorCode) {
    case "http_status":
      return webhook.lastResponseStatus === null
        ? "Unexpected HTTP status"
        : `HTTP ${webhook.lastResponseStatus}`;
    case "timeout":
      return "Timed out";
    case "connection_failed":
      return "Connection failed";
    case "destination_blocked":
      return "Destination blocked";
    case "endpoint_gone":
      return "HTTP 410 Gone";
    case "signing_key_unavailable":
      return "Signing key unavailable";
    default:
      return webhook.lastErrorCode ? humanize(webhook.lastErrorCode) : "";
  }
}

function statusDetail(webhook: EventWebhook): string | null {
  if (webhook.status === "disabled")
    return webhook.disabledReason === "endpoint_gone"
      ? "Endpoint answered 410 Gone"
      : "Disabled by a user";
  if (webhook.status === "failing")
    return `${formatNumber(webhook.consecutiveFailures)} consecutive ${
      webhook.consecutiveFailures === 1 ? "failure" : "failures"
    } · ${errorCodeLabel(webhook)}`;
  return null;
}

function EventFilterSummary({
  kinds,
}: {
  readonly kinds: readonly string[] | null;
}) {
  if (kinds === null) return <span>All events</span>;
  const shown = kinds.slice(0, 4);
  return (
    <span>
      {shown.map((kind) => (
        <span className="scope" key={kind}>
          {kind}
        </span>
      ))}
      {kinds.length > shown.length ? (
        <small>+{kinds.length - shown.length} more</small>
      ) : null}
    </span>
  );
}

type WebhookAction =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly webhook: EventWebhook }
  | { readonly mode: "rotate"; readonly webhook: EventWebhook };

type WebhookMutation =
  | { readonly mode: "create"; readonly input: CreateEventWebhookInput }
  | {
      readonly mode: "edit";
      readonly webhookId: string;
      readonly input: UpdateEventWebhookInput;
    }
  | {
      readonly mode: "rotate";
      readonly webhookId: string;
      readonly input: RotateEventWebhookCredentialInput;
    };

const savedMessage: Record<WebhookMutation["mode"], string> = {
  create: "Webhook created.",
  edit: "Webhook updated.",
  rotate: "Signing secret rotated.",
};

export function EventWebhookConnections() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [action, setAction] = useState<WebhookAction | null>(null);
  const [deleting, setDeleting] = useState<EventWebhook | null>(null);
  const query = useQuery({
    queryKey: ["event-webhooks"],
    queryFn: () => api.listEventWebhooks(),
  });
  const save = useMutation({
    mutationFn: (input: WebhookMutation) => {
      switch (input.mode) {
        case "create":
          return api.createEventWebhook(input.input);
        case "edit":
          return api.updateEventWebhook(input.webhookId, input.input);
        case "rotate":
          return api.rotateEventWebhookCredential(input.webhookId, input.input);
      }
    },
    onSuccess: async (_webhook, input) => {
      await queryClient.invalidateQueries({ queryKey: ["event-webhooks"] });
      setAction(null);
      notify(savedMessage[input.mode]);
    },
  });
  const toggle = useMutation({
    mutationFn: (webhook: EventWebhook) =>
      api.updateEventWebhook(webhook.id, { enabled: !webhook.enabled }),
    onSuccess: async (webhook) => {
      await queryClient.invalidateQueries({ queryKey: ["event-webhooks"] });
      notify(
        `${webhook.enabled ? "Enabled" : "Disabled"} ${webhook.displayName}.`,
      );
    },
    onError: (error) =>
      notify(error.message || "The webhook could not be updated.", "danger"),
  });
  const remove = useMutation({
    mutationFn: (webhook: EventWebhook) => api.deleteEventWebhook(webhook.id),
    onSuccess: async (_result, webhook) => {
      await queryClient.invalidateQueries({ queryKey: ["event-webhooks"] });
      setDeleting(null);
      notify(`Deleted ${webhook.displayName}.`);
    },
  });
  const encryptionConfigured = query.data?.credentialEncryptionConfigured;
  return (
    <Panel
      title="Event webhooks"
      description="OAO POSTs this project's product events to your endpoint in ordered, signed batches using the Standard Webhooks format, and retries until the endpoint answers with a 2xx status."
      actions={
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={
            query.isPending || query.isError || encryptionConfigured !== true
          }
          onClick={() => {
            save.reset();
            setAction({ mode: "create" });
          }}
        >
          Add webhook
        </Button>
      }
    >
      {query.isPending ? (
        <LoadingState label="Loading webhooks" rows={2} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="stack">
          {!query.data.credentialEncryptionConfigured ? (
            <Alert tone="danger" role="alert" title="Encryption key required">
              Configure OAO_CREDENTIAL_ENCRYPTION_KEY before saving a webhook
              signing secret.
            </Alert>
          ) : null}
          {query.data.data.length === 0 ? (
            <EmptyState
              icon="⇢"
              title="No webhooks"
              description="Add a webhook to push run, message, and tool events to your own backend, such as a Convex HTTP action, as they happen."
            />
          ) : (
            <TableCard
              label="Event webhooks table"
              caption="Project event webhooks"
            >
              <thead>
                <tr>
                  <th>Webhook</th>
                  <th>Status</th>
                  <th>Events</th>
                  <th>Delivery</th>
                  <th>Signing secret</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((webhook) => {
                  const detail = statusDetail(webhook);
                  return (
                    <tr key={webhook.id}>
                      <td>
                        <strong>{webhook.displayName}</strong>
                        <br />
                        <code>{webhook.endpointUrl}</code>
                      </td>
                      <td>
                        <StatusChip value={webhook.status} />
                        {detail ? (
                          <>
                            <br />
                            <small>{detail}</small>
                          </>
                        ) : null}
                        {webhook.status === "failing" ? (
                          <>
                            <br />
                            <small>
                              Next attempt {formatDate(webhook.nextAttemptAt)}
                            </small>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <EventFilterSummary kinds={webhook.eventKinds} />
                        <br />
                        {webhook.includeMessageContent ? (
                          <Chip tone="warning">Includes message text</Chip>
                        ) : (
                          <small>No message text</small>
                        )}
                      </td>
                      <td>
                        {formatNumber(webhook.pendingEvents)} pending
                        <br />
                        <small>
                          {webhook.lastSuccessAt
                            ? `Last success ${formatDate(webhook.lastSuccessAt)}${
                                webhook.lastErrorCode === null &&
                                webhook.lastResponseStatus !== null
                                  ? ` · HTTP ${webhook.lastResponseStatus}`
                                  : ""
                              }`
                            : "No successful delivery yet"}
                        </small>
                        {webhook.lastFailureAt ? (
                          <>
                            <br />
                            <small>
                              Last failure {formatDate(webhook.lastFailureAt)}
                              {webhook.lastErrorCode
                                ? ` · ${errorCodeLabel(webhook)}`
                                : ""}
                            </small>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <span className="key-mask">
                          ••••{webhook.credentialFingerprint.slice(-6)}
                        </span>
                        <br />
                        <small>version {webhook.credentialVersion}</small>
                        {webhook.previousCredentialExpiresAt ? (
                          <>
                            <br />
                            <small>
                              Previous secret valid until{" "}
                              {formatDate(webhook.previousCredentialExpiresAt)}
                            </small>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <span className="row">
                          <Button
                            size="sm"
                            icon={
                              webhook.enabled ? (
                                <PowerOff size={13} />
                              ) : (
                                <Power size={13} />
                              )
                            }
                            disabled={
                              toggle.isPending &&
                              toggle.variables?.id === webhook.id
                            }
                            onClick={() => toggle.mutate(webhook)}
                          >
                            {webhook.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            size="sm"
                            icon={<Pencil size={13} />}
                            onClick={() => {
                              save.reset();
                              setAction({ mode: "edit", webhook });
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            icon={<RefreshCw size={13} />}
                            disabled={encryptionConfigured !== true}
                            onClick={() => {
                              save.reset();
                              setAction({ mode: "rotate", webhook });
                            }}
                          >
                            Rotate secret
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Trash2 size={13} />}
                            onClick={() => {
                              remove.reset();
                              setDeleting(webhook);
                            }}
                          >
                            Delete
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableCard>
          )}
        </div>
      )}
      {action?.mode === "rotate" ? (
        <RotateEventWebhookSecretDialog
          key={`rotate:${action.webhook.id}`}
          webhook={action.webhook}
          pending={save.isPending}
          error={save.error}
          onClose={() => {
            save.reset();
            setAction(null);
          }}
          onSubmit={(input) =>
            save.mutate(
              { mode: "rotate", webhookId: action.webhook.id, input },
              // Drop the submitted secret from the mutation state once saved.
              { onSuccess: () => save.reset() },
            )
          }
        />
      ) : action ? (
        <EventWebhookDialog
          key={`${action.mode}:${"webhook" in action ? action.webhook.id : "new"}`}
          {...("webhook" in action ? { webhook: action.webhook } : {})}
          allowPlainHttp={query.data?.privateNetworkEndpointsAllowed === true}
          pending={save.isPending}
          error={save.error}
          onClose={() => {
            save.reset();
            setAction(null);
          }}
          onSubmit={(input) =>
            save.mutate(input, { onSuccess: () => save.reset() })
          }
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete “${deleting.displayName}”?`}
          description={`OAO stops delivering events to ${deleting.endpointUrl} and erases this webhook's signing secrets.${
            deleting.pendingEvents > 0
              ? ` ${formatNumber(deleting.pendingEvents)} undelivered ${
                  deleting.pendingEvents === 1 ? "event is" : "events are"
                } never sent to it.`
              : ""
          } This cannot be undone.`}
          confirmLabel="Delete webhook"
          pending={remove.isPending}
          error={remove.error?.message ?? null}
          onClose={() => {
            remove.reset();
            setDeleting(null);
          }}
          onConfirm={() => remove.mutate(deleting)}
        />
      ) : null}
    </Panel>
  );
}

function EventKindsPicker({
  value,
  onChange,
  error,
}: {
  readonly value: EventSelection;
  readonly onChange: (value: EventSelection) => void;
  readonly error: string | undefined;
}) {
  const name = useId();
  return (
    <fieldset className="scope-picker">
      <legend>Events</legend>
      <div className="choice-stack">
        <div className="choice-list">
          <RadioRow
            name={name}
            label="All events"
            description="Every product event, including kinds added in later OAO versions."
            checked={value.all}
            onChange={() => onChange({ ...value, all: true })}
          />
          <RadioRow
            name={name}
            label="Selected events"
            description="Only the event families and exact kinds chosen below."
            checked={!value.all}
            onChange={() => onChange({ ...value, all: false })}
          />
        </div>
        {!value.all ? (
          <>
            <div className="scope-picker-grid">
              {EVENT_FAMILIES.map((family) => (
                <CheckboxRow
                  key={family.filter}
                  label={family.label}
                  description={`${family.filter} · ${family.count} ${
                    family.count === 1 ? "kind" : "kinds"
                  }`}
                  checked={value.families.has(family.filter)}
                  onChange={(event) => {
                    const families = new Set(value.families);
                    if (event.target.checked) families.add(family.filter);
                    else families.delete(family.filter);
                    onChange({ ...value, families });
                  }}
                />
              ))}
            </div>
            <Field
              label="Exact event kinds"
              hint="Optional. One kind per line, for example message.created."
            >
              <Textarea
                rows={3}
                spellCheck={false}
                value={value.exact}
                placeholder={"message.created\ntool_call.requested"}
                onChange={(event) =>
                  onChange({ ...value, exact: event.target.value })
                }
              />
            </Field>
          </>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
      </div>
    </fieldset>
  );
}

function MessageContentOption({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <>
      <CheckboxRow
        label="Include message content"
        description="Sends message text to this endpoint. Only enable it for receivers you control."
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {checked ? (
        <Alert tone="warning" role="note" title="Message text leaves OAO">
          The plain text of user and assistant messages is attached to
          message.created events. Treat the receiver as holding conversation
          data.
        </Alert>
      ) : null}
    </>
  );
}

function useSigningSecret() {
  const [generated, setGenerated] = useState(generateSigningSecret);
  const [custom, setCustom] = useState(false);
  const [own, setOwn] = useState("");
  const secret = custom ? own.trim() : generated;
  const error =
    custom && !v.is(EventWebhookSigningSecretSchema, secret)
      ? "Use whsec_ followed by the base64 encoding of 24 to 64 random bytes."
      : undefined;
  return {
    generated,
    custom,
    own,
    secret,
    error,
    setCustom,
    setOwn,
    regenerate: () => setGenerated(generateSigningSecret()),
  };
}

type SigningSecretState = ReturnType<typeof useSigningSecret>;

function SigningSecretFields({
  state,
}: {
  readonly state: SigningSecretState;
}) {
  const name = useId();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  return (
    <fieldset className="scope-picker">
      <legend>Signing secret</legend>
      <div className="choice-stack">
        <span className="hint">
          OAO signs every delivery with this secret and never returns it. Store
          it with your receiver, for example as a Convex environment variable,
          and verify the webhook-signature header.
        </span>
        <div className="choice-list">
          <RadioRow
            name={name}
            label="Generate a secret"
            description="32 random bytes created in this browser."
            checked={!state.custom}
            onChange={() => state.setCustom(false)}
          />
          <RadioRow
            name={name}
            label="Use my own secret"
            description="Paste a whsec_ secret your receiver already has."
            checked={state.custom}
            onChange={() => state.setCustom(true)}
          />
        </div>
        {state.custom ? (
          <Field
            label="Your signing secret"
            hint="whsec_ followed by the base64 encoding of 24 to 64 random bytes."
            {...(state.own && state.error ? { error: state.error } : {})}
          >
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={state.own}
              onChange={(event) => state.setOwn(event.target.value)}
            />
          </Field>
        ) : (
          <>
            <Alert tone="warning" role="status" title="Shown only once">
              Save this secret now. OAO will not show it again.
            </Alert>
            <Field label="Generated signing secret">
              <Input
                className="input--mono"
                readOnly
                spellCheck={false}
                value={state.generated}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
            <span className="row">
              <Button
                size="sm"
                icon={<Copy size={13} />}
                onClick={() => {
                  setCopyError(null);
                  const clipboard = navigator.clipboard;
                  if (!clipboard) {
                    setCopyError(
                      "Copy is unavailable. Select and copy the secret manually.",
                    );
                    return;
                  }
                  void clipboard
                    .writeText(state.generated)
                    .then(() => setCopied(true))
                    .catch(() =>
                      setCopyError(
                        "Copy failed. Select and copy the secret manually.",
                      ),
                    );
                }}
              >
                {copied ? "Copied" : "Copy secret"}
              </Button>
              <Button
                size="sm"
                icon={<RefreshCw size={13} />}
                onClick={() => {
                  setCopied(false);
                  state.regenerate();
                }}
              >
                Generate another
              </Button>
            </span>
            {copyError ? <FormError>{copyError}</FormError> : null}
          </>
        )}
      </div>
    </fieldset>
  );
}

function EventWebhookDialog({
  webhook,
  allowPlainHttp,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  /** Absent when creating a webhook. */
  readonly webhook?: EventWebhook;
  /** Whether the server accepts http:// endpoints (development only). */
  readonly allowPlainHttp: boolean;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: WebhookMutation) => void;
}) {
  const create = webhook === undefined;
  const deliverFromName = useId();
  const [displayName, setDisplayName] = useState(webhook?.displayName ?? "");
  const [endpointUrl, setEndpointUrl] = useState(webhook?.endpointUrl ?? "");
  const [events, setEvents] = useState(() =>
    selectionFrom(webhook ? webhook.eventKinds : null),
  );
  const [includeMessageContent, setIncludeMessageContent] = useState(
    webhook?.includeMessageContent ?? false,
  );
  const [deliverFrom, setDeliverFrom] = useState<"now" | "beginning">("now");
  const secret = useSigningSecret();
  const nameError = displayNameError(displayName);
  const urlError = endpointError(endpointUrl, allowPlainHttp);
  const eventsError = selectionError(events);
  const eventKinds = selectionKinds(events);
  const changes: UpdateEventWebhookInput = webhook
    ? {
        ...(displayName.trim() !== webhook.displayName
          ? { displayName: displayName.trim() }
          : {}),
        ...(endpointUrl.trim() !== webhook.endpointUrl
          ? { endpointUrl: endpointUrl.trim() }
          : {}),
        ...(sameKinds(eventKinds, webhook.eventKinds) ? {} : { eventKinds }),
        ...(includeMessageContent !== webhook.includeMessageContent
          ? { includeMessageContent }
          : {}),
      }
    : {};
  const unchanged = !create && Object.keys(changes).length === 0;
  const invalid = Boolean(
    nameError || urlError || eventsError || (create && secret.error),
  );
  return (
    <Dialog
      title={create ? "Add webhook" : `Edit ${webhook.displayName}`}
      description={
        create
          ? "OAO delivers this project's events to the endpoint in order and retries failed batches with backoff."
          : "Changing the endpoint, events, or message content applies to the next batch. The signing secret stays the same."
      }
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (invalid || unchanged) return;
        if (create)
          onSubmit({
            mode: "create",
            input: {
              displayName: displayName.trim(),
              endpointUrl: endpointUrl.trim(),
              signingSecret: secret.secret,
              eventKinds,
              includeMessageContent,
              deliverFrom,
            },
          });
        else onSubmit({ mode: "edit", webhookId: webhook.id, input: changes });
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={pending}
            disabled={invalid || unchanged}
          >
            {pending ? "Saving…" : create ? "Create webhook" : "Save changes"}
          </Button>
        </>
      }
    >
      <Field
        label="Name"
        {...(displayName && nameError ? { error: nameError } : {})}
      >
        <Input
          autoFocus
          value={displayName}
          maxLength={200}
          placeholder="Convex production"
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <Field
        label="Endpoint URL"
        hint="The HTTPS URL of your receiver, such as a Convex HTTP action. Redirects are not followed."
        {...(endpointUrl && urlError ? { error: urlError } : {})}
      >
        <Input
          type="url"
          inputMode="url"
          spellCheck={false}
          value={endpointUrl}
          placeholder="https://example.convex.site/oao/events"
          onChange={(event) => setEndpointUrl(event.target.value)}
        />
      </Field>
      <EventKindsPicker
        value={events}
        onChange={setEvents}
        error={eventsError}
      />
      <MessageContentOption
        checked={includeMessageContent}
        onChange={setIncludeMessageContent}
      />
      {create ? (
        <>
          <fieldset className="scope-picker">
            <legend>Deliver from</legend>
            <div className="choice-list">
              <RadioRow
                name={deliverFromName}
                label="New events only"
                description="Start after the latest event already recorded in this project."
                checked={deliverFrom === "now"}
                onChange={() => setDeliverFrom("now")}
              />
              <RadioRow
                name={deliverFromName}
                label="Replay project history"
                description="Deliver every event already recorded in this project, oldest first, then new ones."
                checked={deliverFrom === "beginning"}
                onChange={() => setDeliverFrom("beginning")}
              />
            </div>
          </fieldset>
          <SigningSecretFields state={secret} />
        </>
      ) : null}
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

function RotateEventWebhookSecretDialog({
  webhook,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly webhook: EventWebhook;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: RotateEventWebhookCredentialInput) => void;
}) {
  const previousName = useId();
  const secret = useSigningSecret();
  const [keepPrevious, setKeepPrevious] = useState(true);
  return (
    <Dialog
      title={`Rotate secret for ${webhook.displayName}`}
      description="Deliveries are signed with the new secret as soon as it is saved. Update your receiver with it."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (secret.error) return;
        onSubmit({
          signingSecret: secret.secret,
          previousCredentialTtlSeconds: keepPrevious
            ? PREVIOUS_SECRET_TTL_SECONDS
            : 0,
        });
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={pending}
            disabled={Boolean(secret.error)}
          >
            {pending ? "Rotating…" : "Rotate secret"}
          </Button>
        </>
      }
    >
      <SigningSecretFields state={secret} />
      <fieldset className="scope-picker">
        <legend>Previous secret</legend>
        <div className="choice-list">
          <RadioRow
            name={previousName}
            label="Keep the previous secret valid for 24 hours"
            description="Deliveries carry signatures from both secrets, so the receiver can switch without rejecting any."
            checked={keepPrevious}
            onChange={() => setKeepPrevious(true)}
          />
          <RadioRow
            name={previousName}
            label="Revoke the previous secret immediately"
            description="Only the new secret signs deliveries from now on."
            checked={!keepPrevious}
            onChange={() => setKeepPrevious(false)}
          />
        </div>
      </fieldset>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

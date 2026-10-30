import { EventWebhookSigningSecretSchema } from "@oao/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Download, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import * as v from "valibot";
import { useApi } from "../api/context";
import type {
  ConfigurationBackup,
  ConfigurationRestoreCredentialsInput,
  ConfigurationRestorePlan,
  ConfigurationRestoreResult,
} from "../api/types";
import {
  configurationBackupFileName,
  readConfigurationBackup,
} from "../configuration-backup";
import {
  Alert,
  Button,
  Chip,
  Field,
  FieldRow,
  FormActions,
  FormError,
  Input,
  MetaGrid,
  Note,
  Panel,
  TableCard,
  formatDate,
  formatNumber,
  useToast,
  type ChipTone,
} from "../components/ui";

type RequiredCredential =
  ConfigurationRestorePlan["requiredCredentials"][number];

type CredentialField =
  | "apiKey"
  | "accessKeyId"
  | "secretAccessKey"
  | "sessionToken"
  | "secret"
  | "signingSecret";

interface LoadedBackup {
  readonly fileName: string;
  readonly backup: ConfigurationBackup;
  readonly plan: ConfigurationRestorePlan;
}

const PROJECT_ACTIONS: Record<
  ConfigurationRestorePlan["projects"][number]["action"],
  { readonly label: string; readonly tone: ChipTone }
> = {
  create: { label: "Create", tone: "success" },
  use_empty_project: { label: "Fill empty project", tone: "info" },
  blocked: { label: "Blocked", tone: "danger" },
};

const MODEL_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  bedrock: "Amazon Bedrock",
};

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${formatNumber(value)} ${value === 1 ? noun : plural}`;
}

/** FileReader rather than Blob.text(): the latter is missing in some engines. */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`)),
    );
    reader.readAsText(file, "utf-8");
  });
}

function saveBackup(backup: ConfigurationBackup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = configurationBackupFileName(backup);
  link.click();
  URL.revokeObjectURL(url);
}

function connectionLabel(entry: RequiredCredential): string {
  switch (entry.kind) {
    case "model_provider":
      return `${MODEL_PROVIDER_LABELS[entry.providerType ?? ""] ?? "Model"} model provider`;
    case "sandbox_provider":
      return "Daytona sandbox provider";
    case "storage_provider":
      return "S3 storage provider";
    case "mcp_credential":
      return entry.providerType === "api_key_header"
        ? "MCP API-key header"
        : "MCP bearer token";
    case "event_webhook":
      return "Event webhook in project";
  }
}

/** The inputs each kind of connection needs, in display order. */
function credentialFields(entry: RequiredCredential): readonly {
  readonly field: CredentialField;
  readonly label: string;
  readonly optional?: true;
}[] {
  switch (entry.kind) {
    case "model_provider":
    case "sandbox_provider":
      return [{ field: "apiKey", label: "API key" }];
    case "storage_provider":
      return [
        { field: "accessKeyId", label: "Access key ID" },
        { field: "secretAccessKey", label: "Secret access key" },
        { field: "sessionToken", label: "Session token", optional: true },
      ];
    case "mcp_credential":
      return [{ field: "secret", label: "Secret" }];
    case "event_webhook":
      return [{ field: "signingSecret", label: "Signing secret" }];
  }
}

function credentialName(
  entry: RequiredCredential,
  field: CredentialField,
): string {
  return `${entry.kind}:${entry.id}:${field}`;
}

/** Mirrors the restore contract so a doomed request is never sent. */
function credentialError(
  field: CredentialField,
  value: string,
): string | undefined {
  switch (field) {
    case "sessionToken":
      return undefined;
    case "accessKeyId":
      return value.length < 3 ? "Enter at least 3 characters." : undefined;
    case "signingSecret":
      return v.is(EventWebhookSigningSecretSchema, value.trim())
        ? undefined
        : "Use whsec_ followed by the base64 encoding of 24 to 64 random bytes.";
    default:
      return value.length < 8 ? "Enter at least 8 characters." : undefined;
  }
}

function restoreCredentials(
  plan: ConfigurationRestorePlan,
  values: Readonly<Record<string, string>>,
): ConfigurationRestoreCredentialsInput {
  const value = (entry: RequiredCredential, field: CredentialField) =>
    values[credentialName(entry, field)] ?? "";
  const modelProviders: Record<string, string> = {};
  const sandboxProviders: Record<string, string> = {};
  const storageProviders: Record<
    string,
    { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  > = {};
  const mcpCredentials: Record<string, string> = {};
  const eventWebhooks: Record<string, string> = {};
  for (const entry of plan.requiredCredentials)
    switch (entry.kind) {
      case "model_provider":
        modelProviders[entry.id] = value(entry, "apiKey");
        break;
      case "sandbox_provider":
        sandboxProviders[entry.id] = value(entry, "apiKey");
        break;
      case "storage_provider": {
        const sessionToken = value(entry, "sessionToken");
        storageProviders[entry.id] = {
          accessKeyId: value(entry, "accessKeyId"),
          secretAccessKey: value(entry, "secretAccessKey"),
          ...(sessionToken ? { sessionToken } : {}),
        };
        break;
      }
      case "mcp_credential":
        mcpCredentials[entry.id] = value(entry, "secret");
        break;
      case "event_webhook":
        eventWebhooks[entry.id] = value(entry, "signingSecret").trim();
        break;
    }
  return {
    modelProviders,
    sandboxProviders,
    storageProviders,
    mcpCredentials,
    eventWebhooks,
  };
}

/**
 * Organization configuration backup: download it as one file, or restore one
 * into new or empty projects after a preview that changes nothing. Entered
 * keys live only in this form's state and are cleared after the restore.
 */
export function ConfigurationBackupPanel({
  canManage,
}: {
  readonly canManage: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<LoadedBackup | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [result, setResult] = useState<ConfigurationRestoreResult | null>(null);
  const download = useMutation({
    mutationFn: () => api.downloadConfigurationBackup(),
    onSuccess: (backup) => {
      saveBackup(backup);
      notify("Backup downloaded.");
    },
  });
  const restore = useMutation({
    mutationFn: (request: Parameters<typeof api.restoreConfiguration>[0]) =>
      api.restoreConfiguration(request),
    // The variables hold the entered keys; drop the mutation once it is reset.
    gcTime: 0,
    onSuccess: async (restored) => {
      setLoaded(null);
      setValues({});
      restore.reset();
      setResult(restored);
      notify("Configuration restored.");
      // New projects and connections show up everywhere.
      await queryClient.invalidateQueries();
    },
  });
  const discard = () => {
    setLoaded(null);
    setValues({});
    restore.reset();
  };
  const load = useMutation({
    mutationFn: async (file: File): Promise<LoadedBackup> => {
      const backup = readConfigurationBackup(await readFileText(file));
      return {
        fileName: file.name,
        backup,
        plan: await api.previewConfigurationRestore(backup),
      };
    },
    onMutate: () => {
      discard();
      setResult(null);
    },
    onSuccess: setLoaded,
  });
  return (
    <Panel
      title="Backup and restore"
      description="Move this organization's configuration to another OAO server, or keep a copy before larger changes."
      actions={<DatabaseBackup size={18} aria-hidden="true" />}
    >
      {!canManage ? (
        <p className="muted">
          Only organization owners and admins can download or restore a
          configuration backup.
        </p>
      ) : (
        <div className="stack">
          <div>
            <div className="setting-row">
              <span className="who">
                <strong>Download backup</strong>
                <small>
                  One JSON file with every project&apos;s agents and Skills
                  (every version), MCP toolsets, model presets, event webhooks,
                  and the shared connections. It never contains credentials, API
                  keys, members, or run history.
                </small>
              </span>
              <Button
                icon={<Download size={14} />}
                loading={download.isPending}
                onClick={() => download.mutate()}
              >
                Download backup
              </Button>
            </div>
            <div className="setting-row">
              <span className="who">
                <strong>Restore from backup</strong>
                <small>
                  Creates an exact copy in projects that are new or empty, after
                  you enter every connection&apos;s key. It either completes or
                  changes nothing.
                </small>
              </span>
              <input
                ref={input}
                type="file"
                accept=".json,application/json"
                aria-label="Backup file"
                hidden
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) load.mutate(file);
                }}
              />
              <Button
                icon={<Upload size={14} />}
                loading={load.isPending}
                disabled={restore.isPending}
                onClick={() => input.current?.click()}
              >
                Restore from backup
              </Button>
            </div>
          </div>
          {download.error ? (
            <FormError>{download.error.message}</FormError>
          ) : null}
          {load.error ? <FormError>{load.error.message}</FormError> : null}
          {result ? <RestoreSummary result={result} /> : null}
          {loaded ? (
            <RestorePlanForm
              loaded={loaded}
              values={values}
              pending={restore.isPending}
              error={restore.error}
              onChange={(name, value) =>
                setValues((current) => ({ ...current, [name]: value }))
              }
              onCancel={discard}
              onRestore={() =>
                restore.mutate({
                  backup: loaded.backup,
                  credentials: restoreCredentials(loaded.plan, values),
                })
              }
            />
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function RestorePlanForm({
  loaded,
  values,
  pending,
  error,
  onChange,
  onCancel,
  onRestore,
}: {
  readonly loaded: LoadedBackup;
  readonly values: Readonly<Record<string, string>>;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onChange: (name: string, value: string) => void;
  readonly onCancel: () => void;
  readonly onRestore: () => void;
}) {
  const { plan } = loaded;
  const counts = plan.counts;
  const complete = plan.requiredCredentials.every((entry) =>
    credentialFields(entry).every(({ field, optional }) => {
      const value = values[credentialName(entry, field)] ?? "";
      return optional || (value.length > 0 && !credentialError(field, value));
    }),
  );
  return (
    <form
      className="stack"
      aria-label="Restore plan"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (plan.ready && complete) onRestore();
      }}
    >
      <MetaGrid
        columns={3}
        items={[
          { label: "Backup file", value: loaded.fileName },
          {
            label: "Source organization",
            value: (
              <>
                {plan.organization.name} <code>{plan.organization.slug}</code>
              </>
            ),
          },
          { label: "Exported", value: formatDate(plan.exportedAt) },
        ]}
      />
      <MetaGrid
        columns={4}
        items={[
          { label: "Projects", value: formatNumber(counts.projects) },
          {
            label: "Agents",
            value: `${formatNumber(counts.agents)} · ${count(counts.agentVersions, "version")}`,
          },
          {
            label: "Skills",
            value: `${formatNumber(counts.skills)} · ${count(counts.skillVersions, "version")}`,
          },
          { label: "Model presets", value: formatNumber(counts.modelPresets) },
          {
            label: "MCP",
            value: `${count(counts.mcpServers, "server")} · ${count(counts.mcpToolsets, "toolset")}`,
          },
          {
            label: "MCP credentials",
            value: `${formatNumber(counts.mcpCredentials)} · ${count(counts.mcpCredentialPolicies, "policy", "policies")}`,
          },
          {
            label: "Connections",
            value: `${formatNumber(counts.modelProviders)} model · ${formatNumber(counts.sandboxProviders)} sandbox · ${formatNumber(counts.storageProviders)} storage`,
          },
          { label: "Webhooks", value: formatNumber(counts.eventWebhooks) },
        ]}
      />
      {plan.projects.length === 0 ? (
        <p className="muted">The backup holds no projects.</p>
      ) : (
        <TableCard
          label="Projects in the backup"
          caption="What the restore does with each project"
        >
          <thead>
            <tr>
              <th>Project</th>
              <th>Slug</th>
              <th>Restore</th>
            </tr>
          </thead>
          <tbody>
            {plan.projects.map((project) => (
              <tr key={project.slug}>
                <td>
                  <strong>{project.name}</strong>
                </td>
                <td>
                  <code>{project.slug}</code>
                </td>
                <td>
                  <Chip tone={PROJECT_ACTIONS[project.action].tone}>
                    {PROJECT_ACTIONS[project.action].label}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </TableCard>
      )}
      {plan.conflicts.length > 0 ? (
        <Alert tone="danger" role="alert" title="Restore is blocked">
          <ul>
            {plan.conflicts.map((conflict, index) => (
              <li key={index}>{conflict.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {plan.warnings.length > 0 ? (
        <Alert tone="warning" role="note" title="Warnings">
          <ul>
            {plan.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {plan.requiredCredentials.length === 0 ? (
        <p className="muted">This backup needs no connection keys.</p>
      ) : (
        <>
          <Note>
            A backup never contains credentials. Enter the key of each
            connection; it is sent only with this restore. The fingerprint is
            the start of the original key&apos;s SHA-256, as shown on the
            connection pages.
          </Note>
          {plan.requiredCredentials.map((entry) => (
            <fieldset
              className="scope-picker"
              key={`${entry.kind}:${entry.id}`}
            >
              <legend>{entry.displayName}</legend>
              <span className="hint">
                {connectionLabel(entry)}{" "}
                <code>{entry.key ?? entry.projectSlug}</code>
              </span>
              <FieldRow>
                {credentialFields(entry).map(({ field, label }, index) => {
                  const name = credentialName(entry, field);
                  const value = values[name] ?? "";
                  const fieldError = value
                    ? credentialError(field, value)
                    : undefined;
                  const hint = [
                    field === "sessionToken"
                      ? "Optional, for temporary credentials."
                      : field === "signingSecret"
                        ? "Starts with whsec_."
                        : "",
                    index === 0 && entry.credentialFingerprint
                      ? `Original ${entry.kind === "event_webhook" || entry.kind === "mcp_credential" ? "secret" : "key"} fingerprint: ${entry.credentialFingerprint}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <Field
                      key={field}
                      label={label}
                      {...(hint ? { hint } : {})}
                      {...(fieldError ? { error: fieldError } : {})}
                    >
                      <Input
                        type="password"
                        autoComplete="off"
                        value={value}
                        disabled={pending}
                        onChange={(event) => onChange(name, event.target.value)}
                      />
                    </Field>
                  );
                })}
              </FieldRow>
            </fieldset>
          ))}
        </>
      )}
      {error ? <FormError>{error.message}</FormError> : null}
      <FormActions>
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          loading={pending}
          disabled={!plan.ready || !complete}
        >
          {pending ? "Restoring…" : "Restore"}
        </Button>
      </FormActions>
    </form>
  );
}

function RestoreSummary({
  result,
}: {
  readonly result: ConfigurationRestoreResult;
}) {
  return (
    <>
      <Alert tone="success" role="status" title="Restore complete">
        {result.projects.length === 0 ? (
          "The backup held no projects; its connections were restored."
        ) : (
          <ul>
            {result.projects.map((project) => (
              <li key={project.projectId}>
                {project.created ? "Created project" : "Filled empty project"}{" "}
                <code>{project.slug}</code>
              </li>
            ))}
          </ul>
        )}
      </Alert>
      {result.warnings.length > 0 ? (
        <Alert tone="warning" role="note" title="Follow up">
          <ul>
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </>
  );
}

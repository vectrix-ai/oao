import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useApi } from "../api/context";
import { mcpResourceDestination } from "@oao/contracts";
import type {
  CreateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpServerInput,
  CreateMcpToolsetInput,
  AgentSummary,
  AgentVersionConfig,
  McpCredential,
  McpCredentialPolicy,
  McpAuthorizationDiscovery,
  McpServer,
  McpToolset,
  RotateMcpCredentialInput,
} from "../api/types";

type McpTokenEndpointAuthMethod = NonNullable<
  NonNullable<McpCredential["oauth"]>["tokenEndpointAuthMethod"]
>;
import {
  Alert,
  Button,
  CheckboxRow,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  LoadingState,
  Page,
  PageHeader,
  Panel,
  Select,
  StatusChip,
  TableCard,
  useToast,
} from "../components/ui";

/** A create dialog opened from one connection's details. */
type CreateDialog = {
  readonly kind: "policy" | "toolset";
  readonly server: McpServer;
};

/**
 * True when a policy covers a server endpoint, as the database matches them:
 * the same origin and a path that starts with the policy's prefix.
 */
function policyCoversServer(
  policy: McpCredentialPolicy,
  server: McpServer,
): boolean {
  try {
    const endpoint = new URL(server.endpointUrl);
    return (
      new URL(policy.exactOrigin).origin === endpoint.origin &&
      endpoint.pathname.startsWith(policy.pathPrefix)
    );
  } catch {
    return false;
  }
}

export function McpPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [managingServerId, setManagingServerId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<CreateDialog | null>(null);
  const [rotatingCredential, setRotatingCredential] =
    useState<McpCredential | null>(null);
  const [revokingCredential, setRevokingCredential] =
    useState<McpCredential | null>(null);
  const [removingServer, setRemovingServer] = useState<McpServer | null>(null);
  const servers = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.listMcpServers(),
  });
  const credentials = useQuery({
    queryKey: ["mcp-credentials"],
    queryFn: () => api.listMcpCredentials(),
  });
  const policies = useQuery({
    queryKey: ["mcp-credential-policies"],
    queryFn: () => api.listMcpCredentialPolicies(),
  });
  const toolsets = useQuery({
    queryKey: ["mcp-toolsets"],
    queryFn: () => api.listMcpToolsets(),
  });
  const agents = useQuery({
    queryKey: ["agents", "mcp-wizard"],
    queryFn: () => api.listAgents({}),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp-credentials"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp-credential-policies"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp-toolsets"] }),
    ]);
  };
  const create = useMutation({
    mutationFn: async (input: McpCreateInput) =>
      input.kind === "policy"
        ? api.createMcpCredentialPolicy(input.value)
        : api.createMcpToolset(input.value),
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      notify("MCP resource saved.");
    },
  });
  const discover = useMutation({
    mutationFn: ({
      serverId,
      policyVersionId,
    }: {
      serverId: string;
      policyVersionId: string;
    }) =>
      api.discoverMcpServer(serverId, {
        credentialPolicyVersionId: policyVersionId,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      notify("MCP tools discovered and snapshotted.");
    },
  });
  const rotate = useMutation({
    mutationFn: (input: {
      readonly credentialId: string;
      readonly value: RotateMcpCredentialInput;
    }) => api.rotateMcpCredential(input.credentialId, input.value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-credentials"] });
      setRotatingCredential(null);
      notify("MCP credential rotated.");
    },
  });
  // Tokens are cached per worker, so a fresh test is the only token status.
  const test = useMutation({
    mutationFn: (credentialId: string) => api.testMcpCredential(credentialId),
    onSuccess: (result) =>
      notify(
        result.ok
          ? `Token issued${result.expiresIn === null ? "" : ` for ${result.expiresIn}s`}${result.grantedScope ? ` with scope ${result.grantedScope}` : ""}.`
          : `Credential test failed: ${result.errorCode.replaceAll("_", " ")}.`,
      ),
    onError: (error) => notify(`Credential test failed: ${error.message}`),
  });
  const revoke = useMutation({
    mutationFn: (credentialId: string) => api.revokeMcpCredential(credentialId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-credentials"] });
      setRevokingCredential(null);
      notify("MCP credential revoked.");
    },
  });
  const pending =
    servers.isPending ||
    credentials.isPending ||
    policies.isPending ||
    toolsets.isPending;
  const error =
    servers.error ?? credentials.error ?? policies.error ?? toolsets.error;
  const encryptionConfigured =
    servers.data?.credentialEncryptionConfigured === true &&
    credentials.data?.credentialEncryptionConfigured === true;
  const liveServers = (servers.data?.data ?? []).filter(
    (server) => server.status !== "revoked",
  );
  const managingServer = liveServers.find(
    (server) => server.id === managingServerId,
  );
  // One dialog at a time: the details reopen when a nested one closes.
  const nestedOpen =
    dialog !== null ||
    rotatingCredential !== null ||
    revokingCredential !== null ||
    removingServer !== null;

  return (
    <Page>
      <PageHeader
        eyebrow="Configure"
        title="MCP connections"
        description="Add a remote MCP server, test it, choose its tools, and optionally attach it to an agent."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabled={!encryptionConfigured}
            onClick={() => setWizardOpen(true)}
          >
            Add MCP server
          </Button>
        }
      />
      {pending ? (
        <LoadingState label="Loading MCP connections" rows={5} />
      ) : null}
      {error ? <ErrorState error={error} retry={() => void refresh()} /> : null}
      {!pending && !error ? (
        <div className="stack">
          <Alert
            tone="info"
            role="status"
            title="Secrets stay outside the agent"
          >
            OAO injects credentials only at the approved HTTPS destination.
            Agents, prompts, tool arguments, events, and sandboxes receive no
            secret value.
          </Alert>
          {!encryptionConfigured ? (
            <Alert tone="danger" role="alert" title="Encryption key required">
              Configure OAO_CREDENTIAL_ENCRYPTION_KEY before adding MCP
              credentials.
            </Alert>
          ) : null}
          <ConnectionsPanel
            servers={liveServers}
            toolsets={toolsets.data?.data ?? []}
            disabled={!encryptionConfigured}
            onAdd={() => setWizardOpen(true)}
            onManage={(server) => setManagingServerId(server.id)}
          />
          <UnattachedCredentialsPanel
            credentials={(credentials.data?.data ?? []).filter(
              (credential) =>
                !(policies.data?.data ?? []).some(
                  (policy) =>
                    policy.credentialId === credential.id &&
                    liveServers.some((server) =>
                      policyCoversServer(policy, server),
                    ),
                ),
            )}
            onRevoke={setRevokingCredential}
          />
        </div>
      ) : null}
      {managingServer && !nestedOpen ? (
        <ConnectionDetailsDialog
          server={managingServer}
          policies={(policies.data?.data ?? []).filter((policy) =>
            policyCoversServer(policy, managingServer),
          )}
          credentials={credentials.data?.data ?? []}
          toolsets={(toolsets.data?.data ?? []).filter(
            (toolset) => toolset.serverId === managingServer.id,
          )}
          discovering={discover.isPending}
          discoverError={discover.error}
          testing={test.isPending}
          onClose={() => {
            discover.reset();
            setManagingServerId(null);
          }}
          onDiscover={(policyVersionId) =>
            discover.mutate({ serverId: managingServer.id, policyVersionId })
          }
          onTest={(credential) => test.mutate(credential.id)}
          onRotate={setRotatingCredential}
          onRevoke={setRevokingCredential}
          onCreate={(kind) => setDialog({ kind, server: managingServer })}
          onRemove={() => setRemovingServer(managingServer)}
        />
      ) : null}
      {wizardOpen ? (
        <McpSetupDialog
          agents={agents.data?.data ?? []}
          takenKeys={{
            servers: new Set(liveServers.map((item) => item.key)),
            credentials: new Set(
              (credentials.data?.data ?? []).map((item) => item.key),
            ),
            policies: new Set(
              (policies.data?.data ?? []).map((item) => item.key),
            ),
            toolsets: new Set(
              (toolsets.data?.data ?? []).map((item) => item.key),
            ),
          }}
          encryptionConfigured={encryptionConfigured}
          onClose={() => setWizardOpen(false)}
          onComplete={async () => {
            await refresh();
            await queryClient.invalidateQueries({ queryKey: ["agents"] });
            setWizardOpen(false);
            notify("MCP connection is ready.");
          }}
        />
      ) : null}
      {dialog ? (
        <McpCreateDialog
          kind={dialog.kind}
          server={dialog.server}
          credentials={credentials.data?.data ?? []}
          pending={create.isPending}
          error={create.error}
          onClose={() => {
            create.reset();
            setDialog(null);
          }}
          onSubmit={(input) => create.mutate(input)}
        />
      ) : null}
      {removingServer ? (
        <RemoveConnectionDialog
          server={removingServer}
          onClose={() => setRemovingServer(null)}
          onRemoved={async () => {
            await refresh();
            setRemovingServer(null);
            setManagingServerId(null);
            notify(`${removingServer.displayName} was removed.`);
          }}
        />
      ) : null}
      {rotatingCredential ? (
        <RotateCredentialDialog
          credential={rotatingCredential}
          pending={rotate.isPending}
          error={rotate.error}
          onClose={() => {
            rotate.reset();
            setRotatingCredential(null);
          }}
          onSubmit={(value) =>
            rotate.mutate({ credentialId: rotatingCredential.id, value })
          }
        />
      ) : null}
      {revokingCredential ? (
        <Dialog
          title={`Revoke ${revokingCredential.displayName}`}
          description="Revocation immediately blocks discovery and runtime calls that use this credential, and removes it from the list. It cannot be undone."
          onClose={() => {
            revoke.reset();
            setRevokingCredential(null);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            revoke.mutate(revokingCredential.id);
          }}
          footer={
            <>
              <Button
                onClick={() => setRevokingCredential(null)}
                disabled={revoke.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={revoke.isPending}
              >
                {revoke.isPending ? "Revoking…" : "Revoke credential"}
              </Button>
            </>
          }
        >
          {revoke.error ? <FormError>{revoke.error.message}</FormError> : null}
        </Dialog>
      ) : null}
    </Page>
  );
}

/**
 * Credentials no connection uses, for example ones kept when their
 * connection was removed. Shown only when there are any.
 */
function UnattachedCredentialsPanel({
  credentials,
  onRevoke,
}: {
  readonly credentials: readonly McpCredential[];
  readonly onRevoke: (credential: McpCredential) => void;
}) {
  if (credentials.length === 0) return null;
  return (
    <Panel
      title="Credentials not used by any connection"
      description="Kept when a connection was removed, or never connected. Revoke the ones you no longer need."
    >
      <TableCard
        label="Unattached MCP credentials table"
        caption="Credentials not used by any connection"
      >
        <thead>
          <tr>
            <th>Credential</th>
            <th>Destination</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {credentials.map((credential) => (
            <tr key={credential.id}>
              <td>
                <strong>{credential.displayName}</strong>
                <br />
                <small>
                  {credential.kind.replaceAll("_", " ")} ·{" "}
                  <span className="key-mask">
                    ••••{credential.credentialFingerprint.slice(-6)}
                  </span>
                </small>
              </td>
              <td>
                {credential.destination ? (
                  <code>
                    {credential.destination.origin}
                    {credential.destination.pathPrefix}
                  </code>
                ) : (
                  <StatusChip value="unpinned" />
                )}
              </td>
              <td>
                <Button
                  size="sm"
                  icon={<Trash2 size={13} />}
                  aria-label={`Revoke ${credential.displayName}`}
                  onClick={() => onRevoke(credential)}
                >
                  Revoke
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </Panel>
  );
}

/**
 * Everything one connection is made of: its tools, the policies and
 * credentials that authenticate to it, and its toolsets.
 */
function ConnectionDetailsDialog({
  server,
  policies,
  credentials,
  toolsets,
  discovering,
  discoverError,
  testing,
  onClose,
  onDiscover,
  onTest,
  onRotate,
  onRevoke,
  onCreate,
  onRemove,
}: {
  readonly server: McpServer;
  readonly policies: readonly McpCredentialPolicy[];
  readonly credentials: readonly McpCredential[];
  readonly toolsets: readonly McpToolset[];
  readonly discovering: boolean;
  readonly discoverError: Error | null;
  readonly testing: boolean;
  readonly onClose: () => void;
  readonly onDiscover: (policyVersionId: string) => void;
  readonly onTest: (credential: McpCredential) => void;
  readonly onRotate: (credential: McpCredential) => void;
  readonly onRevoke: (credential: McpCredential) => void;
  readonly onCreate: (kind: CreateDialog["kind"]) => void;
  readonly onRemove: () => void;
}) {
  const [policyVersionId, setPolicyVersionId] = useState(
    policies[0]?.latestVersionId ?? "",
  );
  return (
    <Dialog
      title={server.displayName}
      description="This connection's tools, authentication, and toolsets."
      wide
      onClose={onClose}
      footer={
        <>
          <Button
            variant="danger"
            icon={<Trash2 size={14} />}
            onClick={onRemove}
          >
            Remove
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="stack">
        <dl className="wizard-review">
          <div>
            <dt>Endpoint</dt>
            <dd>
              <code>{server.endpointUrl}</code>
            </dd>
          </div>
          <div>
            <dt>Transport</dt>
            <dd>{server.transport.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Discovered tools</dt>
            <dd>
              {server.tools.length > 0
                ? server.tools.map((tool) => tool.name).join(", ")
                : "None yet"}
            </dd>
          </div>
          <div>
            <dt>Last discovered</dt>
            <dd>
              {server.lastDiscoveredAt
                ? new Date(server.lastDiscoveredAt).toLocaleString()
                : "Never"}
            </dd>
          </div>
        </dl>
        <span className="row">
          <Select
            aria-label="Credential policy for discovery"
            value={policyVersionId}
            onChange={(event) => setPolicyVersionId(event.currentTarget.value)}
          >
            <option value="">Select policy</option>
            {policies.map((policy) => (
              <option
                key={policy.latestVersionId}
                value={policy.latestVersionId}
              >
                {policy.displayName}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            icon={<RefreshCw size={13} />}
            loading={discovering}
            disabled={!policyVersionId}
            onClick={() => onDiscover(policyVersionId)}
          >
            Discover tools
          </Button>
        </span>
        {discoverError ? <FormError>{discoverError.message}</FormError> : null}

        <span className="row">
          <h3>Authentication</h3>
          <Button
            size="sm"
            icon={<Plus size={13} />}
            disabled={credentials.length === 0}
            onClick={() => onCreate("policy")}
          >
            Add policy
          </Button>
        </span>
        {policies.length === 0 ? (
          <small>No credential policy covers this endpoint.</small>
        ) : (
          <TableCard
            label="Connection authentication table"
            caption="Policies and credentials for this connection"
          >
            <thead>
              <tr>
                <th>Policy</th>
                <th>Credential</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => {
                const credential = credentials.find(
                  (item) => item.id === policy.credentialId,
                );
                return (
                  <tr key={policy.id}>
                    <td>
                      <strong>{policy.displayName}</strong>
                      <br />
                      <code>
                        {policy.exactOrigin}
                        {policy.pathPrefix}
                      </code>
                      <br />
                      <small>
                        {policy.timeoutMs / 1000}s ·{" "}
                        {Math.round(policy.maximumResponseBytes / 1024)} KiB
                        {policy.forwardCallContext
                          ? " · forwards call context"
                          : ""}
                      </small>
                    </td>
                    <td>
                      {credential ? (
                        <>
                          <strong>{credential.displayName}</strong>
                          <br />
                          <small>
                            {credential.kind.replaceAll("_", " ")} ·{" "}
                            <span className="key-mask">
                              ••••{credential.credentialFingerprint.slice(-6)}
                            </span>{" "}
                            · v{credential.credentialVersion}
                          </small>
                          {credential.destination ? null : (
                            <>
                              <br />
                              <StatusChip value="unpinned" />
                            </>
                          )}
                        </>
                      ) : (
                        <small>Credential revoked</small>
                      )}
                    </td>
                    <td>
                      {credential ? (
                        <span className="row">
                          {credential.oauth ? (
                            <Button
                              size="sm"
                              icon={<Check size={13} />}
                              aria-label={`Test ${credential.displayName}`}
                              disabled={testing}
                              onClick={() => onTest(credential)}
                            >
                              Test
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            icon={<RefreshCw size={13} />}
                            aria-label={`Rotate ${credential.displayName}`}
                            onClick={() => onRotate(credential)}
                          >
                            Rotate
                          </Button>
                          <Button
                            size="sm"
                            icon={<Trash2 size={13} />}
                            aria-label={`Revoke ${credential.displayName}`}
                            onClick={() => onRevoke(credential)}
                          >
                            Revoke
                          </Button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableCard>
        )}

        <span className="row">
          <h3>Toolsets</h3>
          <Button
            size="sm"
            icon={<Plus size={13} />}
            disabled={server.tools.length === 0}
            onClick={() => onCreate("toolset")}
          >
            Create toolset
          </Button>
        </span>
        {toolsets.length === 0 ? (
          <small>No toolset exposes this connection&apos;s tools yet.</small>
        ) : (
          <TableCard
            label="Connection toolsets table"
            caption="Restricted toolsets for this connection"
          >
            <thead>
              <tr>
                <th>Toolset</th>
                <th>Tools</th>
              </tr>
            </thead>
            <tbody>
              {toolsets.map((toolset) => (
                <tr key={toolset.id}>
                  <td>
                    <strong>{toolset.displayName}</strong>
                    <br />
                    <code>{toolset.key}</code>
                    {toolset.serverVersionId !== server.latestVersionId ? (
                      <>
                        <br />
                        <small>Pinned to an earlier server version</small>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {toolset.tools
                      .map(
                        (tool) =>
                          `${tool.remoteToolName}${tool.approval === "never" ? "" : " (approval)"}`,
                      )
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </div>
    </Dialog>
  );
}

function ConnectionsPanel({
  servers,
  toolsets,
  disabled,
  onAdd,
  onManage,
}: {
  readonly servers: readonly McpServer[];
  readonly toolsets: readonly McpToolset[];
  readonly disabled: boolean;
  readonly onAdd: () => void;
  readonly onManage: (server: McpServer) => void;
}) {
  return (
    <Panel
      title="Connections"
      description="Each connection combines one remote server with discovered tools and one or more restricted toolsets."
      actions={
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={14} />}
          disabled={disabled}
          onClick={onAdd}
        >
          Add MCP server
        </Button>
      }
    >
      {servers.length === 0 ? (
        <EmptyState
          icon="⌁"
          title="No MCP connections"
          description="Use the guided setup to connect a server, test authentication, and choose the tools agents may use."
          action={
            <Button variant="primary" disabled={disabled} onClick={onAdd}>
              Add MCP server
            </Button>
          }
        />
      ) : (
        <div className="cards-grid">
          {servers.map((server) => {
            const connectionToolsets = toolsets.filter(
              (toolset) => toolset.serverId === server.id,
            );
            return (
              <article
                className="resource-card mcp-connection-card"
                key={server.id}
              >
                <header className="row">
                  <h2>{server.displayName}</h2>
                  <StatusChip
                    value={server.tools.length > 0 ? "ready" : server.status}
                  />
                  <Button
                    size="sm"
                    aria-label={`Manage ${server.displayName}`}
                    onClick={() => onManage(server)}
                  >
                    Manage
                  </Button>
                </header>
                <code>{server.endpointUrl}</code>
                <dl>
                  <div>
                    <dt>Transport</dt>
                    <dd>{server.transport.replaceAll("_", " ")}</dd>
                  </div>
                  <div>
                    <dt>Discovered tools</dt>
                    <dd>{server.tools.length}</dd>
                  </div>
                  <div>
                    <dt>Restricted toolsets</dt>
                    <dd>{connectionToolsets.length}</dd>
                  </div>
                </dl>
                {server.lastDiscoveredAt ? (
                  <small>
                    Last tested{" "}
                    {new Date(server.lastDiscoveredAt).toLocaleString()}
                  </small>
                ) : (
                  <small>Run discovery to finish this connection.</small>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

interface McpWizardResources {
  readonly server?: McpServer;
  readonly credential?: McpCredential;
  readonly policy?: McpCredentialPolicy;
  readonly toolset?: McpToolset;
}

function slugifyMcpKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 90);
}

function endpointPolicy(
  value: string,
  transport: CreateMcpServerInput["transport"],
): { readonly exactOrigin: string; readonly pathPrefix: string } | null {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:") return null;
    return {
      exactOrigin: endpoint.origin,
      pathPrefix: transport === "legacy_sse" ? "/" : endpoint.pathname || "/",
    };
  } catch {
    return null;
  }
}

/**
 * Keys live resources already use. Removed ones free their keys, but a kept
 * credential or policy still holds its own.
 */
interface TakenMcpKeys {
  readonly servers: ReadonlySet<string>;
  readonly credentials: ReadonlySet<string>;
  readonly policies: ReadonlySet<string>;
  readonly toolsets: ReadonlySet<string>;
}

/** The first of `base`, `base-2`, `base-3`, … that no live resource uses. */
function freeKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1)
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

function McpSetupDialog({
  agents,
  takenKeys,
  encryptionConfigured,
  onClose,
  onComplete,
}: {
  readonly agents: readonly AgentSummary[];
  readonly takenKeys: TakenMcpKeys;
  readonly encryptionConfigured: boolean;
  readonly onClose: () => void;
  readonly onComplete: () => void | Promise<void>;
}) {
  const api = useApi();
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [endpointUrl, setEndpointUrl] = useState("");
  const [transport, setTransport] =
    useState<CreateMcpServerInput["transport"]>("streamable_http");
  const [credentialKind, setCredentialKind] =
    useState<CreateMcpCredentialInput["kind"]>("static_bearer");
  const [headerName, setHeaderName] = useState("X-API-Key");
  const [secret, setSecret] = useState("");
  // Discovery is kept with the endpoint it was run for, so editing the
  // endpoint afterwards can never pin the credential to the old resource.
  const [discovered, setDiscovered] = useState<{
    readonly endpointUrl: string;
    readonly discovery: McpAuthorizationDiscovery;
  } | null>(null);
  const currentEndpoint = useRef(endpointUrl);
  currentEndpoint.current = endpointUrl;
  const authorization =
    discovered?.endpointUrl === endpointUrl ? discovered.discovery : null;
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [tokenEndpointAuthMethod, setTokenEndpointAuthMethod] =
    useState<McpTokenEndpointAuthMethod>("client_secret_post");
  const [scope, setScope] = useState("");
  const [sendResource, setSendResource] = useState(true);
  const [exactOrigin, setExactOrigin] = useState("");
  const [pathPrefix, setPathPrefix] = useState("/");
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [maximumResponseKiB, setMaximumResponseKiB] = useState(1024);
  const [forwardCallContext, setForwardCallContext] = useState(false);
  const [selectedTools, setSelectedTools] = useState<readonly string[]>([]);
  const [approvals, setApprovals] = useState<
    Record<string, "never" | "always">
  >({});
  const [agentId, setAgentId] = useState("");
  const [namespace, setNamespace] = useState("");
  const [resources, setResources] = useState<McpWizardResources>({});
  const resourcesRef = useRef<McpWizardResources>({});
  const remember = (next: Partial<McpWizardResources>) => {
    const merged = { ...resourcesRef.current, ...next };
    resourcesRef.current = merged;
    setResources(merged);
    return merged;
  };
  const derivedPolicy = endpointPolicy(endpointUrl, transport);
  const validKey =
    key.length <= 90 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(key);
  const keyTaken = resources.server === undefined && takenKeys.servers.has(key);
  const serverReady =
    displayName.trim().length > 0 &&
    validKey &&
    !keyTaken &&
    derivedPolicy !== null;
  const oauthSelected = credentialKind === "oauth_client_credentials";
  const authorizationServer = authorization?.authorizationServers.find(
    (entry) => entry.issuer === issuer && entry.problem === null,
  );
  const oauthReady =
    !oauthSelected ||
    resources.credential !== undefined ||
    (authorizationServer?.tokenEndpoint !== null &&
      authorizationServer !== undefined &&
      clientId.trim().length > 0 &&
      /^[!#-[\]-~]+(?: [!#-[\]-~]+)*$/u.test(scope));
  const authenticationReady =
    encryptionConfigured &&
    (resources.credential !== undefined || secret.length >= 8) &&
    oauthReady &&
    exactOrigin.startsWith("https://") &&
    pathPrefix.startsWith("/") &&
    timeoutMs >= 1_000 &&
    timeoutMs <= 120_000 &&
    maximumResponseKiB >= 1 &&
    maximumResponseKiB <= 10_240 &&
    (credentialKind !== "api_key_header" || headerName.trim().length > 0);

  const discoverAuthorization = useMutation({
    mutationFn: (endpoint: string) =>
      api.discoverMcpAuthorization({ endpointUrl: endpoint }),
    onSuccess: (discovery, endpoint) => {
      // A reply for an endpoint the operator has since changed is ignored.
      if (endpoint !== currentEndpoint.current) return;
      setDiscovered({ endpointUrl: endpoint, discovery });
      const usable = discovery.authorizationServers.filter(
        (entry) => entry.problem === null,
      );
      // Never pick a server silently when several are listed.
      setIssuer(usable.length === 1 ? usable[0]!.issuer : "");
      setScope(discovery.challengeScope ?? discovery.scopesSupported.join(" "));
      // The credential, and so the policy, is pinned to the resource.
      const destination = mcpResourceDestination(discovery.resource);
      setExactOrigin(destination.origin);
      setPathPrefix(destination.pathPrefix);
    },
  });
  const steps = ["Server", "Authentication", "Connect", "Tools", "Agent"];

  const provision = useMutation({
    mutationFn: async () => {
      let current = resourcesRef.current;
      if (!current.server) {
        const server = await api.createMcpServer({
          key,
          displayName: displayName.trim(),
          endpointUrl,
          transport,
        });
        current = remember({ server });
      }
      if (!current.credential) {
        const base = {
          key: freeKey(`${key}-credential`, takenKeys.credentials),
          displayName: `${displayName.trim()} credential`,
          secret,
        };
        const destination = { origin: exactOrigin, pathPrefix };
        const credential = await api.createMcpCredential(
          credentialKind === "oauth_client_credentials"
            ? {
                ...base,
                kind: credentialKind,
                headerName: null,
                oauth: {
                  resource: authorization!.resource,
                  resourceMetadataUrl: authorization!.resourceMetadataUrl,
                  issuer: authorizationServer!.issuer,
                  tokenEndpoint: authorizationServer!.tokenEndpoint!,
                  clientId: clientId.trim(),
                  tokenEndpointAuthMethod,
                  scope,
                  sendResource,
                },
              }
            : credentialKind === "api_key_header"
              ? {
                  ...base,
                  kind: credentialKind,
                  headerName: headerName.trim(),
                  destination,
                }
              : {
                  ...base,
                  kind: credentialKind,
                  headerName: null,
                  destination,
                },
        );
        current = remember({ credential });
        setSecret("");
      }
      if (!current.policy) {
        const policy = await api.createMcpCredentialPolicy({
          key: freeKey(`${key}-policy`, takenKeys.policies),
          displayName: `${displayName.trim()} egress policy`,
          credentialId: current.credential!.id,
          exactOrigin,
          pathPrefix,
          timeoutMs,
          maximumResponseBytes: maximumResponseKiB * 1024,
          forwardCallContext,
        });
        current = remember({ policy });
      }
      const server = await api.discoverMcpServer(current.server!.id, {
        credentialPolicyVersionId: current.policy!.latestVersionId,
      });
      remember({ server });
      return server;
    },
    onSuccess: (server) => {
      setSelectedTools([]);
      setApprovals(
        Object.fromEntries(server.tools.map((tool) => [tool.name, "always"])),
      );
      setStep(3);
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      let current = resourcesRef.current;
      if (!current.server || !current.policy)
        throw new Error("Test the MCP connection before finishing setup.");
      const policy = current.policy;
      if (!current.toolset) {
        const toolset = await api.createMcpToolset({
          key: freeKey(`${key}-tools`, takenKeys.toolsets),
          displayName: `${displayName.trim()} tools`,
          serverVersionId: current.server.latestVersionId,
          tools: selectedTools.map((remoteToolName) => ({
            remoteToolName,
            approval: approvals[remoteToolName] ?? "always",
          })),
        });
        current = remember({ toolset });
      }
      if (agentId) {
        const agent = await api.getAgent(agentId);
        const latest =
          agent.versions.find(
            (version) => version.id === agent.latestVersionId,
          ) ?? agent.versions[0];
        if (!latest) throw new Error("The selected agent has no version.");
        const bindings = latest.config.mcpBindings ?? [];
        const existing = bindings.find(
          (binding) => binding.namespace === namespace,
        );
        if (
          existing &&
          (existing.toolsetVersionId !== current.toolset!.latestVersionId ||
            existing.credentialPolicyVersionId !== policy.latestVersionId)
        )
          throw new Error(
            `The selected agent already uses the namespace ${namespace}.`,
          );
        if (!existing) {
          const config: AgentVersionConfig = {
            ...latest.config,
            mcpBindings: [
              ...bindings,
              {
                toolsetVersionId: current.toolset!.latestVersionId,
                credentialPolicyVersionId: policy.latestVersionId,
                namespace,
              },
            ],
          };
          await api.publishAgentVersion(agent.id, config);
        }
      }
    },
    onSuccess: onComplete,
  });

  const operationPending = provision.isPending || finish.isPending;
  const stepReady = [
    serverReady,
    authenticationReady,
    resources.server?.tools.length ? true : false,
    selectedTools.length > 0,
    !agentId || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(namespace),
  ];
  const next = () => {
    if (step === 0 && serverReady) {
      // An OAuth credential's policy is its resource; others follow the URL.
      const policy =
        oauthSelected && authorization
          ? mcpResourceDestination(authorization.resource)
          : {
              origin: derivedPolicy!.exactOrigin,
              pathPrefix: derivedPolicy!.pathPrefix,
            };
      setExactOrigin(policy.origin);
      setPathPrefix(policy.pathPrefix);
      setNamespace(key.replaceAll("-", "_").slice(0, 64));
      setStep(1);
    } else if (step === 1 && authenticationReady) setStep(2);
    else if (step === 3 && selectedTools.length > 0) setStep(4);
  };
  const back = () => {
    if (step === 1 && resources.server) return;
    if (step === 2 && resources.policy) return;
    setStep((current) => Math.max(0, current - 1));
  };
  const canGoBack =
    step > 0 &&
    !(step === 1 && resources.server) &&
    !(step === 2 && resources.policy);

  return (
    <Dialog
      title="Add MCP server"
      description="Follow the setup once; OAO creates the secure versioned resources behind the connection."
      wide
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (step === 2) provision.mutate();
        else if (step === 4) finish.mutate();
        else next();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={operationPending}>
            Cancel
          </Button>
          {canGoBack ? (
            <Button
              icon={<ArrowLeft size={15} />}
              disabled={operationPending}
              onClick={back}
            >
              Back
            </Button>
          ) : null}
          {step === 2 ? (
            <Button
              type="submit"
              variant="primary"
              loading={provision.isPending}
              disabled={!authenticationReady || provision.isPending}
            >
              {provision.isPending ? "Connecting…" : "Test and discover"}
            </Button>
          ) : step === 4 ? (
            <Button
              type="submit"
              variant="primary"
              loading={finish.isPending}
              disabled={!stepReady[4] || finish.isPending}
            >
              {finish.isPending ? "Finishing…" : "Finish setup"}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              disabled={!stepReady[step] || operationPending}
            >
              Next
            </Button>
          )}
        </>
      }
    >
      <ol className="setup-steps" aria-label="MCP setup progress">
        {steps.map((label, index) => (
          <li key={label}>
            <button
              type="button"
              aria-current={index === step ? "step" : undefined}
              disabled={
                operationPending ||
                index > step ||
                (index === 0 && resources.server !== undefined) ||
                (index === 1 && resources.policy !== undefined)
              }
              onClick={() => setStep(index)}
            >
              <span className="setup-steps__num" aria-hidden="true">
                {index < step ? <Check size={12} /> : index + 1}
              </span>
              {label}
            </button>
          </li>
        ))}
      </ol>
      {step === 0 ? (
        <div className="stack">
          <Field label="Display name" hint="Shown on the Connections page.">
            <Input
              required
              autoFocus
              placeholder="LangSmith observability"
              value={displayName}
              onChange={(event) => {
                const nextName = event.currentTarget.value;
                setDisplayName(nextName);
                if (!keyEdited) setKey(slugifyMcpKey(nextName));
              }}
            />
          </Field>
          <Field
            label="Connection key"
            {...(!key || validKey
              ? keyTaken
                ? { error: "Another connection already uses this key." }
                : {}
              : { error: "Use a lowercase, hyphen-separated key." })}
          >
            <Input
              required
              value={key}
              onChange={(event) => {
                setKey(event.currentTarget.value);
                setKeyEdited(true);
              }}
            />
          </Field>
          <Field label="HTTPS MCP endpoint">
            <Input
              required
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.currentTarget.value)}
            />
          </Field>
          <Field label="Transport">
            <Select
              value={transport}
              onChange={(event) =>
                setTransport(
                  event.currentTarget
                    .value as CreateMcpServerInput["transport"],
                )
              }
            >
              <option value="streamable_http">Streamable HTTP</option>
              <option value="legacy_sse">Legacy SSE</option>
            </Select>
          </Field>
        </div>
      ) : null}
      {step === 1 ? (
        <div className="stack">
          <Alert tone="info" role="status" title="Credential stays write-only">
            OAO encrypts this value immediately and pins it to the origin and
            path prefix under Security policy and limits. It is never shown
            again, and no later policy can send it anywhere else.
          </Alert>
          <Field label="Authentication type">
            <Select
              value={credentialKind}
              disabled={resources.credential !== undefined}
              onChange={(event) => {
                const next = event.currentTarget
                  .value as CreateMcpCredentialInput["kind"];
                setCredentialKind(next);
                const destination =
                  next === "oauth_client_credentials" && authorization
                    ? mcpResourceDestination(authorization.resource)
                    : derivedPolicy
                      ? {
                          origin: derivedPolicy.exactOrigin,
                          pathPrefix: derivedPolicy.pathPrefix,
                        }
                      : null;
                if (destination) {
                  setExactOrigin(destination.origin);
                  setPathPrefix(destination.pathPrefix);
                }
              }}
            >
              <option value="static_bearer">Bearer token</option>
              <option value="api_key_header">API-key header</option>
              <option value="oauth_client_credentials">
                OAuth client credentials
              </option>
            </Select>
          </Field>
          {credentialKind === "api_key_header" ? (
            <Field label="Header name">
              <Input
                value={headerName}
                disabled={resources.credential !== undefined}
                onChange={(event) => setHeaderName(event.currentTarget.value)}
              />
            </Field>
          ) : null}
          {oauthSelected ? (
            <OAuthAuthorizationFields
              discovery={authorization}
              discovering={discoverAuthorization.isPending}
              error={discoverAuthorization.error}
              locked={resources.credential !== undefined}
              issuer={issuer}
              clientId={clientId}
              tokenEndpointAuthMethod={tokenEndpointAuthMethod}
              scope={scope}
              sendResource={sendResource}
              onDiscover={() => discoverAuthorization.mutate(endpointUrl)}
              onIssuer={setIssuer}
              onClientId={setClientId}
              onTokenEndpointAuthMethod={setTokenEndpointAuthMethod}
              onScope={setScope}
              onSendResource={setSendResource}
            />
          ) : null}
          <Field
            label={
              resources.credential
                ? "Secret stored"
                : oauthSelected
                  ? "Client secret"
                  : "Secret"
            }
            hint={
              resources.credential
                ? "The encrypted credential was saved and cannot be displayed."
                : oauthSelected
                  ? "Write-only. OAO only ever sends it to the confirmed token endpoint."
                  : "At least 8 characters."
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={secret}
              disabled={resources.credential !== undefined}
              placeholder={resources.credential ? "••••••••" : undefined}
              onChange={(event) => setSecret(event.currentTarget.value)}
            />
          </Field>
          <details className="policy-details">
            <summary>Security policy and limits</summary>
            <div className="policy-body stack">
              <Field
                label="Exact HTTPS origin"
                hint="The credential is pinned to this origin and path prefix."
              >
                <Input
                  type="url"
                  value={exactOrigin}
                  disabled={
                    oauthSelected ||
                    resources.credential !== undefined ||
                    resources.policy !== undefined
                  }
                  onChange={(event) =>
                    setExactOrigin(event.currentTarget.value)
                  }
                />
              </Field>
              <Field
                label="Allowed path prefix"
                hint={
                  transport === "legacy_sse"
                    ? "Legacy SSE may advertise a separate message path, so the default is /."
                    : "Derived from the MCP endpoint."
                }
              >
                <Input
                  value={pathPrefix}
                  disabled={
                    oauthSelected ||
                    resources.credential !== undefined ||
                    resources.policy !== undefined
                  }
                  onChange={(event) => setPathPrefix(event.currentTarget.value)}
                />
              </Field>
              <div className="form-grid">
                <Field label="Timeout (ms)">
                  <Input
                    type="number"
                    min={1_000}
                    max={120_000}
                    value={timeoutMs}
                    disabled={resources.policy !== undefined}
                    onChange={(event) =>
                      setTimeoutMs(Number(event.currentTarget.value))
                    }
                  />
                </Field>
                <Field label="Maximum response (KiB)">
                  <Input
                    type="number"
                    min={1}
                    max={10_240}
                    value={maximumResponseKiB}
                    disabled={resources.policy !== undefined}
                    onChange={(event) =>
                      setMaximumResponseKiB(Number(event.currentTarget.value))
                    }
                  />
                </Field>
              </div>
              <CallContextToggle
                checked={forwardCallContext}
                disabled={resources.policy !== undefined}
                onChange={setForwardCallContext}
              />
            </div>
          </details>
        </div>
      ) : null}
      {step === 2 ? (
        <div className="stack">
          <Alert tone="info" role="status" title="Ready to test">
            OAO will save the encrypted connection, enforce{" "}
            <code>
              {exactOrigin}
              {pathPrefix}
            </code>
            , connect without following redirects, and snapshot the
            server&apos;s tool schemas.
          </Alert>
          <dl className="wizard-review">
            <div>
              <dt>Server</dt>
              <dd>{displayName}</dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd>
                <code>{endpointUrl}</code>
              </dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>
                {credentialKind === "static_bearer"
                  ? "Bearer token"
                  : credentialKind === "oauth_client_credentials"
                    ? "OAuth client credentials"
                    : headerName}
              </dd>
            </div>
            {oauthSelected && authorizationServer ? (
              <>
                <div>
                  <dt>Issuer</dt>
                  <dd>
                    <code>{authorizationServer.issuer}</code>
                  </dd>
                </div>
                <div>
                  <dt>Token endpoint</dt>
                  <dd>
                    <code>{authorizationServer.tokenEndpoint}</code>
                  </dd>
                </div>
                <div>
                  <dt>Client</dt>
                  <dd>
                    <code>{clientId}</code> ·{" "}
                    {tokenEndpointAuthMethod.replaceAll("_", " ")}
                  </dd>
                </div>
                <div>
                  <dt>Scope</dt>
                  <dd>
                    <code>{scope}</code>
                  </dd>
                </div>
              </>
            ) : null}
            <div>
              <dt>Destination</dt>
              <dd>
                <code>
                  {exactOrigin}
                  {pathPrefix}
                </code>
              </dd>
            </div>
          </dl>
          {resources.server || resources.credential || resources.policy ? (
            <Alert tone="warning" role="status">
              Setup progress was saved. Retry continues from the first
              incomplete resource instead of creating duplicates.
            </Alert>
          ) : null}
          {provision.error ? (
            <FormError>{provision.error.message}</FormError>
          ) : null}
        </div>
      ) : null}
      {step === 3 ? (
        <div className="stack">
          <Alert tone="success" role="status" title="Connection succeeded">
            Discovered {resources.server?.tools.length ?? 0} tools. Select only
            the tools this connection should expose.
          </Alert>
          <div className="field-row">
            {resources.server?.tools.map((tool) => (
              <div className="resource-card" key={tool.name}>
                <CheckboxRow
                  label={tool.title ?? tool.name}
                  description={tool.description}
                  checked={selectedTools.includes(tool.name)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedTools((current) =>
                      checked
                        ? [...current, tool.name]
                        : current.filter((name) => name !== tool.name),
                    );
                  }}
                />
                {selectedTools.includes(tool.name) ? (
                  <Field label={`Approval for ${tool.name}`}>
                    <Select
                      value={approvals[tool.name] ?? "always"}
                      onChange={(event) => {
                        const approval = event.currentTarget.value as
                          "never" | "always";
                        setApprovals((current) => ({
                          ...current,
                          [tool.name]: approval,
                        }));
                      }}
                    >
                      <option value="always">Always require approval</option>
                      <option value="never">Run without approval</option>
                    </Select>
                  </Field>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {step === 4 ? (
        <div className="stack">
          <Field
            label="Attach to agent"
            hint="Optional. You can also attach it later from Agents."
          >
            <Select
              value={agentId}
              onChange={(event) => setAgentId(event.currentTarget.value)}
            >
              <option value="">Do not attach yet</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
          </Field>
          {agentId ? (
            <Field
              label="Tool namespace"
              hint="Remote tools appear as mcp__namespace__tool_name."
              {...(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(namespace)
                ? {}
                : {
                    error: "Use lowercase letters, numbers, and underscores.",
                  })}
            >
              <Input
                value={namespace}
                onChange={(event) => setNamespace(event.currentTarget.value)}
              />
            </Field>
          ) : null}
          <dl className="wizard-review">
            <div>
              <dt>Connection</dt>
              <dd>{displayName}</dd>
            </div>
            <div>
              <dt>Allowed tools</dt>
              <dd>{selectedTools.length}</dd>
            </div>
            <div>
              <dt>Agent</dt>
              <dd>
                {agents.find((agent) => agent.id === agentId)?.name ??
                  "Not attached"}
              </dd>
            </div>
          </dl>
          {finish.error ? <FormError>{finish.error.message}</FormError> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

const AUTHORIZATION_SERVER_PROBLEMS: Record<
  NonNullable<
    McpAuthorizationDiscovery["authorizationServers"][number]["problem"]
  >,
  string
> = {
  metadata_unavailable: "metadata unavailable",
  issuer_mismatch: "issuer does not match",
  token_endpoint_missing: "no token endpoint",
  token_endpoint_insecure: "token endpoint is not HTTPS",
  token_endpoint_unreachable: "token endpoint is not public",
};

/**
 * Runs credential-free authorization discovery and shows what it found for
 * the operator to confirm before entering the client ID and secret.
 */
function OAuthAuthorizationFields({
  discovery,
  discovering,
  error,
  locked,
  issuer,
  clientId,
  tokenEndpointAuthMethod,
  scope,
  sendResource,
  onDiscover,
  onIssuer,
  onClientId,
  onTokenEndpointAuthMethod,
  onScope,
  onSendResource,
}: {
  readonly discovery: McpAuthorizationDiscovery | null;
  readonly discovering: boolean;
  readonly error: Error | null;
  readonly locked: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenEndpointAuthMethod: McpTokenEndpointAuthMethod;
  readonly scope: string;
  readonly sendResource: boolean;
  readonly onDiscover: () => void;
  readonly onIssuer: (value: string) => void;
  readonly onClientId: (value: string) => void;
  readonly onTokenEndpointAuthMethod: (
    value: McpTokenEndpointAuthMethod,
  ) => void;
  readonly onScope: (value: string) => void;
  readonly onSendResource: (value: boolean) => void;
}) {
  const selected = discovery?.authorizationServers.find(
    (server) => server.issuer === issuer,
  );
  return (
    <div className="stack">
      <span className="row">
        <Button
          icon={<RefreshCw size={14} />}
          loading={discovering}
          disabled={locked}
          onClick={onDiscover}
        >
          {discovery ? "Discover again" : "Discover authorization"}
        </Button>
        <small>
          Reads the server&apos;s public OAuth metadata. No credential is sent.
        </small>
      </span>
      {error ? <FormError>{error.message}</FormError> : null}
      {discovery ? (
        <>
          <dl className="wizard-review">
            <div>
              <dt>Resource</dt>
              <dd>
                <code>{discovery.resource}</code>
              </dd>
            </div>
            <div>
              <dt>Resource metadata</dt>
              <dd>
                <code>{discovery.resourceMetadataUrl}</code>
              </dd>
            </div>
            <div>
              <dt>Scopes supported</dt>
              <dd>{discovery.scopesSupported.join(" ") || "Not listed"}</dd>
            </div>
          </dl>
          <Field
            label="Authorization server"
            hint="Confirm the issuer that registered this client."
          >
            <Select
              value={issuer}
              disabled={locked}
              onChange={(event) => onIssuer(event.currentTarget.value)}
            >
              <option value="">Select an authorization server</option>
              {discovery.authorizationServers.map((server) => (
                <option
                  key={server.issuer}
                  value={server.issuer}
                  disabled={server.problem !== null}
                >
                  {server.problem
                    ? `${server.issuer} (${AUTHORIZATION_SERVER_PROBLEMS[server.problem]})`
                    : server.issuer}
                </option>
              ))}
            </Select>
          </Field>
          {selected && selected.problem === null ? (
            <dl className="wizard-review">
              <div>
                <dt>Token endpoint</dt>
                <dd>
                  <code>{selected.tokenEndpoint}</code>
                </dd>
              </div>
              <div>
                <dt>Client authentication methods</dt>
                <dd>
                  {selected.tokenEndpointAuthMethodsSupported?.join(", ") ??
                    "Not listed"}
                </dd>
              </div>
              <div>
                <dt>Grant types</dt>
                <dd>
                  {selected.grantTypesSupported?.join(", ") ?? "Not listed"}
                </dd>
              </div>
            </dl>
          ) : null}
          <Field
            label="Client ID"
            hint="The pre-registered machine-to-machine client."
          >
            <Input
              autoComplete="off"
              value={clientId}
              disabled={locked}
              onChange={(event) => onClientId(event.currentTarget.value)}
            />
          </Field>
          <Field label="Client authentication">
            <Select
              value={tokenEndpointAuthMethod}
              disabled={locked}
              onChange={(event) =>
                onTokenEndpointAuthMethod(
                  event.currentTarget.value as McpTokenEndpointAuthMethod,
                )
              }
            >
              <option value="client_secret_post">
                Client secret in the request body
              </option>
              <option value="client_secret_basic">
                Client secret in HTTP Basic
              </option>
            </Select>
          </Field>
          <Field label="Scope" hint="Space-separated OAuth scopes.">
            <Input
              value={scope}
              disabled={locked}
              onChange={(event) => onScope(event.currentTarget.value)}
            />
          </Field>
          <CheckboxRow
            label="Send the resource parameter"
            description="MCP requires it (RFC 8707). Turn it off only for an authorization server that rejects it."
            checked={sendResource}
            disabled={locked}
            onChange={(event) => onSendResource(event.currentTarget.checked)}
          />
        </>
      ) : null}
    </div>
  );
}

/** Opt-in for the X-OAO-* call identity headers on one policy version. */
function CallContextToggle({
  checked,
  disabled,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <CheckboxRow
      label="Forward call context"
      description="Sends the organization, project, session, run, tool-call ID, and a hash of the run key as X-OAO-* headers, so the server can bind calls to work it started. The server sees these OAO identifiers."
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

/**
 * Confirms removing a connection. Removal is refused while a live agent
 * uses it, so the dialog lists those agents instead of a Remove button.
 */
function RemoveConnectionDialog({
  server,
  onClose,
  onRemoved,
}: {
  readonly server: McpServer;
  readonly onClose: () => void;
  readonly onRemoved: () => void | Promise<void>;
}) {
  const api = useApi();
  const [revokeCredentials, setRevokeCredentials] = useState(true);
  const usage = useQuery({
    queryKey: ["mcp-server-usage", server.id],
    queryFn: () => api.getMcpServerUsage(server.id),
  });
  const remove = useMutation({
    mutationFn: () =>
      api.removeMcpServer(server.id, { keepCredentials: !revokeCredentials }),
    onSuccess: onRemoved,
  });
  const data = usage.data;
  const inUse =
    data !== undefined &&
    (data.agents.length > 0 || data.otherProjects.length > 0);
  const related = data ? [...data.credentialPolicies, ...data.credentials] : [];
  return (
    <Dialog
      title={`Remove ${server.displayName}`}
      description="Removing a connection revokes it and takes it off this page. Past sessions and the audit trail keep their history, but no agent can call its tools again, and its key can be used again."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (data && !inUse) remove.mutate();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={remove.isPending}>
            {inUse ? "Close" : "Cancel"}
          </Button>
          {inUse ? null : (
            <Button
              type="submit"
              variant="danger"
              icon={<Trash2 size={14} />}
              loading={remove.isPending}
              disabled={!data}
            >
              Remove connection
            </Button>
          )}
        </>
      }
    >
      {usage.isPending ? (
        <LoadingState label="Checking what uses this connection" rows={2} />
      ) : null}
      {usage.error ? <FormError>{usage.error.message}</FormError> : null}
      {data && inUse ? (
        <Alert tone="warning" role="alert" title="Still in use">
          {data.agents.length > 0 ? (
            <>
              These agents still use this connection:{" "}
              <strong>
                {data.agents.map((agent) => agent.name).join(", ")}
              </strong>
              .{" "}
            </>
          ) : null}
          {data.otherProjects.length > 0 ? (
            <>
              Agents in other projects use it too:{" "}
              {data.otherProjects
                .map(
                  (project) =>
                    `${project.name} (${project.agentCount} ${project.agentCount === 1 ? "agent" : "agents"})`,
                )
                .join(", ")}
              .{" "}
            </>
          ) : null}
          Publish agent versions without it, or delete those agents, before
          removing the connection.
        </Alert>
      ) : null}
      {data && !inUse ? (
        <div className="stack">
          <dl className="wizard-review">
            <div>
              <dt>Server</dt>
              <dd>
                <code>{server.endpointUrl}</code>
              </dd>
            </div>
            <div>
              <dt>Toolsets revoked</dt>
              <dd>
                {data.toolsets.length > 0
                  ? data.toolsets
                      .map((toolset) => toolset.displayName)
                      .join(", ")
                  : "None"}
              </dd>
            </div>
          </dl>
          {related.length > 0 ? (
            <CheckboxRow
              label="Also revoke its credential and policy"
              description={`Nothing else uses ${related.map((item) => item.displayName).join(", ")}. Revoked credentials cannot be restored; you would enter the secret again.`}
              checked={revokeCredentials}
              onChange={(event) =>
                setRevokeCredentials(event.currentTarget.checked)
              }
            />
          ) : (
            <small>
              Its credential is shared with another connection and stays active.
            </small>
          )}
          <small>
            Existing sessions that were started with this connection keep
            running, but their calls to its tools fail.
          </small>
        </div>
      ) : null}
      {remove.error ? <FormError>{remove.error.message}</FormError> : null}
    </Dialog>
  );
}

function RotateCredentialDialog({
  credential,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly credential: McpCredential;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (value: RotateMcpCredentialInput) => void;
}) {
  const [secret, setSecret] = useState("");
  const [origin, setOrigin] = useState("");
  const [pathPrefix, setPathPrefix] = useState("/");
  const [clientId, setClientId] = useState(credential.oauth?.clientId ?? "");
  // A credential stored before destinations existed is pinned on rotation.
  const pin = credential.destination === null && credential.oauth === null;
  const invalid =
    secret.length < 8 ||
    (credential.oauth !== null && clientId.trim().length === 0) ||
    (pin && (!origin.startsWith("https://") || !pathPrefix.startsWith("/")));
  return (
    <Dialog
      title={`Rotate ${credential.displayName}`}
      description="The old encrypted version is deprecated atomically. The new secret remains write-only."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        onSubmit(
          pin
            ? { secret, destination: { origin, pathPrefix } }
            : credential.oauth && clientId.trim() !== credential.oauth.clientId
              ? { secret, oauth: { clientId: clientId.trim() } }
              : { secret },
        );
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || invalid}>
            {pending ? "Rotating…" : "Rotate credential"}
          </Button>
        </>
      }
    >
      {pin ? (
        <>
          <Alert tone="warning" role="status" title="Pin a destination">
            This credential predates destination pinning. Its existing policies
            keep working until it is rotated; new policies need a pinned
            destination. Policies outside the destination stop working.
          </Alert>
          <Field label="Destination HTTPS origin">
            <Input
              type="url"
              placeholder="https://mcp.example.com"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
            />
          </Field>
          <Field label="Destination path prefix">
            <Input
              value={pathPrefix}
              onChange={(event) => setPathPrefix(event.target.value)}
            />
          </Field>
        </>
      ) : null}
      {credential.oauth ? (
        <Field
          label="Client ID"
          hint="Change it only when the authorization server issued a new client."
        >
          <Input
            autoComplete="off"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </Field>
      ) : null}
      <Field label={credential.oauth ? "New client secret" : "New secret"}>
        <Input
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

type McpCreateInput =
  | { readonly kind: "policy"; readonly value: CreateMcpCredentialPolicyInput }
  | { readonly kind: "toolset"; readonly value: CreateMcpToolsetInput };

/** Adds a policy or a toolset to one connection. */
function McpCreateDialog({
  kind,
  server,
  credentials,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly kind: CreateDialog["kind"];
  readonly server: McpServer;
  readonly credentials: readonly McpCredential[];
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: McpCreateInput) => void;
}) {
  const derived = endpointPolicy(server.endpointUrl, server.transport);
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? "");
  const [forwardCallContext, setForwardCallContext] = useState(false);
  const [exactOrigin, setExactOrigin] = useState(derived?.exactOrigin ?? "");
  const [pathPrefix, setPathPrefix] = useState(derived?.pathPrefix ?? "/");
  const [selectedTools, setSelectedTools] = useState<readonly string[]>([]);
  const [toolApproval, setToolApproval] =
    useState<CreateMcpToolsetInput["tools"][number]["approval"]>("always");
  const title =
    kind === "policy" ? "Add credential policy" : "Create MCP toolset";
  const validKey = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u.test(key);
  const invalid =
    !validKey ||
    !displayName.trim() ||
    (kind === "policy" &&
      (!credentialId ||
        !exactOrigin.startsWith("https://") ||
        !pathPrefix.startsWith("/"))) ||
    (kind === "toolset" && selectedTools.length === 0);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (invalid) return;
    if (kind === "policy")
      onSubmit({
        kind,
        value: {
          key,
          displayName: displayName.trim(),
          credentialId,
          exactOrigin,
          pathPrefix,
          timeoutMs: 30_000,
          maximumResponseBytes: 1_048_576,
          forwardCallContext,
        },
      });
    else
      onSubmit({
        kind,
        value: {
          key,
          displayName: displayName.trim(),
          serverVersionId: server.latestVersionId,
          tools: selectedTools.map((remoteToolName) => ({
            remoteToolName,
            approval: toolApproval,
          })),
        },
      });
  };
  return (
    <Dialog
      title={title}
      description={`For ${server.displayName}. Published MCP resources are immutable; create a new one when policy or tool access changes.`}
      wide
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || invalid}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field
          label="Key"
          {...(!key || validKey
            ? {}
            : { error: "Use a lowercase, hyphen-separated key." })}
        >
          <Input value={key} onChange={(event) => setKey(event.target.value)} />
        </Field>
        <Field label="Display name">
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        {kind === "policy" ? (
          <>
            <Field label="Credential">
              <Select
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                {credentials.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Exact HTTPS origin"
              hint="Must lie inside the credential's pinned destination."
            >
              <Input
                type="url"
                placeholder="https://mcp.example.com"
                value={exactOrigin}
                onChange={(event) => setExactOrigin(event.target.value)}
              />
            </Field>
            <Field label="Allowed path prefix">
              <Input
                value={pathPrefix}
                onChange={(event) => setPathPrefix(event.target.value)}
              />
            </Field>
            <CallContextToggle
              checked={forwardCallContext}
              disabled={false}
              onChange={setForwardCallContext}
            />
          </>
        ) : (
          <>
            <Field
              label="Approval policy"
              hint="Applied to every tool selected for this immutable toolset version."
            >
              <Select
                value={toolApproval}
                onChange={(event) =>
                  setToolApproval(
                    event.target
                      .value as CreateMcpToolsetInput["tools"][number]["approval"],
                  )
                }
              >
                <option value="always">Always require approval</option>
                <option value="never">Run without approval</option>
              </Select>
            </Field>
            <div className="field-row">
              {server.tools.map((tool) => (
                <CheckboxRow
                  key={tool.name}
                  label={tool.title ?? tool.name}
                  description={tool.description}
                  checked={selectedTools.includes(tool.name)}
                  onChange={(event) =>
                    setSelectedTools((current) =>
                      event.target.checked
                        ? [...current, tool.name]
                        : current.filter((name) => name !== tool.name),
                    )
                  }
                />
              ))}
            </div>
          </>
        )}
        {error ? <FormError>{error.message}</FormError> : null}
      </div>
    </Dialog>
  );
}

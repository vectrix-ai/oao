import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useApi } from "../api/context";
import type {
  CreateMcpCredentialInput,
  CreateMcpCredentialPolicyInput,
  CreateMcpServerInput,
  CreateMcpToolsetInput,
  AgentSummary,
  AgentVersionConfig,
  McpCredential,
  McpCredentialPolicy,
  McpServer,
  McpToolset,
} from "../api/types";
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

type CreateDialog = "credential" | "server" | "policy" | "toolset";

export function McpPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [dialog, setDialog] = useState<CreateDialog | null>(null);
  const [rotatingCredential, setRotatingCredential] =
    useState<McpCredential | null>(null);
  const [revokingCredential, setRevokingCredential] =
    useState<McpCredential | null>(null);
  const [discoveryPolicy, setDiscoveryPolicy] = useState<
    Record<string, string>
  >({});
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
    mutationFn: async (input: McpCreateInput) => {
      switch (input.kind) {
        case "credential":
          return api.createMcpCredential(input.value);
        case "server":
          return api.createMcpServer(input.value);
        case "policy":
          return api.createMcpCredentialPolicy(input.value);
        case "toolset":
          return api.createMcpToolset(input.value);
      }
    },
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
      readonly secret: string;
    }) => api.rotateMcpCredential(input.credentialId, { secret: input.secret }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-credentials"] });
      setRotatingCredential(null);
      notify("MCP credential rotated.");
    },
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
            servers={servers.data?.data ?? []}
            toolsets={toolsets.data?.data ?? []}
            disabled={!encryptionConfigured}
            onAdd={() => setWizardOpen(true)}
          />
          <Panel
            title="Advanced resources"
            description="Inspect or manage the immutable credentials, policies, server versions, and toolsets created by the setup wizard."
            collapsible
            defaultCollapsed
          >
            <div className="stack">
              <ResourcePanel
                title="Credentials"
                description="Encrypted bearer tokens or API-key headers. Values are write-only."
                action="Add credential"
                disabled={!encryptionConfigured}
                onAction={() => setDialog("credential")}
              >
                {(credentials.data?.data.length ?? 0) === 0 ? (
                  <EmptyState
                    icon="⚿"
                    title="No MCP credentials"
                    description="Add a project-scoped credential to continue."
                  />
                ) : (
                  <TableCard
                    label="MCP credentials table"
                    caption="Redacted MCP credentials"
                  >
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Kind</th>
                        <th>Fingerprint</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {credentials.data?.data.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.displayName}</strong>
                            <br />
                            <code>{item.key}</code>
                          </td>
                          <td>{item.kind.replaceAll("_", " ")}</td>
                          <td>
                            <span className="key-mask">
                              ••••{item.credentialFingerprint.slice(-6)}
                            </span>{" "}
                            · v{item.credentialVersion}
                          </td>
                          <td>
                            <StatusChip value={item.status} />
                          </td>
                          <td>
                            <span className="row">
                              <Button
                                size="sm"
                                icon={<RefreshCw size={13} />}
                                disabled={item.status !== "active"}
                                onClick={() => setRotatingCredential(item)}
                              >
                                Rotate
                              </Button>
                              <Button
                                size="sm"
                                icon={<Trash2 size={13} />}
                                disabled={item.status === "revoked"}
                                onClick={() => setRevokingCredential(item)}
                              >
                                Revoke
                              </Button>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableCard>
                )}
              </ResourcePanel>
              <ResourcePanel
                title="Credential policies"
                description="Bind one credential to an exact HTTPS origin and path prefix."
                action="Add policy"
                disabled={(credentials.data?.data.length ?? 0) === 0}
                onAction={() => setDialog("policy")}
              >
                {(policies.data?.data.length ?? 0) === 0 ? (
                  <EmptyState
                    icon="⌁"
                    title="No credential policies"
                    description="Create an exact-origin policy for a credential."
                  />
                ) : (
                  <TableCard
                    label="MCP credential policies table"
                    caption="Exact-origin credential policies"
                  >
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Destination</th>
                        <th>Limits</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policies.data?.data.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.displayName}</strong>
                            <br />
                            <code>{item.key}</code>
                          </td>
                          <td>
                            <code>
                              {item.exactOrigin}
                              {item.pathPrefix}
                            </code>
                          </td>
                          <td>
                            {item.timeoutMs / 1000}s ·{" "}
                            {Math.round(item.maximumResponseBytes / 1024)} KiB
                          </td>
                          <td>
                            <StatusChip value={item.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableCard>
                )}
              </ResourcePanel>
              <ResourcePanel
                title="Remote servers"
                description="HTTPS Streamable HTTP or legacy SSE endpoints; redirects and private-network destinations are denied."
                action="Add server"
                disabled={false}
                onAction={() => setDialog("server")}
              >
                {(servers.data?.data.length ?? 0) === 0 ? (
                  <EmptyState
                    icon="▣"
                    title="No MCP servers"
                    description="Register a remote MCP endpoint."
                  />
                ) : (
                  <TableCard
                    label="MCP servers table"
                    caption="Versioned remote MCP servers"
                  >
                    <thead>
                      <tr>
                        <th>Server</th>
                        <th>Endpoint</th>
                        <th>Tools</th>
                        <th>Discover</th>
                      </tr>
                    </thead>
                    <tbody>
                      {servers.data?.data.map((server) => (
                        <tr key={server.id}>
                          <td>
                            <strong>{server.displayName}</strong>
                            <br />
                            <StatusChip value={server.status} />
                          </td>
                          <td>
                            <code>{server.endpointUrl}</code>
                            <br />
                            <small>
                              {server.transport.replaceAll("_", " ")}
                            </small>
                          </td>
                          <td>{server.tools.length}</td>
                          <td>
                            <span className="row">
                              <Select
                                aria-label={`Credential policy for ${server.displayName}`}
                                value={discoveryPolicy[server.id] ?? ""}
                                onChange={(event) =>
                                  setDiscoveryPolicy((current) => ({
                                    ...current,
                                    [server.id]: event.target.value,
                                  }))
                                }
                              >
                                <option value="">Select policy</option>
                                {policies.data?.data.map((policy) => (
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
                                disabled={
                                  !discoveryPolicy[server.id] ||
                                  discover.isPending
                                }
                                onClick={() =>
                                  discover.mutate({
                                    serverId: server.id,
                                    policyVersionId:
                                      discoveryPolicy[server.id]!,
                                  })
                                }
                              >
                                Discover
                              </Button>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableCard>
                )}
              </ResourcePanel>
              <ResourcePanel
                title="Toolsets"
                description="Expose only selected discovered tools. Approval defaults to always."
                action="Create toolset"
                disabled={
                  !servers.data?.data.some((server) => server.tools.length > 0)
                }
                onAction={() => setDialog("toolset")}
              >
                {(toolsets.data?.data.length ?? 0) === 0 ? (
                  <EmptyState
                    icon="⌘"
                    title="No MCP toolsets"
                    description="Discover a server, then select the tools an agent may use."
                  />
                ) : (
                  <TableCard
                    label="MCP toolsets table"
                    caption="Restricted immutable MCP toolsets"
                  >
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Tools</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toolsets.data?.data.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.displayName}</strong>
                            <br />
                            <code>{item.key}</code>
                          </td>
                          <td>
                            {item.tools
                              .map((tool) => tool.remoteToolName)
                              .join(", ")}
                          </td>
                          <td>
                            <StatusChip value={item.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableCard>
                )}
              </ResourcePanel>
            </div>
          </Panel>
        </div>
      ) : null}
      {wizardOpen ? (
        <McpSetupDialog
          agents={agents.data?.data ?? []}
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
          kind={dialog}
          credentials={credentials.data?.data ?? []}
          servers={servers.data?.data ?? []}
          pending={create.isPending}
          error={create.error}
          onClose={() => {
            create.reset();
            setDialog(null);
          }}
          onSubmit={(input) => create.mutate(input)}
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
          onSubmit={(secret) =>
            rotate.mutate({ credentialId: rotatingCredential.id, secret })
          }
        />
      ) : null}
      {revokingCredential ? (
        <Dialog
          title={`Revoke ${revokingCredential.displayName}`}
          description="Revocation immediately blocks discovery and runtime calls that use this credential. It cannot be undone."
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

function ConnectionsPanel({
  servers,
  toolsets,
  disabled,
  onAdd,
}: {
  readonly servers: readonly McpServer[];
  readonly toolsets: readonly McpToolset[];
  readonly disabled: boolean;
  readonly onAdd: () => void;
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
              (toolset) => toolset.serverVersionId === server.latestVersionId,
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

function McpSetupDialog({
  agents,
  encryptionConfigured,
  onClose,
  onComplete,
}: {
  readonly agents: readonly AgentSummary[];
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
  const [exactOrigin, setExactOrigin] = useState("");
  const [pathPrefix, setPathPrefix] = useState("/");
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [maximumResponseKiB, setMaximumResponseKiB] = useState(1024);
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
  const serverReady =
    displayName.trim().length > 0 && validKey && derivedPolicy !== null;
  const authenticationReady =
    encryptionConfigured &&
    (resources.credential !== undefined || secret.length >= 8) &&
    exactOrigin.startsWith("https://") &&
    pathPrefix.startsWith("/") &&
    timeoutMs >= 1_000 &&
    timeoutMs <= 120_000 &&
    maximumResponseKiB >= 1 &&
    maximumResponseKiB <= 10_240 &&
    (credentialKind !== "api_key_header" || headerName.trim().length > 0);
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
        const credential = await api.createMcpCredential({
          key: `${key}-credential`,
          displayName: `${displayName.trim()} credential`,
          kind: credentialKind,
          headerName:
            credentialKind === "api_key_header" ? headerName.trim() : null,
          secret,
        });
        current = remember({ credential });
        setSecret("");
      }
      if (!current.policy) {
        const policy = await api.createMcpCredentialPolicy({
          key: `${key}-policy`,
          displayName: `${displayName.trim()} egress policy`,
          credentialId: current.credential!.id,
          exactOrigin,
          pathPrefix,
          timeoutMs,
          maximumResponseBytes: maximumResponseKiB * 1024,
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
          key: `${key}-tools`,
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
      const policy = derivedPolicy!;
      setExactOrigin(policy.exactOrigin);
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
              ? {}
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
            OAO encrypts this value immediately and injects it only at the exact
            approved destination. It is never shown again.
          </Alert>
          <Field label="Authentication type">
            <Select
              value={credentialKind}
              disabled={resources.credential !== undefined}
              onChange={(event) =>
                setCredentialKind(
                  event.currentTarget.value as CreateMcpCredentialInput["kind"],
                )
              }
            >
              <option value="static_bearer">Bearer token</option>
              <option value="api_key_header">API-key header</option>
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
          <Field
            label={resources.credential ? "Secret stored" : "Secret"}
            hint={
              resources.credential
                ? "The encrypted credential was saved and cannot be displayed."
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
              <Field label="Exact HTTPS origin">
                <Input
                  type="url"
                  value={exactOrigin}
                  disabled={resources.policy !== undefined}
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
                  disabled={resources.policy !== undefined}
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
                  : headerName}
              </dd>
            </div>
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
                  onChange={(event) =>
                    setSelectedTools((current) =>
                      event.currentTarget.checked
                        ? [...current, tool.name]
                        : current.filter((name) => name !== tool.name),
                    )
                  }
                />
                {selectedTools.includes(tool.name) ? (
                  <Field label={`Approval for ${tool.name}`}>
                    <Select
                      value={approvals[tool.name] ?? "always"}
                      onChange={(event) =>
                        setApprovals((current) => ({
                          ...current,
                          [tool.name]: event.currentTarget.value as
                            "never" | "always",
                        }))
                      }
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
  readonly onSubmit: (secret: string) => void;
}) {
  const [secret, setSecret] = useState("");
  return (
    <Dialog
      title={`Rotate ${credential.displayName}`}
      description="The old encrypted version is deprecated atomically. The new secret remains write-only."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (secret.length >= 8) onSubmit(secret);
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || secret.length < 8}
          >
            {pending ? "Rotating…" : "Rotate credential"}
          </Button>
        </>
      }
    >
      <Field label="New secret">
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

function ResourcePanel({
  title,
  description,
  action,
  disabled,
  onAction,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly disabled: boolean;
  readonly onAction: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Panel
      title={title}
      description={description}
      actions={
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={disabled}
          onClick={onAction}
        >
          {action}
        </Button>
      }
    >
      {children}
    </Panel>
  );
}

type McpCreateInput =
  | { readonly kind: "credential"; readonly value: CreateMcpCredentialInput }
  | { readonly kind: "server"; readonly value: CreateMcpServerInput }
  | { readonly kind: "policy"; readonly value: CreateMcpCredentialPolicyInput }
  | { readonly kind: "toolset"; readonly value: CreateMcpToolsetInput };

function McpCreateDialog({
  kind,
  credentials,
  servers,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly kind: CreateDialog;
  readonly credentials: readonly McpCredential[];
  readonly servers: readonly McpServer[];
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: McpCreateInput) => void;
}) {
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [secret, setSecret] = useState("");
  const [credentialKind, setCredentialKind] =
    useState<CreateMcpCredentialInput["kind"]>("static_bearer");
  const [headerName, setHeaderName] = useState("X-API-Key");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [transport, setTransport] =
    useState<CreateMcpServerInput["transport"]>("streamable_http");
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? "");
  const [exactOrigin, setExactOrigin] = useState("");
  const [pathPrefix, setPathPrefix] = useState("/");
  const eligibleServers = servers.filter((server) => server.tools.length > 0);
  const [serverVersionId, setServerVersionId] = useState(
    eligibleServers[0]?.latestVersionId ?? "",
  );
  const selectedServer = eligibleServers.find(
    (server) => server.latestVersionId === serverVersionId,
  );
  const [selectedTools, setSelectedTools] = useState<readonly string[]>([]);
  const [toolApproval, setToolApproval] =
    useState<CreateMcpToolsetInput["tools"][number]["approval"]>("always");
  const title = {
    credential: "Add MCP credential",
    server: "Add MCP server",
    policy: "Add credential policy",
    toolset: "Create MCP toolset",
  }[kind];
  const validKey = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u.test(key);
  const invalid =
    !validKey ||
    !displayName.trim() ||
    (kind === "credential" && secret.length < 8) ||
    (kind === "server" && !endpointUrl.startsWith("https://")) ||
    (kind === "policy" &&
      (!credentialId ||
        !exactOrigin.startsWith("https://") ||
        !pathPrefix.startsWith("/"))) ||
    (kind === "toolset" && (!serverVersionId || selectedTools.length === 0));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (invalid) return;
    if (kind === "credential")
      onSubmit({
        kind,
        value: {
          key,
          displayName: displayName.trim(),
          kind: credentialKind,
          headerName: credentialKind === "api_key_header" ? headerName : null,
          secret,
        },
      });
    if (kind === "server")
      onSubmit({
        kind,
        value: { key, displayName: displayName.trim(), endpointUrl, transport },
      });
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
        },
      });
    if (kind === "toolset")
      onSubmit({
        kind,
        value: {
          key,
          displayName: displayName.trim(),
          serverVersionId,
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
      description="Published MCP resources are immutable. Create a new version when policy or tool access changes."
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
        {kind === "credential" ? (
          <>
            <Field label="Credential type">
              <Select
                value={credentialKind}
                onChange={(event) =>
                  setCredentialKind(
                    event.target.value as CreateMcpCredentialInput["kind"],
                  )
                }
              >
                <option value="static_bearer">Static bearer</option>
                <option value="api_key_header">API key header</option>
              </Select>
            </Field>
            {credentialKind === "api_key_header" ? (
              <Field label="Header name">
                <Input
                  value={headerName}
                  onChange={(event) => setHeaderName(event.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Secret" hint="Write-only. It will never be returned.">
              <Input
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </Field>
          </>
        ) : null}
        {kind === "server" ? (
          <>
            <Field label="HTTPS endpoint">
              <Input
                type="url"
                placeholder="https://mcp.example.com/mcp"
                value={endpointUrl}
                onChange={(event) => setEndpointUrl(event.target.value)}
              />
            </Field>
            <Field label="Transport">
              <Select
                value={transport}
                onChange={(event) =>
                  setTransport(
                    event.target.value as CreateMcpServerInput["transport"],
                  )
                }
              >
                <option value="streamable_http">Streamable HTTP</option>
                <option value="legacy_sse">Legacy SSE</option>
              </Select>
            </Field>
          </>
        ) : null}
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
            <Field label="Exact HTTPS origin">
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
          </>
        ) : null}
        {kind === "toolset" ? (
          <>
            <Field label="Discovered server">
              <Select
                value={serverVersionId}
                onChange={(event) => {
                  setServerVersionId(event.target.value);
                  setSelectedTools([]);
                }}
              >
                {eligibleServers.map((server) => (
                  <option
                    key={server.latestVersionId}
                    value={server.latestVersionId}
                  >
                    {server.displayName}
                  </option>
                ))}
              </Select>
            </Field>
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
              {selectedServer?.tools.map((tool) => (
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
        ) : null}
        {error ? <FormError>{error.message}</FormError> : null}
      </div>
    </Dialog>
  );
}

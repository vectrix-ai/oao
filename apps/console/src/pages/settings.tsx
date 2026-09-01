import {
  Boxes,
  CircleGauge,
  Database,
  KeyRound,
  Layers3,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useApi } from "../api/context";
import type {
  CreateApiKeyInput,
  CreateProjectInput,
  CreateSandboxProviderInput,
  CreateStorageProviderInput,
  CreatedApiKey,
  ProjectSandboxProvider,
  ProjectStorageProvider,
  SettingsData,
  UpdateSandboxProviderConfigurationInput,
} from "../api/types";
import {
  Alert,
  Button,
  CheckboxRow,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FieldRow,
  FormError,
  Input,
  LoadingState,
  MetaGrid,
  Page,
  PageHeader,
  Panel,
  Select,
  StatusChip,
  Switch,
  TableCard,
  Textarea,
  formatDate,
  initials,
  useToast,
} from "../components/ui";

type SettingsRoute =
  | "organization"
  | "projects"
  | "members"
  | "api-keys"
  | "sandbox-providers"
  | "storage-providers"
  | "settings"
  | "hosting";

const copy: Record<
  SettingsRoute,
  { eyebrow: string; title: string; description: string }
> = {
  organization: {
    eyebrow: "Configure",
    title: "Organization",
    description: "Identity and tenancy details for this organization.",
  },
  projects: {
    eyebrow: "Configure",
    title: "Projects",
    description: "Isolated agent environments within the organization.",
  },
  members: {
    eyebrow: "Access",
    title: "Members",
    description: "Organization members and platform authorization roles.",
  },
  "api-keys": {
    eyebrow: "Access",
    title: "API keys",
    description:
      "Scoped project credentials. Secret values are shown only once at creation.",
  },
  "sandbox-providers": {
    eyebrow: "Configure",
    title: "Sandbox providers",
    description:
      "Project connections used to run agent tools in isolated environments.",
  },
  "storage-providers": {
    eyebrow: "Configure",
    title: "Storage providers",
    description:
      "S3-compatible project storage for run attachments and per-thread workspace backups.",
  },
  settings: {
    eyebrow: "Configure",
    title: "Settings",
    description: "Console preferences and public data-handling behavior.",
  },
  hosting: {
    eyebrow: "Operations",
    title: "Hosting diagnostics",
    description: "Observed service health and configured adapter locations.",
  },
};

const createLabel: Partial<Record<SettingsRoute, string>> = {
  projects: "New project",
  members: "Add member",
  "api-keys": "Create API key",
};

type SettingsMember = SettingsData["members"][number];
type MemberRole = SettingsMember["role"];
type SettingsProject = SettingsData["projects"][number];

export function SettingsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [creatingApiKey, setCreatingApiKey] = useState(false);
  const [createdApiKey, setCreatedApiKey] = useState<CreatedApiKey | null>(
    null,
  );
  const [addingMember, setAddingMember] = useState(false);
  const [removingMember, setRemovingMember] = useState<SettingsMember | null>(
    null,
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [deletingProject, setDeletingProject] =
    useState<SettingsProject | null>(null);
  const route = (
    location.pathname === "/settings/hosting"
      ? "hosting"
      : location.pathname.slice(1) || "settings"
  ) as SettingsRoute;
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });
  const createApiKey = useMutation({
    mutationFn: (input: CreateApiKeyInput) => api.createApiKey(input),
    onSuccess: (key) => {
      setCreatingApiKey(false);
      setCreatedApiKey(key);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      notify("API key created.");
    },
  });
  const addMember = useMutation({
    mutationFn: (input: Parameters<typeof api.addMember>[0]) =>
      api.addMember(input),
    onSuccess: () => {
      setAddingMember(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      notify("Project member added.");
    },
  });
  const updateMemberRole = useMutation({
    mutationFn: (input: {
      readonly memberId: string;
      readonly role: MemberRole;
    }) => api.updateMemberRole(input.memberId, input.role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      notify("Member role updated.");
    },
    onError: () => notify("Member role could not be updated.", "danger"),
  });
  const removeMember = useMutation({
    mutationFn: (memberId: string) => api.removeMember(memberId),
    onSuccess: () => {
      setRemovingMember(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      notify("Project member removed.");
    },
  });
  const createProject = useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: () => {
      setCreatingProject(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["context"] });
      notify("Project created.");
    },
  });
  const deleteProject = useMutation({
    mutationFn: (projectId: string) => api.deleteProject(projectId),
    onSuccess: () => {
      setDeletingProject(null);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["context"] });
      notify("Project deleted.");
    },
  });
  const openProject = useMutation({
    mutationFn: (project: SettingsProject) => api.openProject(project.id),
    onSuccess: async (_result, project) => {
      await queryClient.invalidateQueries();
      notify(`Switched to ${project.name}.`);
      navigate("/agents");
    },
    onError: () => notify("The project could not be opened.", "danger"),
  });
  const heading = copy[route] ?? copy.settings;
  const action = createLabel[route];
  if (query.isPending)
    return (
      <Page>
        <LoadingState label={`Loading ${heading.title.toLowerCase()}`} />
      </Page>
    );
  if (query.isError)
    return (
      <Page>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </Page>
    );
  return (
    <Page>
      <PageHeader
        {...heading}
        {...(route === "hosting"
          ? {
              breadcrumbs: [
                { label: "Settings", to: "/settings" },
                { label: "Hosting diagnostics" },
              ],
            }
          : {})}
        actions={
          action ? (
            <Button
              variant="primary"
              icon={
                route === "members" ? (
                  <UserPlus size={15} />
                ) : (
                  <Plus size={15} />
                )
              }
              onClick={
                route === "api-keys"
                  ? () => {
                      createApiKey.reset();
                      setCreatingApiKey(true);
                    }
                  : route === "members"
                    ? () => {
                        addMember.reset();
                        setAddingMember(true);
                      }
                    : route === "projects"
                      ? () => {
                          createProject.reset();
                          setCreatingProject(true);
                        }
                      : undefined
              }
            >
              {action}
            </Button>
          ) : undefined
        }
      />
      <SettingsBody
        route={route}
        data={query.data}
        {...(updateMemberRole.variables?.memberId
          ? { updatingMemberId: updateMemberRole.variables.memberId }
          : {})}
        onUpdateMemberRole={(memberId, role) =>
          updateMemberRole.mutate({ memberId, role })
        }
        onRemoveMember={setRemovingMember}
        onDeleteProject={setDeletingProject}
        onOpenProject={(project) => openProject.mutate(project)}
        {...(openProject.isPending && openProject.variables
          ? { openingProjectId: openProject.variables.id }
          : {})}
      />
      {addingMember ? (
        <AddMemberDialog
          pending={addMember.isPending}
          error={addMember.error}
          onClose={() => {
            addMember.reset();
            setAddingMember(false);
          }}
          onSubmit={(input) => addMember.mutate(input)}
        />
      ) : null}
      {removingMember ? (
        <RemoveMemberDialog
          member={removingMember}
          pending={removeMember.isPending}
          error={removeMember.error}
          onClose={() => {
            removeMember.reset();
            setRemovingMember(null);
          }}
          onConfirm={() => removeMember.mutate(removingMember.id)}
        />
      ) : null}
      {creatingProject ? (
        <CreateProjectDialog
          pending={createProject.isPending}
          error={createProject.error}
          onClose={() => {
            createProject.reset();
            setCreatingProject(false);
          }}
          onSubmit={(input) => createProject.mutate(input)}
        />
      ) : null}
      {deletingProject ? (
        <DeleteProjectDialog
          project={deletingProject}
          pending={deleteProject.isPending}
          error={deleteProject.error}
          onClose={() => {
            deleteProject.reset();
            setDeletingProject(null);
          }}
          onConfirm={() => deleteProject.mutate(deletingProject.id)}
        />
      ) : null}
      {creatingApiKey ? (
        <CreateApiKeyDialog
          pending={createApiKey.isPending}
          error={createApiKey.error}
          onClose={() => {
            createApiKey.reset();
            setCreatingApiKey(false);
          }}
          onSubmit={(input) => createApiKey.mutate(input)}
        />
      ) : null}
      {createdApiKey ? (
        <CreatedApiKeyDialog
          apiKey={createdApiKey}
          onClose={() => {
            createApiKey.reset();
            setCreatedApiKey(null);
          }}
        />
      ) : null}
    </Page>
  );
}

function SettingsBody({
  route,
  data,
  updatingMemberId,
  onUpdateMemberRole,
  onRemoveMember,
  onDeleteProject,
  onOpenProject,
  openingProjectId,
}: {
  readonly route: SettingsRoute;
  readonly data: SettingsData;
  readonly updatingMemberId?: string;
  readonly onUpdateMemberRole: (memberId: string, role: MemberRole) => void;
  readonly onRemoveMember: (member: SettingsMember) => void;
  readonly onDeleteProject: (project: SettingsProject) => void;
  readonly onOpenProject: (project: SettingsProject) => void;
  readonly openingProjectId?: string;
}) {
  if (route === "organization")
    return (
      <Panel
        title="Organization details"
        description="Stable identity repeated across every tenant-owned resource."
        actions={<Boxes size={18} aria-hidden="true" />}
      >
        <MetaGrid
          columns={2}
          items={[
            { label: "ID", value: <code>{data.organization.id}</code> },
            { label: "Name", value: data.organization.name },
            {
              label: "Slug",
              value: <code>{data.organization.slug}</code>,
            },
            {
              label: "Created",
              value: formatDate(data.organization.createdAt),
            },
          ]}
        />
      </Panel>
    );

  if (route === "projects")
    return data.projects.length === 0 ? (
      <EmptyState
        icon="◇"
        title="No accessible projects"
        description="Projects appear here after an administrator provisions access to an OAO principal."
      />
    ) : (
      <section className="cards-grid">
        {data.projects.map((project) => (
          <article className="resource-card" key={project.id}>
            <span className="service-icon" aria-hidden="true">
              <Layers3 size={16} />
            </span>
            <div>
              <h2>
                {project.name}{" "}
                {project.current ? <StatusChip value="current" /> : null}
              </h2>
              <code>{project.slug}</code>
              <p className="muted">
                ID <code>{project.id}</code>
              </p>
              <p className="muted">Created {formatDate(project.createdAt)}</p>
            </div>
            <div className="resource-card-actions">
              {project.current ? (
                <Link className="btn btn--sm" to="/agents">
                  Open project
                </Link>
              ) : (
                <Button
                  size="sm"
                  disabled={openingProjectId === project.id}
                  onClick={() => onOpenProject(project)}
                >
                  Open
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                disabled={project.current || data.projects.length <= 1}
                title={
                  project.current
                    ? "The active project cannot delete itself."
                    : data.projects.length <= 1
                      ? "The last project of an organization cannot be deleted."
                      : undefined
                }
                onClick={() => onDeleteProject(project)}
              >
                Delete
              </Button>
            </div>
          </article>
        ))}
      </section>
    );

  if (route === "members")
    return data.members.length === 0 ? (
      <EmptyState
        icon="◎"
        title="No project members"
        description="Add a principal with the least project access it needs."
      />
    ) : (
      <TableCard label="Members table" caption="Members of the current project">
        <thead>
          <tr>
            <th>Member</th>
            <th>Email</th>
            <th>Scopes</th>
            <th>Role</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((member) => (
            <tr key={member.id}>
              <td>
                <span className="member-cell">
                  <span className="avatar" aria-hidden="true">
                    {initials(member.name)}
                  </span>
                  <span className="entity-text">
                    <strong>{member.name}</strong>
                    <code>{member.subject}</code>
                  </span>
                </span>
              </td>
              <td>{member.email ?? "—"}</td>
              <td>
                {member.scopes.includes("*") ? (
                  <span className="scope">all project scopes</span>
                ) : (
                  `${member.scopes.length} scope${member.scopes.length === 1 ? "" : "s"}`
                )}
              </td>
              <td>
                <Select
                  aria-label={`Role for ${member.name}`}
                  value={member.role}
                  disabled={member.current || updatingMemberId === member.id}
                  onChange={(event) =>
                    onUpdateMemberRole(
                      member.id,
                      event.target.value as MemberRole,
                    )
                  }
                >
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </Select>
              </td>
              <td className="cell-actions">
                {member.current ? (
                  <StatusChip value="you" />
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={14} />}
                    onClick={() => onRemoveMember(member)}
                  >
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    );

  if (route === "api-keys")
    return data.apiKeys.length === 0 ? (
      <EmptyState
        icon="⚿"
        title="No API keys"
        description="An API key is a scoped project credential for an integration or CI job."
      />
    ) : (
      <TableCard label="API keys table" caption="Scoped project API keys">
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Scopes</th>
            <th>Last used</th>
          </tr>
        </thead>
        <tbody>
          {data.apiKeys.map((key) => (
            <tr key={key.id}>
              <td>
                <span className="member-cell">
                  <span className="entity-icon" aria-hidden="true">
                    <KeyRound size={15} />
                  </span>
                  <strong>{key.name}</strong>
                </span>
              </td>
              <td>
                <span className="key-mask">{key.prefix}</span>
              </td>
              <td>
                {key.scopes.map((scope) => (
                  <span className="scope" key={scope}>
                    {scope}
                  </span>
                ))}
              </td>
              <td>{key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}</td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    );

  if (route === "sandbox-providers") return <SandboxConnections />;
  if (route === "storage-providers") return <StorageConnections />;

  if (route === "hosting")
    return (
      <>
        <Alert
          tone="warning"
          role="status"
          title="Operational diagnostics only"
        >
          Regions below are adapter configuration and health observations. They
          are not a data-residency or compliance claim.
        </Alert>
        <section className="cards-grid">
          {data.hosting.map((service) => (
            <article className="service-card" key={service.service}>
              <header>
                <span className="service-icon" aria-hidden="true">
                  {service.service === "PostgreSQL" ? (
                    <Database size={16} />
                  ) : (
                    <CircleGauge size={16} />
                  )}
                </span>
                <div>
                  <h2>{service.service}</h2>
                </div>
                <StatusChip value={service.status} />
              </header>
              <dl>
                <div>
                  <dt>Adapter location</dt>
                  <dd>{service.region}</dd>
                </div>
                <div>
                  <dt>Latency</dt>
                  <dd className="mono">
                    {service.latencyMs === null
                      ? "Unavailable"
                      : `${service.latencyMs} ms`}
                  </dd>
                </div>
                <div>
                  <dt>Last check</dt>
                  <dd>{formatDate(service.checkedAt)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </section>
      </>
    );

  return <ConsolePreferences />;
}

type SandboxConnectionAction =
  | { readonly mode: "create" }
  | { readonly mode: "rotate"; readonly provider: ProjectSandboxProvider }
  | { readonly mode: "configure"; readonly provider: ProjectSandboxProvider };

type SandboxConnectionMutation =
  | {
      readonly mode: "create";
      readonly key: string;
      readonly displayName: string;
      readonly providerType: CreateSandboxProviderInput["providerType"];
      readonly apiKey: string;
      readonly target: string | null;
      readonly configuration: UpdateSandboxProviderConfigurationInput;
    }
  | {
      readonly mode: "rotate";
      readonly providerId: string;
      readonly apiKey: string;
    }
  | {
      readonly mode: "configure";
      readonly providerId: string;
      readonly configuration: UpdateSandboxProviderConfigurationInput;
    };

function SandboxConnections() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [action, setAction] = useState<SandboxConnectionAction | null>(null);
  const query = useQuery({
    queryKey: ["sandbox-providers"],
    queryFn: () => api.listSandboxProviders(),
  });
  const save = useMutation({
    mutationFn: (input: SandboxConnectionMutation) => {
      switch (input.mode) {
        case "create":
          return api.createSandboxProvider({
            key: input.key,
            displayName: input.displayName,
            providerType: input.providerType,
            apiKey: input.apiKey,
            target: input.target,
            restrictedEgress: input.configuration.restrictedEgress,
          });
        case "rotate":
          return api.rotateSandboxProviderCredential(
            input.providerId,
            input.apiKey,
          );
        case "configure":
          return api.updateSandboxProviderConfiguration(
            input.providerId,
            input.configuration,
          );
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sandbox-providers"] });
      setAction(null);
      notify("Sandbox provider saved.");
    },
  });
  return (
    <Panel
      title="Provider connections"
      description="Project-scoped sandbox credentials and network configuration. Daytona is the supported provider today."
      actions={
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={
            query.isPending ||
            query.isError ||
            query.data?.credentialEncryptionConfigured !== true
          }
          onClick={() => {
            save.reset();
            setAction({ mode: "create" });
          }}
        >
          Add sandbox provider
        </Button>
      }
    >
      {query.isPending ? (
        <LoadingState label="Loading sandbox connections" rows={2} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="stack">
          {!query.data.credentialEncryptionConfigured ? (
            <Alert tone="danger" role="alert" title="Encryption key required">
              Configure OAO_CREDENTIAL_ENCRYPTION_KEY before saving a sandbox
              provider credential.
            </Alert>
          ) : null}
          {query.data.data.length === 0 ? (
            <EmptyState
              icon="▣"
              title="No sandbox providers"
              description="Add an encrypted provider connection before selecting it on an agent."
            />
          ) : (
            <TableCard
              label="Sandbox providers table"
              caption="Configured project sandbox providers"
            >
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Provider</th>
                  <th>Credential</th>
                  <th>Target</th>
                  <th>Restricted egress</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((provider) => (
                  <tr key={provider.id}>
                    <td>
                      <strong>{provider.displayName}</strong>
                      <br />
                      <code>{provider.key}</code>
                    </td>
                    <td>{sandboxProviderTypeLabel(provider.providerType)}</td>
                    <td>
                      <span className="key-mask">
                        ••••{provider.credentialFingerprint.slice(-6)}
                      </span>
                      <br />
                      <small>version {provider.credentialVersion}</small>
                    </td>
                    <td>{provider.target ?? "Provider default"}</td>
                    <td>
                      {provider.restrictedEgress.allowedDomains.length} domains
                      · {provider.restrictedEgress.allowedCidrs.length} CIDRs
                    </td>
                    <td>
                      <span className="row">
                        <Button
                          size="sm"
                          icon={<Settings2 size={13} />}
                          onClick={() => {
                            save.reset();
                            setAction({ mode: "configure", provider });
                          }}
                        >
                          Configure
                        </Button>
                        <Button
                          size="sm"
                          icon={<RefreshCw size={13} />}
                          onClick={() => {
                            save.reset();
                            setAction({ mode: "rotate", provider });
                          }}
                        >
                          Rotate key
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableCard>
          )}
        </div>
      )}
      {action ? (
        <SandboxConnectionDialog
          key={`${action.mode}:${"provider" in action ? action.provider.id : "new"}`}
          action={action}
          pending={save.isPending}
          error={save.error}
          onClose={() => {
            save.reset();
            setAction(null);
          }}
          onSubmit={(input) => save.mutate(input)}
        />
      ) : null}
    </Panel>
  );
}

function splitAllowlist(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function sandboxProviderTypeLabel(
  providerType: ProjectSandboxProvider["providerType"],
): string {
  switch (providerType) {
    case "daytona":
      return "Daytona";
  }
}

function SandboxConnectionDialog({
  action,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly action: SandboxConnectionAction;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: SandboxConnectionMutation) => void;
}) {
  const provider = "provider" in action ? action.provider : undefined;
  const [providerType, setProviderType] =
    useState<CreateSandboxProviderInput["providerType"]>("daytona");
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [target, setTarget] = useState(provider?.target ?? "");
  const [domains, setDomains] = useState(
    provider?.restrictedEgress.allowedDomains.join("\n") ?? "",
  );
  const [cidrs, setCidrs] = useState(
    provider?.restrictedEgress.allowedCidrs.join("\n") ?? "",
  );
  const isCredential = action.mode === "create" || action.mode === "rotate";
  const keyError =
    action.mode === "create"
      ? key === "local-fake"
        ? "local-fake is reserved."
        : !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u.test(key)
          ? "Use a lowercase, hyphen-separated key."
          : undefined
      : undefined;
  const displayNameError =
    action.mode === "create" && displayName.trim().length === 0
      ? "Display name is required."
      : undefined;
  const apiKeyError =
    isCredential && apiKey.length < 8
      ? `${sandboxProviderTypeLabel(provider?.providerType ?? providerType)} API key must contain at least 8 characters.`
      : undefined;
  const invalid = Boolean(keyError || displayNameError || apiKeyError);
  const configuration = (): UpdateSandboxProviderConfigurationInput => ({
    target: target.trim() || null,
    restrictedEgress: {
      allowedDomains: splitAllowlist(domains),
      allowedCidrs: splitAllowlist(cidrs),
    },
  });
  return (
    <Dialog
      title={
        action.mode === "create"
          ? "Add sandbox provider"
          : action.mode === "rotate"
            ? `Rotate ${provider?.displayName ?? "provider"} key`
            : `Configure ${provider?.displayName ?? "provider"}`
      }
      description="Secrets are encrypted at rest and are never returned by the API or console."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (invalid) return;
        if (action.mode === "create")
          onSubmit({
            mode: "create",
            key,
            displayName: displayName.trim(),
            providerType,
            apiKey,
            target: target.trim() || null,
            configuration: configuration(),
          });
        else if (action.mode === "rotate")
          onSubmit({ mode: "rotate", providerId: action.provider.id, apiKey });
        else
          onSubmit({
            mode: "configure",
            providerId: action.provider.id,
            configuration: configuration(),
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
            disabled={invalid}
          >
            {pending
              ? "Saving…"
              : action.mode === "create"
                ? "Add provider"
                : "Save changes"}
          </Button>
        </>
      }
    >
      {action.mode === "create" ? (
        <>
          <Field label="Provider">
            <Select
              autoFocus
              value={providerType}
              onChange={(event) =>
                setProviderType(
                  event.target
                    .value as CreateSandboxProviderInput["providerType"],
                )
              }
            >
              <option value="daytona">Daytona</option>
            </Select>
          </Field>
          <FieldRow>
            <Field
              label="Connection key"
              {...(key && keyError ? { error: keyError } : {})}
            >
              <Input
                value={key}
                placeholder="daytona-primary"
                onChange={(event) => setKey(event.target.value)}
              />
            </Field>
            <Field
              label="Display name"
              {...(displayName && displayNameError
                ? { error: displayNameError }
                : {})}
            >
              <Input
                value={displayName}
                placeholder="Daytona primary"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
          </FieldRow>
        </>
      ) : null}
      {isCredential ? (
        <Field
          label={`${sandboxProviderTypeLabel(provider?.providerType ?? providerType)} API key`}
          hint="The credential is sent only in this request and is never returned."
          {...(apiKey && apiKeyError ? { error: apiKeyError } : {})}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
      ) : null}
      {action.mode !== "rotate" ? (
        <>
          <Field
            label="Target preference"
            hint="Optional Daytona target. This is an adapter preference, not a residency guarantee."
          >
            <Input
              value={target}
              placeholder="Provider default"
              onChange={(event) => setTarget(event.target.value)}
            />
          </Field>
          <FieldRow>
            <Field
              label="Allowed domains"
              hint="One hostname or wildcard hostname per line."
            >
              <Textarea
                rows={5}
                value={domains}
                placeholder={"api.example.com\n*.example.net"}
                onChange={(event) => setDomains(event.target.value)}
              />
            </Field>
            <Field label="Allowed CIDRs" hint="One IPv4 or IPv6 CIDR per line.">
              <Textarea
                rows={5}
                value={cidrs}
                placeholder={"203.0.113.0/24\n2001:db8::/32"}
                onChange={(event) => setCidrs(event.target.value)}
              />
            </Field>
          </FieldRow>
        </>
      ) : null}
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

type StorageConnectionAction =
  | { readonly mode: "create" }
  | { readonly mode: "rotate"; readonly provider: ProjectStorageProvider };

function StorageConnections() {
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [action, setAction] = useState<StorageConnectionAction | null>(null);
  const query = useQuery({
    queryKey: ["storage-providers"],
    queryFn: () => api.listStorageProviders(),
  });
  const save = useMutation({
    mutationFn: (
      input:
        | {
            readonly mode: "create";
            readonly value: CreateStorageProviderInput;
          }
        | {
            readonly mode: "rotate";
            readonly providerId: string;
            readonly value: Pick<
              CreateStorageProviderInput,
              "accessKeyId" | "secretAccessKey" | "sessionToken"
            >;
          },
    ) =>
      input.mode === "create"
        ? api.createStorageProvider(input.value)
        : api.rotateStorageProviderCredential(input.providerId, input.value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["storage-providers"] });
      setAction(null);
      notify("Storage provider saved.");
    },
  });
  const makeDefault = useMutation({
    mutationFn: (providerId: string) =>
      api.setDefaultStorageProvider(providerId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["storage-providers"] });
      notify("Default storage provider updated.");
    },
  });
  return (
    <Panel
      title="Object storage"
      description="The default S3-compatible connection stores raw run attachments and receives a compressed workspace backup after every completed agent run."
      actions={
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={
            query.isPending ||
            query.isError ||
            query.data?.credentialEncryptionConfigured !== true
          }
          onClick={() => {
            save.reset();
            setAction({ mode: "create" });
          }}
        >
          Add storage provider
        </Button>
      }
    >
      {query.isPending ? (
        <LoadingState label="Loading storage connections" rows={2} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="stack">
          {!query.data.credentialEncryptionConfigured ? (
            <Alert tone="danger" role="alert" title="Encryption key required">
              Configure OAO_CREDENTIAL_ENCRYPTION_KEY before saving storage
              credentials.
            </Alert>
          ) : null}
          <Alert tone="warning" role="status" title="Private stored data">
            Attachments and workspace archives may contain user files and
            generated secrets. Restrict bucket access and enable server-side
            encryption and retention controls on the storage provider.
          </Alert>
          {query.data.data.length === 0 ? (
            <EmptyState
              icon="▤"
              title="No storage providers"
              description="Without a default storage provider, file attachments are unavailable and Daytona filesystem changes are not recoverable after sandbox deletion."
            />
          ) : (
            <TableCard
              label="Storage providers table"
              caption="Configured S3-compatible project storage"
            >
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Bucket</th>
                  <th>Endpoint</th>
                  <th>Credential</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((provider) => (
                  <tr key={provider.id}>
                    <td>
                      <strong>
                        <Link
                          to={`/storage-providers/${encodeURIComponent(provider.id)}`}
                          title="Browse the files and folders stored with this provider"
                        >
                          {provider.displayName}
                        </Link>
                      </strong>{" "}
                      {provider.default ? <StatusChip value="default" /> : null}
                      <br />
                      <code>{provider.key}</code>
                    </td>
                    <td>
                      <code>{provider.bucket}</code>
                      <br />
                      <small>
                        {provider.region}
                        {provider.prefix ? ` · ${provider.prefix}` : ""}
                      </small>
                    </td>
                    <td>{provider.endpoint ?? "AWS default"}</td>
                    <td>
                      <span className="key-mask">
                        ••••{provider.credentialFingerprint.slice(-6)}
                      </span>
                      <br />
                      <small>version {provider.credentialVersion}</small>
                    </td>
                    <td>
                      <span className="row">
                        {!provider.default ? (
                          <Button
                            size="sm"
                            disabled={makeDefault.isPending}
                            onClick={() => makeDefault.mutate(provider.id)}
                          >
                            Make default
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          icon={<RefreshCw size={13} />}
                          onClick={() => {
                            save.reset();
                            setAction({ mode: "rotate", provider });
                          }}
                        >
                          Rotate credentials
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableCard>
          )}
          {makeDefault.error ? (
            <FormError>{makeDefault.error.message}</FormError>
          ) : null}
        </div>
      )}
      {action ? (
        <StorageConnectionDialog
          key={`${action.mode}:${"provider" in action ? action.provider.id : "new"}`}
          action={action}
          pending={save.isPending}
          error={save.error}
          onClose={() => {
            save.reset();
            setAction(null);
          }}
          onSubmit={(input) => save.mutate(input)}
        />
      ) : null}
    </Panel>
  );
}

function StorageConnectionDialog({
  action,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly action: StorageConnectionAction;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (
    input:
      | { readonly mode: "create"; readonly value: CreateStorageProviderInput }
      | {
          readonly mode: "rotate";
          readonly providerId: string;
          readonly value: Pick<
            CreateStorageProviderInput,
            "accessKeyId" | "secretAccessKey" | "sessionToken"
          >;
        },
  ) => void;
}) {
  const provider = "provider" in action ? action.provider : undefined;
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("oao");
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [setDefault, setSetDefault] = useState(true);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const create = action.mode === "create";
  const keyError =
    create && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u.test(key)
      ? "Use a lowercase, hyphen-separated key."
      : undefined;
  const endpointError = (() => {
    if (!create || !endpoint) return undefined;
    try {
      const url = new URL(endpoint);
      return url.protocol === "http:" || url.protocol === "https:"
        ? undefined
        : "Endpoint must use HTTP or HTTPS.";
    } catch {
      return "Enter an absolute HTTP(S) endpoint.";
    }
  })();
  const prefixError = (() => {
    if (!create || !prefix.trim()) return undefined;
    const value = prefix.trim();
    return value.startsWith("/") ||
      value.endsWith("/") ||
      value.includes("\\") ||
      value
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
      ? "Use a relative path without empty, dot, or parent segments."
      : undefined;
  })();
  const invalid = Boolean(
    (create && (!displayName.trim() || !region.trim() || !bucket.trim())) ||
    keyError ||
    endpointError ||
    prefixError ||
    accessKeyId.length < 3 ||
    secretAccessKey.length < 8,
  );
  const credential = {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
  return (
    <Dialog
      title={
        create ? "Add storage provider" : `Rotate ${provider?.displayName}`
      }
      description="Credentials are encrypted at rest and never returned by the API. Connection configuration is immutable so existing workspace backups remain addressable."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (invalid) return;
        onSubmit(
          create
            ? {
                mode: "create",
                value: {
                  key,
                  displayName: displayName.trim(),
                  providerType: "s3",
                  endpoint: endpoint.trim() || null,
                  region: region.trim(),
                  bucket: bucket.trim(),
                  prefix: prefix.trim() || null,
                  forcePathStyle,
                  setDefault,
                  ...credential,
                },
              }
            : {
                mode: "rotate",
                providerId: provider!.id,
                value: credential,
              },
        );
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
            disabled={invalid}
          >
            {pending
              ? "Saving…"
              : create
                ? "Add provider"
                : "Rotate credentials"}
          </Button>
        </>
      }
    >
      {create ? (
        <>
          <FieldRow>
            <Field
              label="Connection key"
              {...(key && keyError ? { error: keyError } : {})}
            >
              <Input
                autoFocus
                value={key}
                placeholder="workspace-primary"
                onChange={(event) => setKey(event.target.value)}
              />
            </Field>
            <Field label="Display name">
              <Input
                value={displayName}
                placeholder="Workspace storage"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
          </FieldRow>
          <Field
            label="S3-compatible endpoint"
            hint="Leave empty for the AWS S3 regional endpoint."
            {...(endpointError ? { error: endpointError } : {})}
          >
            <Input
              value={endpoint}
              placeholder="https://s3.example.com"
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </Field>
          <FieldRow>
            <Field label="Region">
              <Input
                value={region}
                onChange={(event) => setRegion(event.target.value)}
              />
            </Field>
            <Field label="Bucket">
              <Input
                value={bucket}
                placeholder="oao-workspaces"
                onChange={(event) => setBucket(event.target.value)}
              />
            </Field>
          </FieldRow>
          <Field
            label="Object prefix"
            hint="Optional safe path prepended inside the bucket."
            {...(prefixError ? { error: prefixError } : {})}
          >
            <Input
              value={prefix}
              placeholder="oao"
              onChange={(event) => setPrefix(event.target.value)}
            />
          </Field>
          <FieldRow>
            <CheckboxRow
              label="Force path-style URLs"
              description="Required by some MinIO, R2, and private S3-compatible endpoints."
              checked={forcePathStyle}
              onChange={(event) => setForcePathStyle(event.target.checked)}
            />
            <CheckboxRow
              label="Make default"
              description="New session workspaces automatically use the default connection."
              checked={setDefault}
              onChange={(event) => setSetDefault(event.target.checked)}
            />
          </FieldRow>
        </>
      ) : null}
      <FieldRow>
        <Field label="Access key ID">
          <Input
            type="password"
            autoComplete="new-password"
            value={accessKeyId}
            onChange={(event) => setAccessKeyId(event.target.value)}
          />
        </Field>
        <Field label="Secret access key">
          <Input
            type="password"
            autoComplete="new-password"
            value={secretAccessKey}
            onChange={(event) => setSecretAccessKey(event.target.value)}
          />
        </Field>
      </FieldRow>
      <Field label="Session token" hint="Optional for temporary credentials.">
        <Textarea
          rows={3}
          value={sessionToken}
          onChange={(event) => setSessionToken(event.target.value)}
        />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

const API_KEY_SCOPES = [
  ["agent:read", "Read agents and immutable versions."],
  ["agent:write", "Create agents and publish versions."],
  ["session:read", "Read sessions and their public transcripts."],
  ["session:write", "Create sessions."],
  ["run:create", "Start initial and follow-up runs."],
  ["run:read", "Read runs and connect to project events."],
  ["run:cancel", "Request run cancellation."],
  ["tool_call:claim", "Claim and renew caller-owned tool work."],
  ["tool_call:submit", "Submit caller-owned tool results."],
  ["approval:resolve", "Approve or deny pending approvals."],
  ["mcp:read", "Read MCP server and toolset metadata."],
  ["mcp:write", "Create MCP servers and toolsets."],
  ["mcp:discover", "Connect to a server and snapshot its tools."],
  ["mcp:bind", "Bind exact MCP resources to agent versions."],
  ["mcp:execute", "Execute an agent's bound remote MCP tools."],
  ["credential:read_metadata", "Read redacted credential metadata."],
  ["credential:write", "Store new write-only MCP credentials."],
  ["credential:rotate", "Rotate encrypted MCP credentials."],
  ["credential:revoke", "Revoke MCP credentials."],
  ["audit:read", "Read and export the project audit log."],
  ["project:admin", "Manage members, providers, presets, and API keys."],
] as const;

const DEFAULT_API_KEY_SCOPES = new Set([
  "agent:read",
  "session:read",
  "session:write",
  "run:create",
  "run:read",
]);

const DEFAULT_MEMBER_SCOPES = new Set([
  "agent:read",
  "session:read",
  "run:read",
]);

function AddMemberDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: {
    readonly subject: string;
    readonly role: MemberRole;
    readonly scopes: readonly string[];
  }) => void;
}) {
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [scopes, setScopes] = useState(
    () => new Set<string>(DEFAULT_MEMBER_SCOPES),
  );
  const subjectError =
    subject.trim().length === 0
      ? "Principal subject is required."
      : subject.trim().length > 500
        ? "Principal subject must contain at most 500 characters."
        : undefined;
  const scopesError =
    scopes.size === 0 ? "Select at least one project scope." : undefined;
  return (
    <Dialog
      title="Add project member"
      description="Create or update an OAO principal in the current project. WorkOS users must also be provisioned to this project before they can sign in."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!subjectError && !scopesError)
          onSubmit({ subject: subject.trim(), role, scopes: [...scopes] });
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
            disabled={Boolean(subjectError || scopesError)}
          >
            {pending ? "Adding…" : "Add member"}
          </Button>
        </>
      }
    >
      <Field
        label="Principal subject"
        hint="Use a stable internal subject or email. This value is not a WorkOS invitation."
        {...(subject.length > 0 && subjectError ? { error: subjectError } : {})}
      >
        <Input
          autoFocus
          value={subject}
          maxLength={500}
          placeholder="operator@example.com"
          onChange={(event) => setSubject(event.target.value)}
        />
      </Field>
      <Field label="Project role">
        <Select
          value={role}
          onChange={(event) => setRole(event.target.value as MemberRole)}
        >
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="viewer">Viewer</option>
        </Select>
      </Field>
      <fieldset className="scope-picker">
        <legend>Project scopes</legend>
        <span className="hint">
          Select only the API capabilities this principal needs.
        </span>
        <div className="scope-picker-grid">
          {API_KEY_SCOPES.map(([scope, description]) => (
            <CheckboxRow
              key={scope}
              label={scope}
              description={description}
              checked={scopes.has(scope)}
              onChange={(event) => {
                setScopes((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(scope);
                  else next.delete(scope);
                  return next;
                });
              }}
            />
          ))}
        </div>
        {scopesError ? <FormError>{scopesError}</FormError> : null}
      </fieldset>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

function RemoveMemberDialog({
  member,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly member: SettingsMember;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      title={`Remove ${member.name}`}
      description="This removes the principal's membership from the current project. It does not delete the WorkOS user."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" loading={pending} onClick={onConfirm}>
            {pending ? "Removing…" : "Remove member"}
          </Button>
        </>
      }
    >
      <Alert tone="warning" title="Project access will be revoked">
        {member.subject} will no longer resolve as a member of this project.
      </Alert>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

function deriveProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function CreateProjectDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateProjectInput) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const nameError =
    name.trim().length === 0
      ? "Name is required."
      : name.trim().length > 200
        ? "Name must contain at most 200 characters."
        : undefined;
  const slugError =
    slug.length === 0
      ? "Slug is required."
      : slug.length > 80
        ? "Slug must contain at most 80 characters."
        : !PROJECT_SLUG_PATTERN.test(slug)
          ? "Slug must contain lowercase letters, digits, and dashes."
          : undefined;
  return (
    <Dialog
      title="New project"
      description="Projects isolate agents, runs, and history. Organization API keys, model providers, storage, and MCP connections are shared with every project."
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!nameError && !slugError) onSubmit({ slug, name: name.trim() });
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
            disabled={Boolean(nameError || slugError)}
          >
            {pending ? "Creating…" : "Create project"}
          </Button>
        </>
      }
    >
      <Field
        label="Project name"
        {...(name.length > 0 && nameError ? { error: nameError } : {})}
      >
        <Input
          autoFocus
          value={name}
          maxLength={200}
          placeholder="Evaluation lab"
          onChange={(event) => {
            setName(event.target.value);
            if (!slugEdited) setSlug(deriveProjectSlug(event.target.value));
          }}
        />
      </Field>
      <Field
        label="Project slug"
        {...(slug.length > 0 && slugError ? { error: slugError } : {})}
      >
        <Input
          value={slug}
          maxLength={80}
          placeholder="evaluation-lab"
          onChange={(event) => {
            setSlugEdited(true);
            setSlug(event.target.value);
          }}
        />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

function DeleteProjectDialog({
  project,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly project: SettingsProject;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      title={`Delete ${project.name}`}
      description="This permanently removes the project and everything in it."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" loading={pending} onClick={onConfirm}>
            {pending ? "Deleting…" : "Delete project"}
          </Button>
        </>
      }
    >
      <Alert tone="warning" title="This cannot be undone">
        Every agent, run, event, and piece of history in{" "}
        <code>{project.slug}</code> is permanently deleted. Organization-shared
        API keys, model providers, storage, and MCP connections are kept.
      </Alert>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

function CreateApiKeyDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateApiKeyInput) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(
    () => new Set<string>(DEFAULT_API_KEY_SCOPES),
  );
  const nameError =
    name.trim().length === 0
      ? "Name is required."
      : name.trim().length > 200
        ? "Name must contain at most 200 characters."
        : undefined;
  const scopesError =
    scopes.size === 0 ? "Select at least one project scope." : undefined;
  return (
    <Dialog
      title="Create API key"
      description="Choose the least privilege this server-side integration needs. The secret is shown once after creation."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!nameError && !scopesError)
          onSubmit({ name: name.trim(), scopes: [...scopes] });
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
            disabled={Boolean(nameError || scopesError)}
          >
            {pending ? "Creating…" : "Create API key"}
          </Button>
        </>
      }
    >
      <Field
        label="Name"
        {...(name.length > 0 && nameError ? { error: nameError } : {})}
      >
        <Input
          autoFocus
          value={name}
          maxLength={200}
          placeholder="Production integration"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <fieldset className="scope-picker">
        <legend>Project scopes</legend>
        <span className="hint">
          Scopes can be narrowed by replacing the key.
        </span>
        <div className="scope-picker-grid">
          {API_KEY_SCOPES.map(([scope, description]) => (
            <CheckboxRow
              key={scope}
              label={scope}
              description={description}
              checked={scopes.has(scope)}
              onChange={(event) => {
                setScopes((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(scope);
                  else next.delete(scope);
                  return next;
                });
              }}
            />
          ))}
        </div>
        {scopesError ? <FormError>{scopesError}</FormError> : null}
      </fieldset>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

function CreatedApiKeyDialog({
  apiKey,
  onClose,
}: {
  readonly apiKey: CreatedApiKey;
  readonly onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  return (
    <Dialog
      title="Save API key"
      description={`OAO stored ${apiKey.name} as a keyed hash.`}
      onClose={onClose}
      footer={
        <>
          {apiKey.shown ? (
            <Button
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
                  .writeText(apiKey.secret)
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
          ) : null}
          <Button variant="primary" onClick={onClose}>
            I’ve saved it
          </Button>
        </>
      }
    >
      {apiKey.shown ? (
        <>
          <Alert tone="warning" role="alert" title="Shown only once">
            Save this secret now. Closing this dialog permanently removes it
            from the console.
          </Alert>
          <Field label="API key secret">
            <Input
              className="input--mono"
              readOnly
              spellCheck={false}
              value={apiKey.secret}
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          {copyError ? <FormError>{copyError}</FormError> : null}
        </>
      ) : (
        <Alert tone="danger" role="alert" title="Secret is no longer available">
          This creation request was replayed after the secret had already been
          shown. Revoke this key and create another before using the
          integration.
        </Alert>
      )}
    </Dialog>
  );
}

function ConsolePreferences() {
  const [absoluteTimestamps, setAbsoluteTimestamps] = useState(false);
  return (
    <div className="settings-layout">
      <Panel
        title="Console behavior"
        description="Operator-facing display and safety settings."
      >
        <div className="setting-row">
          <span className="who">
            <strong>Safe event projection</strong>
            <small>
              Display only public event payloads in lists, transcript, and debug
              views. Enforced by the platform.
            </small>
          </span>
          <Switch label="Enabled" checked disabled onChange={() => undefined} />
        </div>
        <div className="setting-row">
          <span className="who">
            <strong>Absolute timestamps</strong>
            <small>
              Show locale-aware absolute timestamps for audit clarity.
            </small>
          </span>
          <Switch
            label="Enabled"
            checked={absoluteTimestamps}
            onChange={setAbsoluteTimestamps}
          />
        </div>
      </Panel>
      <Panel
        title="Data boundaries"
        description="These are enforced by the platform, not a display preference."
      >
        <ul className="safety-list">
          <li>
            Model reasoning and tool input/output are returned in authorized
            session transcripts.
          </li>
          <li>
            Authorization headers and secrets are removed from product events.
          </li>
          <li>
            Redacted payloads require a separate authorized retrieval path.
          </li>
          <li>API access tokens are sent in headers, never URLs.</li>
        </ul>
      </Panel>
    </div>
  );
}

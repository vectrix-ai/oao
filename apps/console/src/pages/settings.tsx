import {
  Activity,
  Boxes,
  CircleGauge,
  Database,
  KeyRound,
  Layers3,
  Plus,
  Settings,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { useApi } from "../api/context";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusPill,
  formatDate,
} from "../components/ui";

type SettingsRoute =
  "organization" | "projects" | "members" | "api-keys" | "settings" | "hosting";

const copy: Record<
  SettingsRoute,
  { eyebrow: string; title: string; description: string }
> = {
  organization: {
    eyebrow: "Manage",
    title: "Organization",
    description: "Identity and tenancy details for this organization.",
  },
  projects: {
    eyebrow: "Manage",
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
  settings: {
    eyebrow: "Manage",
    title: "Settings",
    description: "Console preferences and public data-handling behavior.",
  },
  hosting: {
    eyebrow: "Operations",
    title: "Hosting diagnostics",
    description: "Observed service health and configured adapter locations.",
  },
};

export function SettingsPage() {
  const api = useApi();
  const location = useLocation();
  const route = (
    location.pathname === "/settings/hosting"
      ? "hosting"
      : location.pathname.slice(1) || "settings"
  ) as SettingsRoute;
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });
  const heading = copy[route] ?? copy.settings;
  if (query.isPending)
    return (
      <div className="page">
        <LoadingState label={`Loading ${heading.title.toLowerCase()}`} />
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <div className="page">
      <PageHeader
        {...heading}
        actions={
          route === "projects" ||
          route === "members" ||
          route === "api-keys" ? (
            <button className="button">
              <Plus size={16} />
              {route === "projects"
                ? "New project"
                : route === "members"
                  ? "Invite member"
                  : "Create API key"}
            </button>
          ) : undefined
        }
      />
      {renderSettings(route, query.data)}
    </div>
  );
}

function renderSettings(
  route: SettingsRoute,
  data: Awaited<ReturnType<ReturnType<typeof useApi>["getSettings"]>>,
) {
  if (route === "organization")
    return (
      <section className="panel settings-form">
        <div className="section-heading">
          <div>
            <h2>Organization details</h2>
            <p>Stable identity repeated across tenant-owned resources.</p>
          </div>
          <Boxes />
        </div>
        <dl className="definition-grid">
          <div>
            <dt>Name</dt>
            <dd>{data.organization.name}</dd>
          </div>
          <div>
            <dt>Slug</dt>
            <dd>
              <code>{data.organization.slug}</code>
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(data.organization.createdAt)}</dd>
          </div>
        </dl>
      </section>
    );
  if (route === "projects")
    return (
      <section className="cards-grid">
        {data.projects.map((project) => (
          <article className="resource-card" key={project.id}>
            <Layers3 />
            <div>
              <h2>{project.name}</h2>
              <code>{project.slug}</code>
            </div>
            <Link to="/agents">Open project</Link>
          </article>
        ))}
      </section>
    );
  if (route === "members")
    return (
      <section className="table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <span className="member-cell">
                      <span className="avatar">
                        {member.name
                          .split(" ")
                          .map((part) => part[0])
                          .join("")
                          .slice(0, 2)}
                      </span>
                      <strong>{member.name}</strong>
                    </span>
                  </td>
                  <td>{member.email}</td>
                  <td>
                    <StatusPill value={member.role} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  if (route === "api-keys")
    return data.apiKeys.length === 0 ? (
      <EmptyState
        title="No API keys"
        description="Create a scoped key for a project integration."
      />
    ) : (
      <section className="table-card">
        <div className="table-scroll">
          <table>
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
                      <KeyRound size={16} />
                      <strong>{key.name}</strong>
                    </span>
                  </td>
                  <td>
                    <code>{key.prefix}</code>
                  </td>
                  <td>
                    {key.scopes.map((scope) => (
                      <span className="scope" key={scope}>
                        {scope}
                      </span>
                    ))}
                  </td>
                  <td>
                    {key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  if (route === "hosting")
    return (
      <>
        <div className="notice notice--warning">
          <Activity size={18} />
          <div>
            <strong>Operational diagnostics only</strong>
            <span>
              Regions below are adapter configuration and health observations.
              They are not a data-residency or compliance claim.
            </span>
          </div>
        </div>
        <section className="hosting-grid">
          {data.hosting.map((service) => (
            <article className="service-card" key={service.service}>
              <header>
                <span className="service-icon">
                  {service.service === "PostgreSQL" ? (
                    <Database />
                  ) : (
                    <CircleGauge />
                  )}
                </span>
                <div>
                  <h2>{service.service}</h2>
                  <StatusPill value={service.status} />
                </div>
              </header>
              <dl>
                <div>
                  <dt>Adapter location</dt>
                  <dd>{service.region}</dd>
                </div>
                <div>
                  <dt>Latency</dt>
                  <dd>
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
  return (
    <div className="settings-layout">
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Console behavior</h2>
            <p>Operator-facing display and safety settings.</p>
          </div>
          <Settings />
        </div>
        <label className="setting-row">
          <span>
            <strong>Safe event projection</strong>
            <small>
              Display only public event payloads in lists, transcript, and debug
              views.
            </small>
          </span>
          <input type="checkbox" checked readOnly />
        </label>
        <label className="setting-row">
          <span>
            <strong>Relative timestamps</strong>
            <small>
              Show locale-aware absolute timestamps for audit clarity.
            </small>
          </span>
          <input type="checkbox" />
        </label>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Data boundaries</h2>
            <p>
              These controls are enforced by the platform, not a display
              preference.
            </p>
          </div>
        </div>
        <ul className="safety-list">
          <li>Raw chain-of-thought is never returned to the console.</li>
          <li>
            Authorization headers and secrets are removed from product events.
          </li>
          <li>
            Redacted payloads require a separate authorized retrieval path.
          </li>
          <li>API access tokens are sent in headers, never URLs.</li>
        </ul>
      </section>
    </div>
  );
}

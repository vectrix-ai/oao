import {
  Activity,
  Bot,
  Boxes,
  ChevronDown,
  CircleHelp,
  Clock3,
  KeyRound,
  Layers3,
  Menu,
  Settings,
  Users,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { useState } from "react";
import { useApi, useProjectEvents } from "../api/context";

const primaryNav = [
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/sessions", label: "Sessions", icon: Clock3 },
  { to: "/pending-work", label: "Pending Work", icon: Activity },
];
const manageNav = [
  { to: "/organization", label: "Organization", icon: Boxes },
  { to: "/projects", label: "Projects", icon: Layers3 },
  { to: "/members", label: "Members", icon: Users },
  { to: "/api-keys", label: "API keys", icon: KeyRound },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  const api = useApi();
  const context = useQuery({
    queryKey: ["context"],
    queryFn: () => api.getContext(),
  });
  const events = useProjectEvents();
  const [mobileOpen, setMobileOpen] = useState(false);
  const principal = context.data?.currentPrincipal;
  return (
    <div className="app-shell">
      <header className="mobile-header">
        <button
          className="icon-button"
          aria-label="Open navigation"
          onClick={() => setMobileOpen(true)}
        >
          <Menu />
        </button>
        <strong>OAO</strong>
      </header>
      <aside
        className={`sidebar${mobileOpen ? " sidebar--open" : ""}`}
        aria-label="Primary navigation"
      >
        <div className="brand">
          <div className="brand-mark">O</div>
          <div>
            <strong>OAO</strong>
            <span>Management console</span>
          </div>
          <button
            className="icon-button sidebar-close"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X />
          </button>
        </div>
        <div className="tenant-picker">
          <label>
            Organization
            <select
              aria-label="Organization"
              value={context.data?.organization.id ?? ""}
              onChange={() => undefined}
            >
              <option value={context.data?.organization.id}>
                {context.data?.organization.name ?? "Loading…"}
              </option>
            </select>
            <ChevronDown aria-hidden="true" />
          </label>
          <label>
            Project
            <select
              aria-label="Project"
              value={context.data?.project.id ?? ""}
              onChange={() => undefined}
            >
              {context.data?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </label>
        </div>
        <nav>
          <span className="nav-label">Operate</span>
          {primaryNav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} onClick={() => setMobileOpen(false)}>
              <Icon size={17} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
          <span className="nav-label">Manage</span>
          {manageNav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} onClick={() => setMobileOpen(false)}>
              <Icon size={17} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <footer>
          <div className="connection">
            <span className={events.error ? "dot dot--error" : "dot"} />
            {events.error
              ? "Events reconnecting"
              : events.connected
                ? "Live events connected"
                : "Connecting events"}
          </div>
          <a href="/settings/hosting">
            <CircleHelp size={16} />
            Hosting diagnostics
          </a>
          {principal ? (
            <div className="avatar-row">
              <span className="avatar">{initials(principal.displayName)}</span>
              <div>
                <strong>{principal.displayName}</strong>
                <span>{principal.role}</span>
              </div>
            </div>
          ) : null}
        </footer>
      </aside>
      {mobileOpen ? (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <main id="main-content">
        <Outlet />
      </main>
    </div>
  );
}

function initials(displayName: string): string {
  return displayName
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

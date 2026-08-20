import {
  Activity,
  Box,
  Bot,
  Boxes,
  CircleHelp,
  Clock3,
  Cpu,
  Database,
  KeyRound,
  Layers3,
  Menu,
  Moon,
  Settings,
  Sun,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { useState } from "react";
import { useApi, useProjectEvents } from "../api/context";
import { applyConsoleTheme, readConsoleTheme } from "../theme";
import { Button, IconButton } from "./button";
import { BadgeCount, Chip } from "./chip";
import { initials } from "./format";

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Queue key whose outstanding count is surfaced as a badge. */
  readonly queue?: "pending-work";
}

/**
 * Navigation is grouped by intent, matching the console design system:
 * build the thing, observe it running, configure the tenancy around it.
 */
const navGroups: readonly {
  readonly label: string;
  readonly items: readonly NavItem[];
}[] = [
  {
    label: "Build",
    items: [
      { to: "/agents", label: "Agents", icon: Bot },
      { to: "/models", label: "Models", icon: Cpu },
    ],
  },
  {
    label: "Observe",
    items: [
      { to: "/sessions", label: "Sessions", icon: Clock3 },
      {
        to: "/pending-work",
        label: "Pending Work",
        icon: Activity,
        queue: "pending-work",
      },
    ],
  },
  {
    label: "Configure",
    items: [
      { to: "/organization", label: "Organization", icon: Boxes },
      { to: "/projects", label: "Projects", icon: Layers3 },
      { to: "/members", label: "Members", icon: Users },
      { to: "/api-keys", label: "API keys", icon: KeyRound },
      { to: "/sandbox-providers", label: "Sandbox providers", icon: Box },
      { to: "/storage-providers", label: "Storage providers", icon: Database },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function AppLayout() {
  const api = useApi();
  const context = useQuery({
    queryKey: ["context"],
    queryFn: () => api.getContext(),
  });
  const pendingWork = useQuery({
    queryKey: ["pending-work"],
    queryFn: () => api.listPendingWork(),
  });
  const events = useProjectEvents();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(readConsoleTheme);
  const principal = context.data?.currentPrincipal;
  const nextTheme = theme === "light" ? "dark" : "light";
  const themeLabel = `Use ${nextTheme} appearance`;
  const queueCounts = { "pending-work": pendingWork.data?.length ?? 0 };

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <IconButton
          className="topbar-menu"
          label="Open navigation"
          onClick={() => setMobileOpen(true)}
        >
          <Menu size={18} />
        </IconButton>
        <NavLink className="topbar-brand" to="/agents">
          <img
            className="invert-dark"
            src="/brand/oao-wordmark-black.png"
            alt="OAO"
          />
          <span className="product">Console</span>
        </NavLink>
        <div className="context-switcher">
          <select
            className="select context-select"
            aria-label="Organization"
            value={context.data?.organization.id ?? ""}
            onChange={() => undefined}
          >
            {context.data ? (
              <option value={context.data.organization.id}>
                {context.data.organization.name}
              </option>
            ) : (
              <option value="">Loading…</option>
            )}
          </select>
          <span className="sep" aria-hidden="true">
            /
          </span>
          <select
            className="select context-select"
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
        </div>
        <span className="topbar-spacer" />
        <div className="topbar-actions">
          <ConnectionChip
            connected={events.connected}
            error={events.error !== null}
          />
          <Button
            size="sm"
            aria-label={themeLabel}
            icon={theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
            onClick={() => {
              applyConsoleTheme(nextTheme);
              setTheme(nextTheme);
            }}
          >
            <span className="hide-sm">{themeLabel}</span>
          </Button>
          {principal ? (
            <div className="user-chip">
              <span className="avatar" aria-hidden="true">
                {initials(principal.displayName)}
              </span>
              <span className="who">
                <strong>{principal.displayName}</strong>
                <span>{principal.role}</span>
              </span>
            </div>
          ) : null}
        </div>
      </header>
      <div className="app-body">
        <nav
          className={`sidenav${mobileOpen ? " sidenav--open" : ""}`}
          aria-label="Primary navigation"
        >
          <div className="sidenav-head">
            <img
              className="invert-dark"
              src="/brand/oao-wordmark-black.png"
              alt="OAO"
              height={14}
            />
            <IconButton
              className="sidenav-close"
              label="Close navigation"
              onClick={() => setMobileOpen(false)}
            >
              <X size={18} />
            </IconButton>
          </div>
          {navGroups.map((group) => (
            <div key={group.label}>
              <span className="nav-group">{group.label}</span>
              {group.items.map(({ to, label, icon: Icon, queue }) => {
                const count = queue ? queueCounts[queue] : 0;
                return (
                  <NavLink
                    key={to}
                    to={to}
                    onClick={() => setMobileOpen(false)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {label}
                    {count > 0 ? <BadgeCount value={count} /> : null}
                  </NavLink>
                );
              })}
            </div>
          ))}
          <div className="sidenav-foot">
            <NavLink
              to="/settings/hosting"
              onClick={() => setMobileOpen(false)}
            >
              <CircleHelp size={16} aria-hidden="true" />
              Hosting diagnostics
            </NavLink>
          </div>
        </nav>
        {mobileOpen ? (
          <button
            className="sidenav-scrim"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}
        <main className="app-main" id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ConnectionChip({
  connected,
  error,
}: {
  readonly connected: boolean;
  readonly error: boolean;
}) {
  const tone = error ? "warning" : connected ? "success" : "neutral";
  const short = error
    ? "Events reconnecting"
    : connected
      ? "Live events"
      : "Connecting events";
  const full = error
    ? "Events reconnecting"
    : connected
      ? "Live events connected"
      : "Connecting events";
  return (
    <Chip tone={tone} live={connected && !error}>
      {/* The chip shrinks to a dot on narrow viewports, so the full status
          stays available to assistive technology either way. */}
      <span className="hide-sm" aria-hidden="true">
        {short}
      </span>
      <span className="sr-only">{full}</span>
    </Chip>
  );
}

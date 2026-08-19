import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router";
import type { ConsoleApi } from "./api/types";
import { ConsoleApiProvider } from "./api/context";
import { AppLayout } from "./components/layout";
import { AgentDetailPage, AgentsPage } from "./pages/agents";
import { PendingWorkPage } from "./pages/pending-work";
import { SessionDetailPage, SessionsPage } from "./pages/sessions";
import { SettingsPage } from "./pages/settings";

export function ConsoleApp({
  api,
  queryClient,
}: {
  readonly api?: ConsoleApi;
  readonly queryClient?: QueryClient;
}) {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { staleTime: 15_000, retry: false } },
    });
  const routes = (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:agentId" element={<AgentDetailPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="sessions/:sessionId" element={<SessionDetailPage />} />
        <Route path="pending-work" element={<PendingWorkPage />} />
        <Route path="organization" element={<SettingsPage />} />
        <Route path="projects" element={<SettingsPage />} />
        <Route path="members" element={<SettingsPage />} />
        <Route path="api-keys" element={<SettingsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/hosting" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Route>
    </Routes>
  );
  return (
    <QueryClientProvider client={client}>
      {api ? (
        <ConsoleApiProvider api={api}>{routes}</ConsoleApiProvider>
      ) : (
        <ConsoleApiProvider>{routes}</ConsoleApiProvider>
      )}
    </QueryClientProvider>
  );
}

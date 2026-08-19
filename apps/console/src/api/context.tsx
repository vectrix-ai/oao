import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ProductEvent } from "@oao/contracts";
import { DemoConsoleApi, createDemoApiFromLocation } from "./demo";
import { HttpConsoleApi } from "./http";
import type { ConsoleApi, SessionDetail, SessionSummary } from "./types";

const ApiContext = createContext<ConsoleApi | null>(null);

export function ConsoleApiProvider({
  children,
  api,
}: {
  readonly children: ReactNode;
  readonly api?: ConsoleApi;
}) {
  const value = useMemo(
    () =>
      api ??
      (import.meta.env.VITE_OAO_API_MODE === "http"
        ? new HttpConsoleApi()
        : createDemoApiFromLocation()),
    [api],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ConsoleApi {
  const value = useContext(ApiContext);
  if (!value) throw new Error("Console API provider is missing");
  return value;
}

function applyRunState<T extends SessionSummary | SessionDetail>(
  item: T,
  event: ProductEvent,
): T {
  const nextState = event.publicPayload.state;
  const sessionId = event.publicPayload.sessionId;
  return (event.aggregateId === item.id || sessionId === item.id) &&
    typeof nextState === "string"
    ? {
        ...item,
        status: nextState as T["status"],
        lastActivityAt: event.occurredAt,
      }
    : item;
}

export function useProjectEvents(): {
  readonly connected: boolean;
  readonly error: string | null;
} {
  const api = useApi();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const after = sessionStorage.getItem("oao:event-cursor");
    const connection = api.connectEvents({
      ...(after ? { after } : {}),
      signal: controller.signal,
      onCursor: (cursor) => sessionStorage.setItem("oao:event-cursor", cursor),
      onError: (streamError) => {
        setConnected(false);
        setError(streamError.message);
      },
      onEvent: (event) => {
        setConnected(true);
        setError(null);
        const sessionId =
          typeof event.publicPayload.sessionId === "string"
            ? event.publicPayload.sessionId
            : event.aggregateId;
        if (event.kind === "run.state_changed") {
          queryClient.setQueriesData<{ data: SessionSummary[] }>(
            { queryKey: ["sessions"] },
            (old) =>
              old
                ? {
                    ...old,
                    data: old.data.map((session) =>
                      applyRunState(session, event),
                    ),
                  }
                : old,
          );
          queryClient.setQueryData<SessionDetail>(
            ["session", sessionId],
            (old) => (old ? applyRunState(old, event) : old),
          );
        }
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({
          queryKey: ["session", sessionId],
        });
        if (
          event.kind.startsWith("tool_call.") ||
          event.kind.startsWith("approval.")
        )
          void queryClient.invalidateQueries({ queryKey: ["pending-work"] });
      },
    });
    return () => {
      controller.abort();
      connection.close();
    };
  }, [api, queryClient]);

  return { connected, error };
}

export { DemoConsoleApi };

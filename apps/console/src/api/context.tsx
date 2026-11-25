import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProductEvent } from "@oao/contracts";
import { DemoConsoleApi, createDemoApiFromLocation } from "./demo";
import { HttpConsoleApi } from "./http";
import type { ConsoleApi, SessionDetail, SessionSummary } from "./types";

const EVENT_INVALIDATION_COALESCE_MS = 250;
const MAX_COALESCED_SESSION_IDS = 20;

const ApiContext = createContext<ConsoleApi | null>(null);

function configuredAuthProvider():
  "development" | "iap" | "workos" | undefined {
  const provider = import.meta.env.VITE_OAO_AUTH_PROVIDER;
  return provider === "development" ||
    provider === "iap" ||
    provider === "workos"
    ? provider
    : undefined;
}

export function ConsoleApiProvider({
  children,
  api,
}: {
  readonly children: ReactNode;
  readonly api?: ConsoleApi;
}) {
  const value = useMemo(() => {
    if (api) return api;
    if (import.meta.env.VITE_OAO_API_MODE !== "http")
      return createDemoApiFromLocation();
    const authProvider = configuredAuthProvider();
    return new HttpConsoleApi(authProvider ? { authProvider } : {});
  }, [api]);
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
  const context = useQuery({
    queryKey: ["context"],
    queryFn: () => api.getContext(),
  });
  const projectId = context.data?.project.id;
  const previousProjectIdRef = useRef<string | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const switchedProject =
      previousProjectIdRef.current !== undefined &&
      previousProjectIdRef.current !== projectId;
    previousProjectIdRef.current = projectId;

    const controller = new AbortController();
    let disposed = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing = false;
    let needsReflush = false;
    let dirtySessions = false;
    let dirtyUsage = false;
    let dirtyPendingWork = false;
    let dirtyAllSessionDetails = false;
    const dirtySessionIds = new Set<string>();

    setConnected(false);
    setError(null);

    const scheduleFlush = () => {
      if (disposed) return;
      if (flushing) {
        needsReflush = true;
        return;
      }
      if (flushTimer !== undefined) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flush();
      }, EVENT_INVALIDATION_COALESCE_MS);
    };

    const flush = async () => {
      if (disposed || flushing) return;
      const sessions = dirtySessions;
      const usage = dirtyUsage;
      const pendingWork = dirtyPendingWork;
      const allSessionDetails = dirtyAllSessionDetails;
      const sessionIds = [...dirtySessionIds];
      const sessionIdSet = new Set(sessionIds);
      dirtySessions = false;
      dirtyUsage = false;
      dirtyPendingWork = false;
      dirtyAllSessionDetails = false;
      dirtySessionIds.clear();
      if (
        !sessions &&
        !usage &&
        !pendingWork &&
        !allSessionDetails &&
        sessionIds.length === 0
      ) {
        return;
      }
      flushing = true;
      needsReflush = false;
      try {
        const invalidations: Promise<void>[] = [];
        if (sessions) {
          invalidations.push(
            queryClient.invalidateQueries({ queryKey: ["sessions"] }),
          );
        }
        if (allSessionDetails) {
          invalidations.push(
            queryClient.invalidateQueries({ queryKey: ["session"] }),
          );
        } else {
          for (const id of sessionIds) {
            invalidations.push(
              queryClient.invalidateQueries({ queryKey: ["session", id] }),
            );
          }
          if (usage) {
            invalidations.push(
              queryClient.invalidateQueries({
                predicate: ({ queryKey }) =>
                  queryKey[0] === "session" &&
                  queryKey[2] === "usage" &&
                  !sessionIdSet.has(String(queryKey[1])),
              }),
            );
          }
        }
        if (pendingWork) {
          invalidations.push(
            queryClient.invalidateQueries({ queryKey: ["pending-work"] }),
          );
        }
        await Promise.allSettled(invalidations);
      } finally {
        flushing = false;
        if (needsReflush && !disposed) {
          needsReflush = false;
          scheduleFlush();
        }
      }
    };

    const cursorKey = `oao:event-cursor:${projectId}`;
    const after = switchedProject ? null : sessionStorage.getItem(cursorKey);
    let syncedFromNow = Boolean(after);
    const connection = api.connectEvents({
      projectId,
      ...(after ? { after } : { from: "now" }),
      signal: controller.signal,
      onOpen: () => {
        if (disposed) return;
        setConnected(true);
        setError(null);
        // Close any race between initial REST reads and the server's from=now
        // head lookup with one coalesced refresh after the stream cursor is fixed.
        if (!syncedFromNow) {
          syncedFromNow = true;
          dirtySessions = true;
          dirtyAllSessionDetails = true;
          dirtyPendingWork = true;
          scheduleFlush();
        }
      },
      onCursor: (cursor) => {
        if (disposed) return;
        sessionStorage.setItem(cursorKey, cursor);
      },
      onError: (streamError) => {
        if (disposed) return;
        setConnected(false);
        setError(streamError.message);
      },
      onEvent: (event) => {
        if (disposed) return;
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
        dirtySessions = true;
        if (!dirtyAllSessionDetails) {
          dirtySessionIds.add(sessionId);
          if (dirtySessionIds.size > MAX_COALESCED_SESSION_IDS) {
            dirtyAllSessionDetails = true;
            dirtySessionIds.clear();
          }
        }
        // A delegate's calls count towards the sessions above it too, and
        // its events don't name them.
        if (
          event.kind === "model.invocation_completed" ||
          event.kind === "model.invocation_failed" ||
          event.kind === "run.state_changed"
        ) {
          dirtyUsage = true;
        }
        if (
          event.kind.startsWith("tool_call.") ||
          event.kind.startsWith("approval.")
        ) {
          dirtyPendingWork = true;
        }
        scheduleFlush();
      },
    });

    return () => {
      disposed = true;
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      controller.abort();
      connection.close();
    };
  }, [api, projectId, queryClient]);

  const contextError =
    !context.data && context.isError
      ? context.error instanceof Error
        ? context.error.message
        : "Unable to load project context"
      : null;

  return {
    connected: contextError ? false : connected,
    error: contextError ?? error,
  };
}

export { DemoConsoleApi };

import type { Principal } from "@oao/domain";
import { createOaoMcpHandler } from "@oao/mcp-server";
import { OaoClient } from "@oao/sdk-js";
import type { Hono } from "hono";

import { HttpApiError } from "./errors.js";

type Variables = { principal: Principal; requestId: string };

/**
 * Serves the OAO MCP server for one project at /v1/projects/{projectId}/mcp.
 *
 * Each tool call goes back through this same API in process, carrying the
 * caller's own bearer credential, so authentication, row-level security,
 * idempotency, and audit are exactly those of the REST call it wraps.
 */
export function registerOaoMcpRoute(
  app: Hono<{ Variables: Variables }>,
  options: {
    readonly onError?: (input: {
      readonly requestId: string;
      readonly error: unknown;
    }) => void;
  } = {},
): void {
  const handler = createOaoMcpHandler(
    options.onError
      ? {
          reportError: (error) =>
            options.onError?.({ requestId: "oao-mcp", error }),
        }
      : {},
  );
  app.all("/v1/projects/:projectId/mcp", async (c) => {
    const actor = c.get("principal");
    if (actor.projectId !== c.req.param("projectId"))
      throw new HttpApiError(
        "forbidden",
        "Project is outside the principal scope",
      );
    // Browser sessions are not accepted: a cookie would let any page the
    // user visits drive the tools.
    const authorization = c.req.header("authorization") ?? "";
    const bearer = /^Bearer\s+(oao_\S+)$/u.exec(authorization)?.[1];
    if (!bearer)
      throw new HttpApiError(
        "unauthenticated",
        "The OAO MCP server accepts only an OAO API key as a bearer token",
      );
    const client = new OaoClient({
      baseUrl: new URL(c.req.url).origin,
      fetch: async (input, init) => app.fetch(new Request(input, init)),
      bearerToken: bearer,
    });
    return handler.fetch(c.req.raw, {
      client,
      projectId: actor.projectId,
      scopes: actor.scopes,
      projectRestricted: actor.projectRestricted === true,
    });
  });
}

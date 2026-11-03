import { randomUUID } from "node:crypto";

import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { OaoApiError, type OaoClient } from "@oao/sdk-js";
import * as v from "valibot";

import { toolInput } from "./schema.js";
import {
  availableOaoTools,
  OaoToolInputError,
  type OaoTool,
  type OaoToolContext,
} from "./tools.js";

export const OAO_MCP_SERVER_NAME = "oao";
export const OAO_MCP_SERVER_VERSION = "0.13.0"; // x-release-please-version

/** Who is calling and how their tool calls reach the OAO API. */
export interface OaoMcpCaller {
  /** A client that sends the caller's own credential with every request. */
  readonly client: OaoClient;
  readonly projectId: string;
  readonly scopes: ReadonlySet<string>;
  readonly projectRestricted?: boolean;
  /**
   * The base of the Idempotency-Keys of a call that names none. Defaults to
   * a random value, so a call without its own key is a new logical write.
   */
  readonly idempotencyBase?: (toolName: string) => string;
  readonly tools?: readonly OaoTool[];
}

/** Reports a tool failure that is not an OAO API error, such as a bug. */
export type OaoMcpErrorReporter = (error: unknown, toolName: string) => void;

const INSTRUCTIONS =
  "Manages one OAO project: agents and their versions, sessions and runs, " +
  "approvals, delegations, Skills, model presets, MCP connections, and the " +
  "audit trail. Every tool acts with the caller's own OAO permissions. To " +
  "ask an agent about an earlier run, find its session with list_sessions, " +
  "read it with get_session, and ask with send_message.";

/** Calls one tool and turns its outcome into an MCP tool result. */
export async function callOaoTool(
  tool: OaoTool,
  input: Readonly<Record<string, unknown>>,
  context: OaoToolContext,
  reportError?: OaoMcpErrorReporter,
): Promise<CallToolResult> {
  try {
    const result = await tool.run(input, context);
    return {
      content: [
        {
          type: "text",
          text:
            result === undefined
              ? '{"ok":true}'
              : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return toolError(error, tool.name, reportError);
  }
}

/** The idempotency key callback a call uses for each of its writes. */
export function callIdempotency(
  base: string,
): OaoToolContext["idempotencyKey"] {
  return (purpose) => `${base}:${purpose}`.slice(0, 200);
}

/** Builds the MCP server a caller sees, holding only the tools it may use. */
export function createOaoMcpServer(
  caller: OaoMcpCaller,
  reportError?: OaoMcpErrorReporter,
): McpServer {
  const server = new McpServer(
    { name: OAO_MCP_SERVER_NAME, version: OAO_MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of availableOaoTools(caller.scopes, {
    ...(caller.projectRestricted === undefined
      ? {}
      : { projectRestricted: caller.projectRestricted }),
    ...(caller.tools === undefined ? {} : { tools: caller.tools }),
  })) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toolInput(tool.input),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          openWorldHint: false,
        },
      },
      (input: Readonly<Record<string, unknown>>, ctx) => {
        const key =
          typeof input.idempotencyKey === "string"
            ? `mcp:${input.idempotencyKey}`
            : (caller.idempotencyBase?.(tool.name) ?? `mcp:${randomUUID()}`);
        return callOaoTool(
          tool,
          input,
          {
            client: caller.client,
            projectId: caller.projectId,
            idempotencyKey: callIdempotency(key),
            signal: ctx.mcpReq.signal,
          },
          reportError,
        );
      },
    );
  }
  return server;
}

const CALLER = Symbol("oao.mcp.caller");

/**
 * A stateless Streamable HTTP endpoint for the OAO MCP server. The host
 * authenticates the request, then passes the caller to `fetch`; each request
 * gets a fresh server holding that caller's tools.
 */
export function createOaoMcpHandler(
  options: { readonly reportError?: OaoMcpErrorReporter } = {},
) {
  const handler = createMcpHandler(
    (ctx) => {
      const caller = (ctx.authInfo?.extra as { [CALLER]?: OaoMcpCaller })?.[
        CALLER
      ];
      if (!caller) throw new Error("The OAO MCP caller is missing");
      return createOaoMcpServer(caller, options.reportError);
    },
    {
      legacy: "stateless",
      ...(options.reportError
        ? {
            onerror: (error: Error) =>
              options.reportError?.(error, "transport"),
          }
        : {}),
    },
  );
  return {
    fetch: (request: Request, caller: OaoMcpCaller): Promise<Response> =>
      handler.fetch(request, {
        authInfo: {
          token: "oao",
          clientId: OAO_MCP_SERVER_NAME,
          scopes: [...caller.scopes],
          extra: { [CALLER]: caller },
        },
      }),
    close: () => handler.close(),
  };
}

function toolError(
  error: unknown,
  toolName: string,
  reportError?: OaoMcpErrorReporter,
): CallToolResult {
  let body: Readonly<Record<string, unknown>>;
  if (error instanceof OaoApiError)
    body = {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  else if (error instanceof OaoToolInputError || v.isValiError(error))
    body = { code: "bad_request", message: error.message };
  else {
    reportError?.(error, toolName);
    body = { code: "internal", message: "The tool failed unexpectedly" };
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: body }) }],
  };
}

import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ManagedAgentOaoTools } from "@oao/contracts";
import {
  withTenantTransaction,
  type PgPool,
  type TenantContext,
} from "@oao/db-postgres";
import type { RunId } from "@oao/domain";
import {
  callIdempotency,
  OaoToolInputError,
  type OaoTool,
} from "@oao/mcp-server";
import { OaoApiError, OaoClient } from "@oao/sdk-js";
import * as v from "valibot";

/** What an agent's OAO tool call returns to the model. */
export interface OaoToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/** Runs an agent's built-in OAO tool against the OAO API. */
export interface OaoToolExecutionPort {
  execute(
    tenant: TenantContext & {
      readonly runId: RunId;
      readonly flueToolCallId: string;
    },
    tool: OaoTool,
    grant: ManagedAgentOaoTools,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<OaoToolResult>;
}

/** Longest result text handed back to the model. */
export const OAO_TOOL_RESULT_CHARACTERS = 60_000;
/** A run token outlives the longest wait a tool makes. */
const RUN_TOKEN_LIFETIME_MS = 15 * 60_000;

/**
 * Calls the OAO API for an agent's OAO tool. Each call gets its own run
 * token, deleted when the call ends: the API resolves it to the run's
 * creator, narrowed to the agent's grant and the creator's live scopes, and
 * only while the run is unsettled. Writes use the tool call's identity as
 * their Idempotency-Key, so a replayed call repeats nothing.
 */
export function createOaoToolExecutor(input: {
  readonly pool: PgPool;
  /** The OAO API origin, for example http://127.0.0.1:3000. */
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}): OaoToolExecutionPort {
  return {
    async execute(tenant, tool, grant, arguments_, signal) {
      if (!input.apiUrl)
        throw new Error(
          "OAO tools need OAO_API_URL to be set on the runtime worker",
        );
      const token = `oao_run_${randomBytes(32).toString("base64url")}`;
      const tokenId = randomUUID();
      await withTenantTransaction(input.pool, tenant, (transaction) =>
        transaction.query(
          `INSERT INTO oao.run_access_tokens
             (organization_id,project_id,id,run_id,token_hash,scopes,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp() + make_interval(secs => $7))`,
          [
            tenant.organizationId,
            tenant.projectId,
            tokenId,
            tenant.runId,
            createHash("sha256").update(token).digest(),
            grant.scopes,
            RUN_TOKEN_LIFETIME_MS / 1000,
          ],
        ),
      );
      try {
        const result = await tool.run(arguments_, {
          client: new OaoClient({
            baseUrl: input.apiUrl,
            bearerToken: token,
            ...(input.fetch ? { fetch: input.fetch } : {}),
          }),
          projectId: tenant.projectId,
          idempotencyKey: callIdempotency(
            `platform:${tenant.runId}:${tenant.flueToolCallId}`,
          ),
          ...(signal ? { signal } : {}),
        });
        return {
          content: bounded(JSON.stringify(result ?? { ok: true })),
          isError: false,
        };
      } catch (error) {
        // The model sees why the API refused, for example a busy session.
        if (error instanceof OaoApiError)
          return {
            content: JSON.stringify({
              error: {
                status: error.status,
                code: error.code,
                message: error.message,
              },
            }),
            isError: true,
          };
        if (error instanceof OaoToolInputError || v.isValiError(error))
          return {
            content: JSON.stringify({
              error: { code: "bad_request", message: error.message },
            }),
            isError: true,
          };
        throw error;
      } finally {
        await withTenantTransaction(input.pool, tenant, (transaction) =>
          transaction.query(
            "DELETE FROM oao.run_access_tokens WHERE organization_id=$1 AND project_id=$2 AND id=$3",
            [tenant.organizationId, tenant.projectId, tokenId],
          ),
        ).catch(() => undefined);
      }
    },
  };
}

function bounded(text: string): string {
  if (text.length <= OAO_TOOL_RESULT_CHARACTERS) return text;
  return `${text.slice(0, OAO_TOOL_RESULT_CHARACTERS)}\n…[${text.length - OAO_TOOL_RESULT_CHARACTERS} more characters cut; read a smaller page or a single item]`;
}

/**
 * The tool arguments kept in the tool ledger. Like delegation prompts,
 * messages and instructions sent to another agent are stored only as the
 * transcript of that run, so the ledger keeps their length.
 */
export function oaoToolLedgerArguments(
  arguments_: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const ledger: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(arguments_)) {
    if (key === "message" || key === "instructions")
      ledger[`${key}Characters`] = typeof value === "string" ? value.length : 0;
    else if (key === "config" || key === "files")
      ledger[`${key}Provided`] = value !== undefined;
    else ledger[key] = value;
  }
  return ledger;
}

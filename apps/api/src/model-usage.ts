import type {
  CostProvenance,
  ProjectUsage,
  ProjectUsageGroup,
  SessionUsage,
} from "@oao/contracts";
import type { PgClient } from "@oao/db-postgres";
import { publicValue } from "./http.js";

interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
}

type Window = readonly [start: number, end: number];

const DELEGATION_TOOLS = ["delegate_agent", "message_agent"];

/** How long at least one of the windows was open; parallel work counts once. */
export function mergedWindowMs(windows: readonly Window[]): number {
  const sorted = [...windows].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let currentStart = 0;
  let currentEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of sorted) {
    if (start > currentEnd) {
      if (currentEnd !== Number.NEGATIVE_INFINITY)
        total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }
  return currentEnd === Number.NEGATIVE_INFINITY
    ? total
    : total + currentEnd - currentStart;
}

/**
 * A model call that used tokens but has no price behind it. Calls recorded
 * before prices existed have no pricing source, so they count when their cost
 * is zero. A preset deliberately priced at zero does not.
 */
export const UNPRICED_INVOCATION_SQL = `(m.cost_microunits=0
  AND m.input_tokens+m.output_tokens+m.cache_read_tokens+m.cache_write_tokens>0
  AND COALESCE(m.pricing_snapshot->>'source','')<>'preset_price')`;

type CostByKind = NonNullable<SessionUsage["costByKind"]>;

interface Totals {
  modelCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costMicrounits: number;
  unpricedCalls: number;
  /** Null once a charged call has no split: calls made before splits were recorded. */
  costByKind: CostByKind | null;
}

const emptyTotals = (): Totals => ({
  modelCalls: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costMicrounits: 0,
  unpricedCalls: 0,
  costByKind: {
    inputMicrounits: 0,
    cacheReadMicrounits: 0,
    cacheWriteMicrounits: 0,
    outputMicrounits: 0,
  },
});

interface InvocationRow {
  readonly session_id: string;
  readonly agent_id: string;
  readonly model_preset: string | null;
  readonly model_key: string;
  readonly input_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly cost_microunits: number;
  readonly usage_source: string;
  readonly unpriced: boolean;
  readonly cost_by_kind: CostByKind | null;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
}

function add(totals: Totals, row: InvocationRow): void {
  totals.modelCalls += 1;
  totals.inputTokens += row.input_tokens;
  totals.cacheReadTokens += row.cache_read_tokens;
  totals.cacheWriteTokens += row.cache_write_tokens;
  totals.outputTokens += row.output_tokens;
  totals.costMicrounits += row.cost_microunits;
  if (row.unpriced) totals.unpricedCalls += 1;
  if (row.cost_by_kind && totals.costByKind)
    totals.costByKind = {
      inputMicrounits:
        totals.costByKind.inputMicrounits + row.cost_by_kind.inputMicrounits,
      cacheReadMicrounits:
        totals.costByKind.cacheReadMicrounits +
        row.cost_by_kind.cacheReadMicrounits,
      cacheWriteMicrounits:
        totals.costByKind.cacheWriteMicrounits +
        row.cost_by_kind.cacheWriteMicrounits,
      outputMicrounits:
        totals.costByKind.outputMicrounits + row.cost_by_kind.outputMicrounits,
    };
  else if (row.cost_microunits > 0) totals.costByKind = null;
}

function callWindow(row: InvocationRow): Window | null {
  if (!row.started_at || !row.completed_at) return null;
  return [row.started_at.getTime(), row.completed_at.getTime()];
}

function provenance(rows: readonly InvocationRow[]): CostProvenance {
  if (rows.every((row) => row.usage_source === "unavailable"))
    return "unavailable";
  if (rows.some((row) => row.unpriced)) return "unpriced";
  return rows.every((row) => row.usage_source === "provider_reported")
    ? "provider_observed"
    : "estimated";
}

/**
 * What a session and the delegates it started used and cost. Null when the
 * session does not exist in this project.
 */
export async function readSessionUsage(
  transaction: PgClient,
  tenant: Tenant,
  sessionId: string,
): Promise<SessionUsage | null> {
  const scope = [tenant.organizationId, tenant.projectId];
  const sessions = await transaction.query<{
    readonly id: string;
    readonly agent_id: string;
    readonly agent_name: string;
  }>(
    `WITH RECURSIVE tree(session_id) AS (
       SELECT s.id FROM oao.sessions s
        WHERE s.organization_id=$1 AND s.project_id=$2 AND s.id=$3
       UNION
       SELECT relation.child_session_id
         FROM oao.agent_delegations relation
         JOIN tree ON relation.parent_session_id=tree.session_id
        WHERE relation.organization_id=$1 AND relation.project_id=$2
     )
     SELECT s.id,d.id AS agent_id,d.name AS agent_name
       FROM tree
       JOIN oao.sessions s
         ON s.organization_id=$1 AND s.project_id=$2 AND s.id=tree.session_id
       JOIN oao.agent_versions v
         ON v.organization_id=s.organization_id AND v.project_id=s.project_id
        AND v.id=s.agent_version_id
       JOIN oao.agent_definitions d
         ON d.organization_id=v.organization_id AND d.project_id=v.project_id
        AND d.id=v.agent_definition_id`,
    [...scope, sessionId],
  );
  if (sessions.rows.length === 0) return null;
  const sessionIds = sessions.rows.map((row) => row.id);
  const treeScope = [...scope, sessionIds];

  const invocations = await transaction.query<InvocationRow>(
    `SELECT r.session_id,d.id AS agent_id,v.config->>'modelPreset' AS model_preset,
            m.model_key,
            m.input_tokens::float8 AS input_tokens,
            m.cache_read_tokens::float8 AS cache_read_tokens,
            m.cache_write_tokens::float8 AS cache_write_tokens,
            m.output_tokens::float8 AS output_tokens,
            m.cost_microunits::float8 AS cost_microunits,
            m.usage_source,${UNPRICED_INVOCATION_SQL} AS unpriced,
            m.pricing_snapshot->'costByKind' AS cost_by_kind,
            m.started_at,m.completed_at
       FROM oao.model_invocations m
       JOIN oao.runs r
         ON r.organization_id=m.organization_id AND r.project_id=m.project_id
        AND r.id=m.run_id
       JOIN oao.agent_versions v
         ON v.organization_id=r.organization_id AND v.project_id=r.project_id
        AND v.id=r.agent_version_id
       JOIN oao.agent_definitions d
         ON d.organization_id=v.organization_id AND d.project_id=v.project_id
        AND d.id=v.agent_definition_id
      WHERE r.organization_id=$1 AND r.project_id=$2
        AND r.session_id=ANY($3::uuid[])`,
    treeScope,
  );
  const runs = await transaction.query<{
    readonly created_at: Date;
    readonly admitted_at: Date | null;
    readonly settled_at: Date | null;
  }>(
    `SELECT created_at,admitted_at,settled_at FROM oao.runs
      WHERE organization_id=$1 AND project_id=$2 AND session_id=ANY($3::uuid[])`,
    treeScope,
  );
  // Sandbox tools are recorded as commands and everything else as tool calls.
  // A delegate's tool call only waits for the child session, whose work is
  // already in this tree, and an approval wait is a person, not a tool.
  const toolRuns = await transaction.query<{
    readonly started_at: Date;
    readonly completed_at: Date;
  }>(
    `SELECT COALESCE(a.resolved_at,c.created_at) AS started_at,
            c.updated_at AS completed_at
       FROM oao.tool_calls c
       JOIN oao.runs r
         ON r.organization_id=c.organization_id AND r.project_id=c.project_id
        AND r.id=c.run_id
       LEFT JOIN oao.approvals a
         ON a.organization_id=c.organization_id AND a.project_id=c.project_id
        AND a.tool_call_id=c.id
      WHERE r.organization_id=$1 AND r.project_id=$2
        AND r.session_id=ANY($3::uuid[]) AND c.stage='result_committed'
        AND c.tool_name<>ALL($4::text[])
     UNION ALL
     SELECT command.started_at,command.completed_at
       FROM oao.sandbox_commands command
       JOIN oao.runs r
         ON r.organization_id=command.organization_id
        AND r.project_id=command.project_id AND r.id=command.run_id
      WHERE r.organization_id=$1 AND r.project_id=$2
        AND r.session_id=ANY($3::uuid[])
        AND command.started_at IS NOT NULL AND command.completed_at IS NOT NULL`,
    [...treeScope, DELEGATION_TOOLS],
  );

  const totals = emptyTotals();
  const byAgent = new Map<
    string,
    {
      name: string;
      sessions: Set<string>;
      totals: Totals;
      windows: Window[];
    }
  >();
  for (const session of sessions.rows) {
    const agent = byAgent.get(session.agent_id) ?? {
      name: session.agent_name,
      sessions: new Set<string>(),
      totals: emptyTotals(),
      windows: [],
    };
    agent.sessions.add(session.id);
    byAgent.set(session.agent_id, agent);
  }
  const byModel = new Map<
    string,
    {
      preset: string | null;
      model: string;
      totals: Totals;
      windows: Window[];
    }
  >();
  const modelWindows: Window[] = [];
  for (const row of invocations.rows) {
    add(totals, row);
    const window = callWindow(row);
    if (window) modelWindows.push(window);
    // A run's agent version can differ from the session's latest, so an
    // invocation's agent may not be among the sessions' agents.
    const agent = byAgent.get(row.agent_id);
    if (agent) {
      add(agent.totals, row);
      if (window) agent.windows.push(window);
    }
    const modelKey = `${row.model_preset ?? ""}\u0000${row.model_key}`;
    const model = byModel.get(modelKey) ?? {
      preset: row.model_preset,
      model: row.model_key,
      totals: emptyTotals(),
      windows: [],
    };
    add(model.totals, row);
    if (window) model.windows.push(window);
    byModel.set(modelKey, model);
  }

  const now = Date.now();
  const starts = runs.rows.map((run) => run.created_at.getTime());
  const ends = runs.rows.map((run) => run.settled_at?.getTime() ?? now);
  const running = runs.rows.some((run) => !run.settled_at);
  const startedAt = starts.length > 0 ? Math.min(...starts) : null;
  const endedAt = ends.length > 0 ? Math.max(...ends) : null;

  const byCost = <T extends { readonly costMicrounits: number }>(
    left: T,
    right: T,
  ) => right.costMicrounits - left.costMicrounits;
  return {
    sessionId,
    sessionCount: sessions.rows.length,
    costProvenance: provenance(invocations.rows),
    ...totals,
    time: {
      startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
      completedAt:
        endedAt === null || running ? null : new Date(endedAt).toISOString(),
      wallMs: startedAt === null || endedAt === null ? 0 : endedAt - startedAt,
      activeMs: mergedWindowMs(
        runs.rows.map((run): Window => [
          (run.admitted_at ?? run.created_at).getTime(),
          run.settled_at?.getTime() ?? now,
        ]),
      ),
      modelMs: mergedWindowMs(modelWindows),
      toolMs: mergedWindowMs(
        toolRuns.rows.map((tool): Window => [
          tool.started_at.getTime(),
          tool.completed_at.getTime(),
        ]),
      ),
    },
    byAgent: [...byAgent.entries()]
      .map(([agentId, agent]) => ({
        agentId,
        agentName: agent.name,
        sessionCount: agent.sessions.size,
        modelMs: mergedWindowMs(agent.windows),
        ...agent.totals,
      }))
      .sort(byCost),
    byModel: [...byModel.values()]
      .map((model) => ({
        modelPreset: model.preset,
        model: model.model,
        modelMs: mergedWindowMs(model.windows),
        ...model.totals,
      }))
      .sort(byCost),
  };
}

const GROUPS: Readonly<
  Record<ProjectUsageGroup, { readonly key: string; readonly label: string }>
> = {
  day: {
    key: `to_char(m.started_at AT TIME ZONE 'UTC','YYYY-MM-DD')`,
    label: `to_char(m.started_at AT TIME ZONE 'UTC','YYYY-MM-DD')`,
  },
  agent: { key: "d.id::text", label: "max(d.name)" },
  model: { key: "m.model_key", label: "m.model_key" },
};

const AGGREGATES = `count(DISTINCT r.session_id)::int AS session_count,
  count(*)::int AS model_calls,
  COALESCE(sum(m.input_tokens),0)::float8 AS input_tokens,
  COALESCE(sum(m.cache_read_tokens),0)::float8 AS cache_read_tokens,
  COALESCE(sum(m.cache_write_tokens),0)::float8 AS cache_write_tokens,
  COALESCE(sum(m.output_tokens),0)::float8 AS output_tokens,
  COALESCE(sum(m.cost_microunits),0)::float8 AS cost_microunits,
  (count(*) FILTER (WHERE ${UNPRICED_INVOCATION_SQL}))::int AS unpriced_calls`;

const FROM_INVOCATIONS = `FROM oao.model_invocations m
  JOIN oao.runs r
    ON r.organization_id=m.organization_id AND r.project_id=m.project_id
   AND r.id=m.run_id
  JOIN oao.agent_versions v
    ON v.organization_id=r.organization_id AND v.project_id=r.project_id
   AND v.id=r.agent_version_id
  JOIN oao.agent_definitions d
    ON d.organization_id=v.organization_id AND d.project_id=v.project_id
   AND d.id=v.agent_definition_id
 WHERE m.organization_id=$1 AND m.project_id=$2
   AND m.started_at>=$3 AND m.started_at<$4`;

/** A project's model usage over a period, one row per day, agent, or model. */
export async function readProjectUsage(
  transaction: PgClient,
  tenant: Tenant,
  input: {
    readonly from: Date;
    readonly to: Date;
    readonly groupBy: ProjectUsageGroup;
  },
): Promise<ProjectUsage> {
  const values = [
    tenant.organizationId,
    tenant.projectId,
    input.from,
    input.to,
  ];
  const group = GROUPS[input.groupBy];
  const groups = await transaction.query(
    `SELECT ${group.key} AS key,${group.label} AS label,${AGGREGATES}
       ${FROM_INVOCATIONS}
      GROUP BY ${group.key}
      ORDER BY ${input.groupBy === "day" ? "1 DESC" : "cost_microunits DESC,1"}`,
    values,
  );
  const totals = await transaction.query(
    `SELECT ${AGGREGATES} ${FROM_INVOCATIONS}`,
    values,
  );
  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    groupBy: input.groupBy,
    totals: publicValue(totals.rows[0]) as ProjectUsage["totals"],
    data: groups.rows.map(publicValue) as unknown as ProjectUsage["data"],
  };
}

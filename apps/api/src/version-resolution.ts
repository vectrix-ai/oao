import {
  parseSessionVersionResolution,
  type SessionResolvedAgentVersion,
  type SessionResolvedDelegate,
  type SessionResolvedSkill,
  type SessionVersionResolution,
} from "@oao/contracts";
import type { PgClient } from "@oao/db-postgres";
import { HttpApiError } from "./errors.js";

interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
}

interface DelegateRow {
  readonly key: string;
  readonly pinnedVersionId: string | null;
  readonly followedAgentId: string | null;
  readonly followedAgentName: string | null;
  readonly followedArchived: boolean;
  readonly resolvedVersionId: string | null;
}

interface PinnedSkillRow {
  readonly skillId: string;
  readonly skillVersionId: string;
  readonly version: number;
  readonly name: string;
}

interface FollowedSkillRow {
  readonly skillId: string;
  readonly found: boolean;
  readonly label: string | null;
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly latestVersionId: string | null;
  readonly version: number | null;
  readonly name: string | null;
  readonly status: "active" | "deprecated" | "revoked" | null;
}

interface VersionRow {
  readonly id: string;
  readonly agent_definition_id: string;
  readonly agent_name: string;
  readonly version: number;
  readonly sandbox: unknown;
  readonly delegates: readonly DelegateRow[];
  readonly pinned_skills: readonly PinnedSkillRow[];
  readonly followed_skills: readonly FollowedSkillRow[];
}

/**
 * Reads, in one statement and so from one snapshot, the agent version a
 * session starts with and every agent version its delegates reach: pinned
 * delegates by version, followed delegates by their agent's current latest
 * version. The recursive union stops at versions it has seen, so a cycle in
 * stored data cannot loop.
 */
const VERSION_TREE_SQL = `
WITH RECURSIVE reach(agent_version_id) AS (
  SELECT $3::uuid
  UNION
  SELECT COALESCE(edge.child_agent_version_id, followed.latest_version_id)
    FROM reach
    JOIN oao.agent_version_delegates edge
      ON edge.organization_id=$1 AND edge.project_id=$2
     AND edge.parent_agent_version_id=reach.agent_version_id
    LEFT JOIN oao.agent_definitions followed
      ON followed.organization_id=edge.organization_id
     AND followed.project_id=edge.project_id
     AND followed.id=edge.child_agent_definition_id
   WHERE COALESCE(edge.child_agent_version_id, followed.latest_version_id) IS NOT NULL
)
SELECT version.id,version.agent_definition_id,definition.name AS agent_name,
       version.version,version.config->'sandbox' AS sandbox,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'key',edge.delegate_key,
                  'pinnedVersionId',edge.child_agent_version_id,
                  'followedAgentId',edge.child_agent_definition_id,
                  'followedAgentName',followed.name,
                  'followedArchived',COALESCE(followed.archived_at IS NOT NULL,false),
                  'resolvedVersionId',COALESCE(edge.child_agent_version_id,followed.latest_version_id)
                ) ORDER BY edge.delegate_key)
           FROM oao.agent_version_delegates edge
           LEFT JOIN oao.agent_definitions followed
             ON followed.organization_id=edge.organization_id
            AND followed.project_id=edge.project_id
            AND followed.id=edge.child_agent_definition_id
          WHERE edge.organization_id=version.organization_id
            AND edge.project_id=version.project_id
            AND edge.parent_agent_version_id=version.id
       ),'[]'::jsonb) AS delegates,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'skillId',sv.skill_id,
                  'skillVersionId',sv.id,
                  'version',sv.version,
                  'name',binding.skill_name
                ) ORDER BY binding.skill_name)
           FROM oao.agent_version_skill_bindings binding
           JOIN oao.skill_versions sv
             ON sv.organization_id=binding.organization_id
            AND sv.project_id=binding.project_id
            AND sv.id=binding.skill_version_id
          WHERE binding.organization_id=version.organization_id
            AND binding.project_id=version.project_id
            AND binding.agent_version_id=version.id
       ),'[]'::jsonb) AS pinned_skills,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'skillId',requested.skill_id,
                  'found',skill.id IS NOT NULL,
                  'label',skill.display_name,
                  'archived',COALESCE(skill.archived_at IS NOT NULL,false),
                  'disabled',COALESCE(skill.disabled_at IS NOT NULL,false),
                  'latestVersionId',skill.latest_version_id,
                  'version',latest.version,
                  'name',latest.skill_name,
                  'status',lifecycle.status
                ) ORDER BY requested.position)
           FROM jsonb_array_elements_text(COALESCE(version.config->'skillIds','[]'::jsonb))
                WITH ORDINALITY AS requested(skill_id,position)
           LEFT JOIN oao.skills skill
             ON skill.organization_id=version.organization_id
            AND skill.project_id=version.project_id
            AND skill.id=requested.skill_id::uuid
           LEFT JOIN oao.skill_versions latest
             ON latest.organization_id=skill.organization_id
            AND latest.project_id=skill.project_id
            AND latest.id=skill.latest_version_id
           LEFT JOIN oao.skill_version_lifecycle lifecycle
             ON lifecycle.organization_id=latest.organization_id
            AND lifecycle.project_id=latest.project_id
            AND lifecycle.skill_version_id=latest.id
       ),'[]'::jsonb) AS followed_skills
  FROM reach
  JOIN oao.agent_versions version
    ON version.organization_id=$1 AND version.project_id=$2
   AND version.id=reach.agent_version_id
  JOIN oao.agent_definitions definition
    ON definition.organization_id=version.organization_id
   AND definition.project_id=version.project_id
   AND definition.id=version.agent_definition_id`;

function sandboxPolicy(sandbox: unknown): string {
  const value =
    sandbox && typeof sandbox === "object" && !Array.isArray(sandbox)
      ? (sandbox as Readonly<Record<string, unknown>>)
      : {};
  return JSON.stringify({
    enabled: value.enabled,
    provider: value.provider,
    ...(value.snapshotId === undefined ? {} : { snapshotId: value.snapshotId }),
    network: value.network,
  });
}

function unavailable(message: string): HttpApiError {
  return new HttpApiError("conflict", message);
}

/**
 * Resolves the versions a new root session runs: the agent version it
 * starts with, every delegate it can reach, and their Skills. A delegate or
 * Skill that follows the latest version resolves to the version published
 * now. Fails, naming the link, when a followed agent or Skill was deleted,
 * is disabled, has no usable published version, needs a different sandbox
 * than its coordinator, or leads back into a cycle.
 */
export async function resolveSessionVersions(
  transaction: PgClient,
  tenant: Tenant,
  input: {
    readonly rootSessionId: string;
    readonly rootAgentVersionId: string;
    readonly resolvedAt: string;
  },
): Promise<SessionVersionResolution> {
  const result = await transaction.query<VersionRow>(VERSION_TREE_SQL, [
    tenant.organizationId,
    tenant.projectId,
    input.rootAgentVersionId,
  ]);
  const versions = new Map(result.rows.map((row) => [row.id, row]));
  if (!versions.has(input.rootAgentVersionId))
    throw new HttpApiError("not_found", "Agent version not found");

  const resolved = new Map<string, SessionResolvedAgentVersion>();
  const children = new Map<string, readonly string[]>();
  for (const row of result.rows) {
    const owner = `Agent ${JSON.stringify(row.agent_name)} version ${row.version}`;
    const delegates: SessionResolvedDelegate[] = [];
    for (const delegate of row.delegates) {
      const link = `${owner}: delegate ${delegate.key}`;
      if (delegate.followedAgentId !== null) {
        const agent = JSON.stringify(delegate.followedAgentName);
        if (delegate.followedArchived)
          throw unavailable(
            `${link} follows agent ${agent}, which was deleted. Pin a version or publish a version of the coordinator without this delegate.`,
          );
        if (delegate.resolvedVersionId === null)
          throw unavailable(
            `${link} follows agent ${agent}, which has no published version.`,
          );
      }
      const child = versions.get(delegate.resolvedVersionId ?? "");
      if (!child)
        throw unavailable(
          `${link} refers to an agent version that is not available.`,
        );
      // A pinned delegate was checked when its coordinator was published,
      // and both versions are immutable. A followed delegate may have
      // published an incompatible version since.
      if (
        delegate.followedAgentId !== null &&
        sandboxPolicy(child.sandbox) !== sandboxPolicy(row.sandbox)
      )
        throw unavailable(
          `${link} follows agent ${JSON.stringify(child.agent_name)}, whose latest version ${child.version} uses a different sandbox enabled state, provider, snapshot, or network policy than the coordinator. Publish a compatible coordinator version, or pin a compatible version of the delegate.`,
        );
      delegates.push({
        key: delegate.key,
        agentId: child.agent_definition_id,
        agentVersionId: child.id,
        version: child.version,
        followsLatest: delegate.followedAgentId !== null,
      });
    }
    const skills: SessionResolvedSkill[] = row.pinned_skills.map((skill) => ({
      ...skill,
      followsLatest: false,
    }));
    for (const skill of row.followed_skills) {
      const label = JSON.stringify(skill.label ?? skill.skillId);
      const link = `${owner} follows Skill ${label}`;
      if (!skill.found || skill.archived)
        throw unavailable(`${link}, which was deleted.`);
      if (skill.disabled) throw unavailable(`${link}, which is disabled.`);
      if (
        skill.latestVersionId === null ||
        skill.version === null ||
        skill.name === null
      )
        throw unavailable(`${link}, which has no published version.`);
      if (skill.status !== "active")
        throw unavailable(
          `${link}, whose latest version ${skill.version} is ${skill.status ?? "unavailable"}. Publish a new version of the Skill, or pin an active one.`,
        );
      skills.push({
        skillId: skill.skillId,
        skillVersionId: skill.latestVersionId,
        version: skill.version,
        name: skill.name,
        followsLatest: true,
      });
    }
    const names = new Set<string>();
    for (const skill of skills) {
      if (names.has(skill.name))
        throw unavailable(
          `${owner} would bind two Skills named ${skill.name}. Publish a version that binds one of them, or pin a version with a different name.`,
        );
      names.add(skill.name);
    }
    skills.sort((left, right) => left.name.localeCompare(right.name));
    resolved.set(row.id, {
      agentId: row.agent_definition_id,
      agentVersionId: row.id,
      version: row.version,
      skills,
      delegates,
    });
    children.set(
      row.id,
      delegates.map((delegate) => delegate.agentVersionId),
    );
  }

  // Publication rejects cycles; this guards against ones that concurrent
  // publications or stored data could still form, which would otherwise let
  // delegation recurse without end.
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: readonly string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const names = [...path.slice(path.indexOf(id)), id].map((entry) => {
        const row = versions.get(entry)!;
        return `${JSON.stringify(row.agent_name)} version ${row.version}`;
      });
      throw unavailable(
        `The delegates form a cycle: ${names.join(" → ")}. Pin a version to break it.`,
      );
    }
    state.set(id, "visiting");
    for (const child of children.get(id) ?? []) visit(child, [...path, id]);
    state.set(id, "done");
  };
  visit(input.rootAgentVersionId, []);

  // Root first, then the order delegates were reached in.
  const ordered: SessionResolvedAgentVersion[] = [];
  const seen = new Set<string>();
  const queue = [input.rootAgentVersionId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = resolved.get(id)!;
    ordered.push(entry);
    queue.push(...entry.delegates.map((delegate) => delegate.agentVersionId));
  }
  return parseSessionVersionResolution({
    schemaVersion: 1,
    rootSessionId: input.rootSessionId,
    rootAgentVersionId: input.rootAgentVersionId,
    resolvedAt: input.resolvedAt,
    agentVersions: ordered,
  });
}

/** Stores a session's resolution and binds the session's own Skills. */
export async function bindSessionVersions(
  transaction: PgClient,
  tenant: Tenant,
  sessionId: string,
  agentVersionId: string,
  resolution: SessionVersionResolution,
): Promise<void> {
  const entry = resolution.agentVersions.find(
    (candidate) => candidate.agentVersionId === agentVersionId,
  );
  if (!entry)
    throw new Error("The session's agent version is missing its resolution");
  await transaction.query(
    `INSERT INTO oao.session_version_resolutions
       (organization_id,project_id,session_id,resolution)
     VALUES ($1,$2,$3,$4)`,
    [tenant.organizationId, tenant.projectId, sessionId, resolution],
  );
  if (entry.skills.length > 0)
    await transaction.query(
      `INSERT INTO oao.session_skill_bindings (
         organization_id,project_id,session_id,agent_version_id,
         skill_version_id,skill_name
       )
       SELECT $1,$2,$3,$4,sv.id,sv.skill_name
         FROM oao.skill_versions sv
        WHERE sv.organization_id=$1 AND sv.project_id=$2
          AND sv.id=ANY($5::uuid[])`,
      [
        tenant.organizationId,
        tenant.projectId,
        sessionId,
        agentVersionId,
        entry.skills.map((skill) => skill.skillVersionId),
      ],
    );
}

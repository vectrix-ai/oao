-- Agents can be deleted from the console and API. Sessions, runs, delegate
-- bindings, and Harness Operations keep foreign keys to immutable agent
-- versions, so deletion archives the definition instead of removing rows:
-- an archived agent leaves every list, roster, and lookup, existing session
-- history stays readable, and its key becomes free for a new agent.

ALTER TABLE oao.agent_definitions
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Replace the table-wide key uniqueness with one scoped to live agents.
DO $$
DECLARE
  key_constraint text;
BEGIN
  SELECT con.conname INTO key_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'oao'
    AND rel.relname = 'agent_definitions'
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)
      FROM unnest(con.conkey) AS cols(attnum)
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = cols.attnum
    ) = ARRAY['agent_key', 'organization_id', 'project_id']::text[];
  IF key_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE oao.agent_definitions DROP CONSTRAINT %I', key_constraint);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_definitions_live_key_idx
  ON oao.agent_definitions (organization_id, project_id, agent_key)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_definitions_live_created_idx
  ON oao.agent_definitions (organization_id, project_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

-- Model presets and provider connections can be removed from a project.
--
-- Presets stay append-only for everything that matters to a published agent
-- version: key, model, routing, and settings never change and rows are never
-- deleted, because immutable agent versions pin the key. Removal archives the
-- preset so it stops being offered to new agent versions while sessions of
-- already published versions keep resolving it.
--
-- Provider connections archive too: the credential is wiped, the row keeps
-- its identity for the presets that referenced it, and the key is released.

ALTER TABLE oao.project_model_presets
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE OR REPLACE FUNCTION oao.restrict_project_model_preset_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project_model_presets is immutable' USING ERRCODE = '23000';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.preset_key IS DISTINCT FROM OLD.preset_key
     OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.routing IS DISTINCT FROM OLD.routing
     OR NEW.settings IS DISTINCT FROM OLD.settings
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.archived_at IS NOT NULL
     OR NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'project_model_presets is immutable' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS project_model_presets_immutable ON oao.project_model_presets;
CREATE TRIGGER project_model_presets_immutable
BEFORE UPDATE OR DELETE ON oao.project_model_presets
FOR EACH ROW EXECUTE FUNCTION oao.restrict_project_model_preset_mutation();

ALTER TABLE oao.project_model_providers
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Replace the table-wide key uniqueness with one scoped to live connections.
DO $$
DECLARE
  key_constraint text;
BEGIN
  SELECT con.conname INTO key_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'oao'
    AND rel.relname = 'project_model_providers'
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname)
      FROM unnest(con.conkey) AS cols(attnum)
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = cols.attnum
    ) = ARRAY['organization_id', 'project_id', 'provider_key']::text[];
  IF key_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE oao.project_model_providers DROP CONSTRAINT %I', key_constraint);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS project_model_providers_live_key_idx
  ON oao.project_model_providers (organization_id, project_id, provider_key)
  WHERE archived_at IS NULL;

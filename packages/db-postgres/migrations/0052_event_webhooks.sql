-- Outbound product-event webhooks. Each endpoint owns a durable project-position
-- cursor. The runtime worker claims due endpoints across tenants, then reads
-- events and configuration inside the endpoint's tenant transaction.
CREATE TABLE oao.event_webhooks (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  endpoint_url text NOT NULL
    CHECK (length(endpoint_url) BETWEEN 1 AND 2048 AND endpoint_url ~ '^https?://[^/?#@]+'),
  enabled boolean NOT NULL DEFAULT true,
  disabled_reason text CHECK (disabled_reason IN ('user', 'endpoint_gone')),
  event_kinds text[]
    CHECK (
      event_kinds IS NULL
      OR (cardinality(event_kinds) BETWEEN 1 AND 100 AND array_position(event_kinds, NULL) IS NULL)
    ),
  include_message_content boolean NOT NULL DEFAULT false,
  -- Signing secret, AES-256-GCM encrypted by @oao/provider-credentials. It is
  -- never returned; responses expose only the fingerprint and version.
  encrypted_signing_key bytea NOT NULL CHECK (octet_length(encrypted_signing_key) BETWEEN 1 AND 4096),
  encryption_nonce bytea NOT NULL CHECK (octet_length(encryption_nonce) = 12),
  encryption_tag bytea NOT NULL CHECK (octet_length(encryption_tag) = 16),
  encryption_key_version integer NOT NULL CHECK (encryption_key_version BETWEEN 1 AND 2147483647),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  -- After a rotation the previous key keeps signing until it expires, so a
  -- receiver can switch secrets without rejecting deliveries.
  previous_encrypted_signing_key bytea CHECK (octet_length(previous_encrypted_signing_key) BETWEEN 1 AND 4096),
  previous_encryption_nonce bytea CHECK (octet_length(previous_encryption_nonce) = 12),
  previous_encryption_tag bytea CHECK (octet_length(previous_encryption_tag) = 16),
  previous_encryption_key_version integer CHECK (previous_encryption_key_version BETWEEN 1 AND 2147483647),
  previous_credential_expires_at timestamptz,
  delivered_position bigint NOT NULL DEFAULT 0 CHECK (delivered_position >= 0),
  -- A formed batch keeps its identity across retries so receivers can use the
  -- webhook-id header as an idempotency key.
  batch_id uuid,
  batch_through_position bigint,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_response_status integer CHECK (last_response_status BETWEEN 100 AND 599),
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  lease_owner text CHECK (length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects(organization_id, id) ON DELETE CASCADE,
  CHECK (enabled = (disabled_reason IS NULL)),
  CHECK (
    (previous_encrypted_signing_key IS NULL) = (previous_encryption_nonce IS NULL)
    AND (previous_encrypted_signing_key IS NULL) = (previous_encryption_tag IS NULL)
    AND (previous_encrypted_signing_key IS NULL) = (previous_encryption_key_version IS NULL)
    AND (previous_encrypted_signing_key IS NULL) = (previous_credential_expires_at IS NULL)
  ),
  CHECK ((batch_id IS NULL) = (batch_through_position IS NULL)),
  CHECK (batch_through_position IS NULL OR batch_through_position > delivered_position),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX event_webhooks_due_idx
  ON oao.event_webhooks (next_attempt_at)
  WHERE enabled;

CREATE FUNCTION oao.restrict_event_webhook_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credential_changed boolean;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'event webhook identity is immutable' USING ERRCODE = '55000';
  END IF;
  credential_changed := NEW.encrypted_signing_key IS DISTINCT FROM OLD.encrypted_signing_key
    OR NEW.encryption_nonce IS DISTINCT FROM OLD.encryption_nonce
    OR NEW.encryption_tag IS DISTINCT FROM OLD.encryption_tag
    OR NEW.credential_fingerprint IS DISTINCT FROM OLD.credential_fingerprint;
  IF NEW.encryption_key_version < OLD.encryption_key_version
     OR (credential_changed AND NEW.encryption_key_version <= OLD.encryption_key_version)
     OR (NOT credential_changed AND NEW.encryption_key_version <> OLD.encryption_key_version) THEN
    RAISE EXCEPTION 'event webhook credential version is invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW.delivered_position < OLD.delivered_position THEN
    RAISE EXCEPTION 'event webhook cursor cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF NEW.lease_fence < OLD.lease_fence THEN
    RAISE EXCEPTION 'event webhook lease fence cannot move backwards' USING ERRCODE = '55000';
  END IF;
  -- Delivery bookkeeping (cursor, leases, failures) is not a configuration change.
  IF credential_changed
     OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url
     OR NEW.enabled IS DISTINCT FROM OLD.enabled
     OR NEW.event_kinds IS DISTINCT FROM OLD.event_kinds
     OR NEW.include_message_content IS DISTINCT FROM OLD.include_message_content THEN
    NEW.updated_at := clock_timestamp();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER event_webhooks_restrict_mutation
BEFORE UPDATE ON oao.event_webhooks
FOR EACH ROW EXECUTE FUNCTION oao.restrict_event_webhook_mutation();

ALTER TABLE oao.event_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.event_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oao.event_webhooks
  USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON oao.event_webhooks TO oao_app;

-- The cross-tenant claim sees only scheduling columns: never endpoint URLs,
-- filters, or encrypted signing keys. Column grants keep the recovery role's
-- table-level ACL unchanged.
GRANT SELECT (
  organization_id, project_id, id, enabled, delivered_position, next_attempt_at,
  lease_owner, lease_expires_at, lease_fence
) ON oao.event_webhooks TO oao_recovery;
GRANT UPDATE (lease_owner, lease_expires_at, lease_fence)
  ON oao.event_webhooks TO oao_recovery;
CREATE POLICY recovery_visibility ON oao.event_webhooks
  FOR ALL TO oao_recovery
  USING (true)
  WITH CHECK (true);
GRANT SELECT (organization_id, project_id, committed_position)
  ON oao.project_event_positions TO oao_recovery;
CREATE POLICY recovery_visibility ON oao.project_event_positions
  FOR SELECT TO oao_recovery
  USING (true);

CREATE FUNCTION oao.claim_event_webhook_deliveries(
  p_worker_id text,
  p_limit integer,
  p_lease interval
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  webhook_id uuid,
  lease_fence bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
#variable_conflict use_column
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 200
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease IS NULL OR p_lease < interval '1 second' OR p_lease > interval '10 minutes' THEN
    RAISE EXCEPTION 'invalid event webhook claim' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT w.organization_id, w.project_id, w.id
    FROM oao.event_webhooks w
    JOIN oao.project_event_positions p
      ON p.organization_id = w.organization_id AND p.project_id = w.project_id
    WHERE w.enabled
      AND w.next_attempt_at <= clock_timestamp()
      AND (w.lease_expires_at IS NULL OR w.lease_expires_at <= clock_timestamp())
      AND p.committed_position > w.delivered_position
    ORDER BY w.next_attempt_at
    LIMIT p_limit
    FOR UPDATE OF w SKIP LOCKED
  )
  UPDATE oao.event_webhooks w
     SET lease_owner = p_worker_id,
         lease_expires_at = clock_timestamp() + p_lease,
         lease_fence = w.lease_fence + 1
    FROM candidates c
   WHERE w.organization_id = c.organization_id
     AND w.project_id = c.project_id
     AND w.id = c.id
  RETURNING w.organization_id, w.project_id, w.id, w.lease_fence;
END
$$;

REVOKE ALL ON FUNCTION oao.claim_event_webhook_deliveries(text,integer,interval) FROM PUBLIC, oao_app;
COMMENT ON FUNCTION oao.claim_event_webhook_deliveries(text,integer,interval) IS
  'Cross-tenant event webhook lease claim owned by the NOLOGIN oao_recovery role; returns only tenant and lease identifiers.';

DO $$
DECLARE
  migration_role name := current_user;
  granted_membership boolean := NOT pg_has_role(current_user, 'oao_recovery', 'SET');
BEGIN
  IF granted_membership THEN
    -- INHERIT is temporary: it lets the migration login grant from the new
    -- function owner after the transfer. The membership is revoked below.
    EXECUTE format('GRANT oao_recovery TO %I WITH SET TRUE, INHERIT TRUE', migration_role);
  END IF;

  GRANT CREATE ON SCHEMA oao TO oao_recovery;
  ALTER FUNCTION oao.claim_event_webhook_deliveries(text,integer,interval) OWNER TO oao_recovery;
  REVOKE CREATE ON SCHEMA oao FROM oao_recovery;

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION oao.claim_event_webhook_deliveries(text,integer,interval) TO %I',
    migration_role
  );

  IF granted_membership THEN
    EXECUTE format('REVOKE oao_recovery FROM %I', migration_role);
  END IF;

  IF NOT has_function_privilege(
    migration_role,
    'oao.claim_event_webhook_deliveries(text,integer,interval)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration/runtime login lacks event webhook claim execution';
  END IF;
END
$$;

CREATE TYPE oao.organization_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE oao.project_role AS ENUM ('owner', 'admin', 'member', 'viewer');

-- Principal UUIDs are globally generated. This key permits organization-wide
-- membership rows while principals retain their project correlation.
ALTER TABLE oao.principals
  ADD CONSTRAINT principals_organization_id_id_key
  UNIQUE (organization_id, id);

CREATE TABLE oao.organization_members (
  organization_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role oao.organization_role NOT NULL,
  created_by_principal_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, principal_id),
  FOREIGN KEY (organization_id) REFERENCES oao.organizations(id),
  FOREIGN KEY (organization_id, principal_id)
    REFERENCES oao.principals(organization_id, id),
  FOREIGN KEY (organization_id, created_by_principal_id)
    REFERENCES oao.principals(organization_id, id)
);

CREATE TABLE oao.project_members (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role oao.project_role NOT NULL,
  created_by_principal_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, principal_id),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects(organization_id, id),
  FOREIGN KEY (organization_id, project_id, principal_id)
    REFERENCES oao.principals(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals(organization_id, project_id, id)
);

CREATE TABLE oao.auth_tenant_links (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('development', 'workos')),
  provider_tenant_id text NOT NULL CHECK (length(provider_tenant_id) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, provider),
  FOREIGN KEY (organization_id, project_id)
    REFERENCES oao.projects(organization_id, id)
);

CREATE TABLE oao.auth_identities (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('development', 'workos')),
  provider_subject text NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 500),
  email text,
  display_name text,
  provider_updated_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, provider, provider_subject),
  UNIQUE (organization_id, project_id, principal_id, provider),
  FOREIGN KEY (organization_id, project_id, principal_id)
    REFERENCES oao.principals(organization_id, project_id, id)
);

CREATE TABLE oao.auth_sessions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('development', 'workos')),
  session_key_hash bytea NOT NULL CHECK (octet_length(session_key_hash) = 32),
  provider_session_id text,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  refreshed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (session_key_hash),
  FOREIGN KEY (organization_id, project_id, principal_id)
    REFERENCES oao.principals(organization_id, project_id, id),
  CHECK (expires_at > created_at)
);

CREATE TABLE oao.api_keys (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  key_prefix text NOT NULL CHECK (key_prefix ~ '^[A-Za-z0-9]{6,64}$'),
  key_hash bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_by_principal_id uuid NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (key_prefix),
  UNIQUE (organization_id, project_id, principal_id),
  FOREIGN KEY (organization_id, project_id, principal_id)
    REFERENCES oao.principals(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id)
    REFERENCES oao.principals(organization_id, project_id, id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE oao.api_request_idempotency (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  http_method text NOT NULL CHECK (http_method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  route_key text NOT NULL CHECK (length(route_key) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 500),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status_code integer,
  response_public jsonb,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (
    organization_id, project_id, principal_id, http_method, route_key, idempotency_key
  ),
  FOREIGN KEY (organization_id, project_id, principal_id)
    REFERENCES oao.principals(organization_id, project_id, id),
  CHECK (expires_at > created_at),
  CHECK (
    (status_code IS NULL AND response_public IS NULL AND completed_at IS NULL)
    OR
    (status_code BETWEEN 100 AND 599 AND response_public IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (response_public IS NULL OR jsonb_typeof(response_public) = 'object'),
  CHECK (response_public IS NULL OR NOT oao.jsonb_has_forbidden_public_key(response_public))
);

ALTER TABLE oao.agent_definitions
  ADD COLUMN latest_version_id uuid;

ALTER TABLE oao.agent_versions
  ADD CONSTRAINT agent_versions_definition_id_version_id_key
  UNIQUE (organization_id, project_id, agent_definition_id, id);

ALTER TABLE oao.agent_definitions
  ADD CONSTRAINT agent_definitions_latest_version_fkey
  FOREIGN KEY (organization_id, project_id, id, latest_version_id)
  REFERENCES oao.agent_versions(organization_id, project_id, agent_definition_id, id);

CREATE FUNCTION oao.bootstrap_project(
  p_organization_id uuid,
  p_organization_slug text,
  p_organization_name text,
  p_project_id uuid,
  p_project_slug text,
  p_project_name text,
  p_principal_id uuid,
  p_principal_subject text,
  p_provider text DEFAULT 'development'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  existing_organization oao.organizations;
  existing_project oao.projects;
  existing_principal oao.principals;
BEGIN
  IF p_provider NOT IN ('development', 'workos') THEN
    RAISE EXCEPTION 'unsupported auth provider' USING ERRCODE = '22023';
  END IF;

  INSERT INTO oao.organizations (id, slug, name)
  VALUES (p_organization_id, p_organization_slug, p_organization_name)
  ON CONFLICT DO NOTHING;
  SELECT * INTO existing_organization FROM oao.organizations
  WHERE id = p_organization_id;
  IF NOT FOUND OR existing_organization.slug <> p_organization_slug THEN
    RAISE EXCEPTION 'organization bootstrap identity conflict' USING ERRCODE = '22023';
  END IF;

  INSERT INTO oao.projects (organization_id, id, slug, name)
  VALUES (p_organization_id, p_project_id, p_project_slug, p_project_name)
  ON CONFLICT DO NOTHING;
  SELECT * INTO existing_project FROM oao.projects
  WHERE organization_id = p_organization_id AND id = p_project_id;
  IF NOT FOUND OR existing_project.slug <> p_project_slug THEN
    RAISE EXCEPTION 'project bootstrap identity conflict' USING ERRCODE = '22023';
  END IF;

  INSERT INTO oao.principals (
    organization_id, project_id, id, kind, subject, scopes
  ) VALUES (
    p_organization_id, p_project_id, p_principal_id, 'human', p_principal_subject, ARRAY['*']
  ) ON CONFLICT DO NOTHING;
  SELECT * INTO existing_principal FROM oao.principals
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_principal_id;
  IF NOT FOUND OR existing_principal.subject <> p_principal_subject OR existing_principal.kind <> 'human' THEN
    RAISE EXCEPTION 'principal bootstrap identity conflict' USING ERRCODE = '22023';
  END IF;

  INSERT INTO oao.organization_members (organization_id, principal_id, role)
  VALUES (p_organization_id, p_principal_id, 'owner')
  ON CONFLICT DO NOTHING;
  INSERT INTO oao.project_members (organization_id, project_id, principal_id, role)
  VALUES (p_organization_id, p_project_id, p_principal_id, 'owner')
  ON CONFLICT DO NOTHING;
  INSERT INTO oao.auth_tenant_links (
    organization_id, project_id, provider, provider_tenant_id
  ) VALUES (
    p_organization_id, p_project_id, p_provider, p_organization_id::text || '/' || p_project_id::text
  ) ON CONFLICT DO NOTHING;
  INSERT INTO oao.auth_identities (
    organization_id, project_id, principal_id, provider, provider_subject,
    last_reconciled_at
  ) VALUES (
    p_organization_id, p_project_id, p_principal_id, p_provider,
    p_principal_subject, clock_timestamp()
  ) ON CONFLICT DO NOTHING;
END
$$;

CREATE FUNCTION oao.authenticate_api_key(
  p_prefix text,
  p_keyed_hash bytea,
  p_at timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
BEGIN
  IF octet_length(p_keyed_hash) <> 32 THEN
    RAISE EXCEPTION 'API key hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  UPDATE oao.api_keys AS key
  SET last_used_at = p_at
  WHERE key.key_prefix = p_prefix
    AND key.key_hash = p_keyed_hash
    AND key.revoked_at IS NULL
    AND (key.expires_at IS NULL OR key.expires_at > p_at)
  RETURNING key.organization_id, key.project_id, key.principal_id, key.scopes;
END
$$;

CREATE FUNCTION oao.resolve_auth_session(
  p_session_key_hash bytea,
  p_at timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  provider text,
  subject text,
  scopes text[],
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
BEGIN
  IF octet_length(p_session_key_hash) <> 32 THEN
    RAISE EXCEPTION 'session key hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  UPDATE oao.auth_sessions AS session
  SET last_seen_at = p_at
  FROM oao.principals AS principal
  WHERE session.session_key_hash = p_session_key_hash
    AND session.revoked_at IS NULL
    AND session.expires_at > p_at
    AND principal.organization_id = session.organization_id
    AND principal.project_id = session.project_id
    AND principal.id = session.principal_id
  RETURNING session.organization_id, session.project_id, session.principal_id,
    session.provider, principal.subject, principal.scopes, session.expires_at;
END
$$;

CREATE FUNCTION oao.resolve_workos_principal(
  p_provider_subject text,
  p_provider_tenant_id text DEFAULT NULL,
  p_project_id uuid DEFAULT NULL
) RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  principal_id uuid,
  subject text,
  scopes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE matching_count integer;
BEGIN
  SELECT count(*) INTO matching_count
  FROM oao.auth_identities AS identity
  JOIN oao.principals AS principal
    ON principal.organization_id = identity.organization_id
   AND principal.project_id = identity.project_id
   AND principal.id = identity.principal_id
  JOIN oao.project_members AS membership
    ON membership.organization_id = identity.organization_id
   AND membership.project_id = identity.project_id
   AND membership.principal_id = identity.principal_id
  LEFT JOIN oao.auth_tenant_links AS tenant
    ON tenant.organization_id = identity.organization_id
   AND tenant.project_id = identity.project_id
   AND tenant.provider = 'workos'
  WHERE identity.provider = 'workos'
    AND identity.provider_subject = p_provider_subject
    AND (p_provider_tenant_id IS NULL OR tenant.provider_tenant_id = p_provider_tenant_id)
    AND (p_project_id IS NULL OR identity.project_id = p_project_id);
  IF matching_count <> 1 THEN RETURN; END IF;
  RETURN QUERY
  SELECT identity.organization_id, identity.project_id, identity.principal_id,
         principal.subject, principal.scopes
  FROM oao.auth_identities AS identity
  JOIN oao.principals AS principal
    ON principal.organization_id = identity.organization_id
   AND principal.project_id = identity.project_id
   AND principal.id = identity.principal_id
  JOIN oao.project_members AS membership
    ON membership.organization_id = identity.organization_id
   AND membership.project_id = identity.project_id
   AND membership.principal_id = identity.principal_id
  LEFT JOIN oao.auth_tenant_links AS tenant
    ON tenant.organization_id = identity.organization_id
   AND tenant.project_id = identity.project_id
   AND tenant.provider = 'workos'
  WHERE identity.provider = 'workos'
    AND identity.provider_subject = p_provider_subject
    AND (p_provider_tenant_id IS NULL OR tenant.provider_tenant_id = p_provider_tenant_id)
    AND (p_project_id IS NULL OR identity.project_id = p_project_id);
END
$$;

ALTER TABLE oao.workos_webhook_events
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN processing_lease_expires_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

CREATE FUNCTION oao.claim_workos_webhook_event(
  p_event_id text,
  p_event_type text,
  p_payload_hash bytea,
  p_at timestamptz DEFAULT clock_timestamp(),
  p_lease interval DEFAULT interval '5 minutes'
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  webhook oao.workos_webhook_events;
  inserted_count integer;
BEGIN
  IF octet_length(p_payload_hash) <> 32 THEN
    RAISE EXCEPTION 'webhook payload hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  IF p_lease <= interval '0 seconds' OR p_lease > interval '1 day' THEN
    RAISE EXCEPTION 'invalid webhook processing lease' USING ERRCODE = '22023';
  END IF;
  INSERT INTO oao.workos_webhook_events (
    event_id, event_type, payload_hash, processing_started_at,
    processing_lease_expires_at, attempt_count
  ) VALUES (
    p_event_id, p_event_type, p_payload_hash, p_at, p_at + p_lease, 1
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  SELECT * INTO webhook FROM oao.workos_webhook_events
  WHERE event_id = p_event_id FOR UPDATE;
  IF webhook.event_type <> p_event_type OR webhook.payload_hash <> p_payload_hash THEN
    RAISE EXCEPTION 'webhook event replay conflict' USING ERRCODE = '22023';
  END IF;
  IF webhook.processed_at IS NOT NULL THEN
    RETURN 'replayed';
  END IF;
  IF inserted_count = 1 THEN
    RETURN 'claimed';
  END IF;
  IF webhook.processing_lease_expires_at IS NULL OR webhook.processing_lease_expires_at <= p_at THEN
    UPDATE oao.workos_webhook_events
    SET processing_started_at = p_at,
        processing_lease_expires_at = p_at + p_lease,
        attempt_count = attempt_count + 1
    WHERE event_id = p_event_id;
    RETURN 'claimed';
  END IF;
  RETURN 'in_progress';
END
$$;

CREATE FUNCTION oao.complete_workos_webhook_event(
  p_event_id text,
  p_payload_hash bytea,
  p_safe_error jsonb DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  webhook oao.workos_webhook_events;
BEGIN
  IF p_safe_error IS NOT NULL AND oao.jsonb_has_forbidden_public_key(p_safe_error) THEN
    RAISE EXCEPTION 'unsafe webhook error detail' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO webhook FROM oao.workos_webhook_events
  WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event not found' USING ERRCODE = 'P0002';
  END IF;
  IF webhook.payload_hash <> p_payload_hash THEN
    RAISE EXCEPTION 'webhook event replay conflict' USING ERRCODE = '22023';
  END IF;
  IF webhook.processed_at IS NOT NULL THEN
    RETURN 'replayed';
  END IF;
  UPDATE oao.workos_webhook_events
  SET processed_at = clock_timestamp(),
      processing_lease_expires_at = NULL,
      safe_error = p_safe_error
  WHERE event_id = p_event_id;
  RETURN 'completed';
END
$$;

CREATE FUNCTION oao.release_workos_webhook_event(
  p_event_id text,
  p_payload_hash bytea,
  p_safe_error jsonb DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, oao
AS $$
DECLARE
  webhook oao.workos_webhook_events;
BEGIN
  IF p_safe_error IS NOT NULL AND oao.jsonb_has_forbidden_public_key(p_safe_error) THEN
    RAISE EXCEPTION 'unsafe webhook error detail' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO webhook FROM oao.workos_webhook_events
  WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event not found' USING ERRCODE = 'P0002';
  END IF;
  IF webhook.payload_hash <> p_payload_hash THEN
    RAISE EXCEPTION 'webhook event replay conflict' USING ERRCODE = '22023';
  END IF;
  IF webhook.processed_at IS NOT NULL THEN
    RETURN 'replayed';
  END IF;
  UPDATE oao.workos_webhook_events
  SET processing_lease_expires_at = NULL,
      safe_error = p_safe_error
  WHERE event_id = p_event_id;
  RETURN 'released';
END
$$;

ALTER TABLE oao.workos_webhook_events
  ADD CONSTRAINT workos_webhook_events_safe_error_check
  CHECK (safe_error IS NULL OR NOT oao.jsonb_has_forbidden_public_key(safe_error)) NOT VALID;

CREATE FUNCTION oao.claim_api_request_idempotency(
  p_organization_id uuid,
  p_project_id uuid,
  p_principal_id uuid,
  p_http_method text,
  p_route_key text,
  p_idempotency_key text,
  p_request_hash bytea,
  p_expires_at timestamptz
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  ledger oao.api_request_idempotency;
BEGIN
  INSERT INTO oao.api_request_idempotency (
    organization_id, project_id, principal_id, http_method, route_key,
    idempotency_key, request_hash, expires_at
  ) VALUES (
    p_organization_id, p_project_id, p_principal_id, upper(p_http_method), p_route_key,
    p_idempotency_key, p_request_hash, p_expires_at
  ) ON CONFLICT DO NOTHING;
  SELECT * INTO ledger FROM oao.api_request_idempotency
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND principal_id = p_principal_id
    AND http_method = upper(p_http_method)
    AND route_key = p_route_key
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF ledger.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'idempotency key reused with different request' USING ERRCODE = '22023';
  END IF;
  RETURN CASE WHEN ledger.completed_at IS NULL THEN 'claimed' ELSE 'replayed' END;
END
$$;

CREATE FUNCTION oao.complete_api_request_idempotency(
  p_organization_id uuid,
  p_project_id uuid,
  p_principal_id uuid,
  p_http_method text,
  p_route_key text,
  p_idempotency_key text,
  p_request_hash bytea,
  p_status_code integer,
  p_response_public jsonb,
  p_resource_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  ledger oao.api_request_idempotency;
BEGIN
  IF oao.jsonb_has_forbidden_public_key(p_response_public) THEN
    RAISE EXCEPTION 'unsafe idempotency response' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO ledger FROM oao.api_request_idempotency
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND principal_id = p_principal_id
    AND http_method = upper(p_http_method)
    AND route_key = p_route_key
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'idempotency claim not found' USING ERRCODE = 'P0002';
  END IF;
  IF ledger.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'idempotency key reused with different request' USING ERRCODE = '22023';
  END IF;
  IF ledger.completed_at IS NOT NULL THEN
    IF ledger.status_code = p_status_code
       AND ledger.response_public = p_response_public
       AND ledger.resource_id IS NOT DISTINCT FROM p_resource_id THEN
      RETURN 'replayed';
    END IF;
    RAISE EXCEPTION 'idempotency response conflict' USING ERRCODE = '22023';
  END IF;
  UPDATE oao.api_request_idempotency
  SET status_code = p_status_code,
      response_public = p_response_public,
      resource_id = p_resource_id,
      completed_at = clock_timestamp()
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND principal_id = p_principal_id
    AND http_method = upper(p_http_method)
    AND route_key = p_route_key
    AND idempotency_key = p_idempotency_key;
  RETURN 'completed';
END
$$;

CREATE FUNCTION oao.publish_agent_version(
  p_organization_id uuid,
  p_project_id uuid,
  p_agent_definition_id uuid,
  p_version_id uuid,
  p_config jsonb,
  p_content_hash bytea,
  p_created_by_principal_id uuid
) RETURNS oao.agent_versions
LANGUAGE plpgsql
AS $$
DECLARE
  next_version integer;
  published oao.agent_versions;
BEGIN
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_config->'systemPrompt') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_config->'modelPreset') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_config->'tools') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_config->'sandboxPolicy') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid agent publication config' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_content_hash) <> 32 THEN
    RAISE EXCEPTION 'agent content hash must be 32 bytes' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM oao.agent_definitions
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_agent_definition_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent definition not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO next_version
  FROM oao.agent_versions
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND agent_definition_id = p_agent_definition_id;
  INSERT INTO oao.agent_versions (
    organization_id, project_id, id, agent_definition_id, version, config,
    content_hash, created_by_principal_id
  ) VALUES (
    p_organization_id, p_project_id, p_version_id, p_agent_definition_id,
    next_version, p_config, p_content_hash, p_created_by_principal_id
  ) RETURNING * INTO published;
  UPDATE oao.agent_definitions
  SET latest_version_id = p_version_id
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_agent_definition_id;
  RETURN published;
END
$$;

CREATE FUNCTION oao.renew_tool_call_claim(
  p_organization_id uuid,
  p_project_id uuid,
  p_tool_call_id uuid,
  p_principal_id uuid,
  p_claim_fence bigint,
  p_lease interval
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  renewed_fence bigint;
BEGIN
  IF p_lease <= interval '0 seconds' OR p_lease > interval '1 day' THEN
    RAISE EXCEPTION 'invalid tool claim lease' USING ERRCODE = '22023';
  END IF;
  UPDATE oao.tool_calls
  SET lease_expires_at = clock_timestamp() + p_lease,
      updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_tool_call_id
    AND stage IN ('caller_claimed', 'platform_executing')
    AND lease_holder_principal_id = p_principal_id
    AND claim_fence = p_claim_fence
    AND lease_expires_at > clock_timestamp()
  RETURNING claim_fence INTO renewed_fence;
  IF renewed_fence IS NULL THEN
    RAISE EXCEPTION 'stale tool execution fence' USING ERRCODE = '55000';
  END IF;
  RETURN renewed_fence;
END
$$;

CREATE FUNCTION oao.release_tool_call_claim(
  p_organization_id uuid,
  p_project_id uuid,
  p_tool_call_id uuid,
  p_principal_id uuid,
  p_claim_fence bigint
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  released_fence bigint;
BEGIN
  UPDATE oao.tool_calls
  SET stage = CASE owner
        WHEN 'caller' THEN 'caller_pending'::oao.tool_stage
        ELSE 'platform_ready'::oao.tool_stage
      END,
      claim_fence = claim_fence + 1,
      lease_holder_principal_id = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id
    AND project_id = p_project_id
    AND id = p_tool_call_id
    AND stage IN ('caller_claimed', 'platform_executing')
    AND lease_holder_principal_id = p_principal_id
    AND claim_fence = p_claim_fence
  RETURNING claim_fence INTO released_fence;
  IF released_fence IS NULL THEN
    RAISE EXCEPTION 'stale tool execution fence' USING ERRCODE = '55000';
  END IF;
  RETURN released_fence;
END
$$;

CREATE INDEX organization_members_role_idx
  ON oao.organization_members (organization_id, role, created_at, principal_id);
CREATE INDEX project_members_role_idx
  ON oao.project_members (organization_id, project_id, role, created_at, principal_id);
CREATE INDEX auth_identities_principal_idx
  ON oao.auth_identities (organization_id, project_id, principal_id);
CREATE INDEX auth_tenant_links_provider_idx
  ON oao.auth_tenant_links (provider, provider_tenant_id, organization_id, project_id);
CREATE INDEX auth_sessions_principal_idx
  ON oao.auth_sessions (organization_id, project_id, principal_id, created_at DESC);
CREATE INDEX auth_sessions_active_idx
  ON oao.auth_sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_project_created_idx
  ON oao.api_keys (organization_id, project_id, created_at DESC, id DESC);
CREATE INDEX api_request_idempotency_expiry_idx
  ON oao.api_request_idempotency (expires_at);
CREATE INDEX audit_entries_export_idx
  ON oao.audit_entries (organization_id, project_id, occurred_at, sequence);

ALTER TABLE oao.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.organization_members FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_members_tenant ON oao.organization_members
  USING (organization_id = oao.current_organization_id())
  WITH CHECK (organization_id = oao.current_organization_id());

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'project_members', 'auth_tenant_links', 'auth_identities', 'auth_sessions',
    'api_keys', 'api_request_idempotency'
  ] LOOP
    EXECUTE format('ALTER TABLE oao.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE oao.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON oao.%I USING (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id()) WITH CHECK (organization_id = oao.current_organization_id() AND project_id = oao.current_project_id())',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON oao.organization_members TO oao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oao.project_members TO oao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oao.auth_tenant_links TO oao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oao.auth_identities TO oao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oao.auth_sessions TO oao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oao.api_keys TO oao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oao.api_request_idempotency TO oao_app;

REVOKE ALL ON FUNCTION oao.bootstrap_project(uuid, text, text, uuid, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.bootstrap_project(uuid, text, text, uuid, text, text, uuid, text, text) TO oao_migrator;

REVOKE ALL ON oao.workos_webhook_events FROM oao_app;
REVOKE ALL ON FUNCTION oao.authenticate_api_key(text, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.resolve_auth_session(bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.resolve_workos_principal(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.claim_workos_webhook_event(text, text, bytea, timestamptz, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.complete_workos_webhook_event(text, bytea, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.release_workos_webhook_event(text, bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.authenticate_api_key(text, bytea, timestamptz) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.resolve_auth_session(bytea, timestamptz) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.resolve_workos_principal(text, text, uuid) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.claim_workos_webhook_event(text, text, bytea, timestamptz, interval) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.complete_workos_webhook_event(text, bytea, jsonb) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.release_workos_webhook_event(text, bytea, jsonb) TO oao_app;

REVOKE ALL ON FUNCTION oao.claim_api_request_idempotency(uuid, uuid, uuid, text, text, text, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.complete_api_request_idempotency(uuid, uuid, uuid, text, text, text, bytea, integer, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.publish_agent_version(uuid, uuid, uuid, uuid, jsonb, bytea, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.renew_tool_call_claim(uuid, uuid, uuid, uuid, bigint, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.release_tool_call_claim(uuid, uuid, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.claim_api_request_idempotency(uuid, uuid, uuid, text, text, text, bytea, timestamptz) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.complete_api_request_idempotency(uuid, uuid, uuid, text, text, text, bytea, integer, jsonb, uuid) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.publish_agent_version(uuid, uuid, uuid, uuid, jsonb, bytea, uuid) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.renew_tool_call_claim(uuid, uuid, uuid, uuid, bigint, interval) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.release_tool_call_claim(uuid, uuid, uuid, uuid, bigint) TO oao_app;

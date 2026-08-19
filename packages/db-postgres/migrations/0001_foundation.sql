CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oao_app') THEN
    CREATE ROLE oao_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oao_migrator') THEN
    CREATE ROLE oao_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS oao;
REVOKE ALL ON SCHEMA oao FROM PUBLIC;
GRANT USAGE ON SCHEMA oao TO oao_app;

CREATE TYPE oao.run_state AS ENUM (
  'queued', 'running', 'waiting_for_tool', 'waiting_for_approval',
  'retry_scheduled', 'completed', 'failed', 'cancelled', 'timed_out'
);
CREATE TYPE oao.principal_kind AS ENUM ('human', 'api_key', 'service');
CREATE TYPE oao.admission_state AS ENUM ('reserved', 'ambiguous', 'admitted');
CREATE TYPE oao.tool_call_status AS ENUM ('pending', 'claimed', 'result_submitted', 'committed', 'cancelled');
CREATE TYPE oao.approval_status AS ENUM ('pending', 'approved', 'denied', 'expired');

CREATE FUNCTION oao.current_organization_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('oao.organization_id', true), '')::uuid $$;
CREATE FUNCTION oao.current_project_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('oao.project_id', true), '')::uuid $$;
CREATE FUNCTION oao.set_tenant_context(p_organization_id uuid, p_project_id uuid) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_organization_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION 'tenant context requires organization and project';
  END IF;
  PERFORM set_config('oao.organization_id', p_organization_id::text, true);
  PERFORM set_config('oao.project_id', p_project_id::text, true);
END
$$;

CREATE TABLE oao.organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE oao.projects (
  organization_id uuid NOT NULL REFERENCES oao.organizations(id),
  id uuid NOT NULL,
  slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, slug)
);

CREATE TABLE oao.principals (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  kind oao.principal_kind NOT NULL,
  subject text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, kind, subject),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id)
);

CREATE TABLE oao.agent_definitions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  agent_key text NOT NULL CHECK (length(agent_key) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, agent_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id)
);

CREATE TABLE oao.agent_versions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  agent_definition_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  config jsonb NOT NULL,
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, agent_definition_id, version),
  UNIQUE (organization_id, project_id, agent_definition_id, content_hash),
  FOREIGN KEY (organization_id, project_id, agent_definition_id) REFERENCES oao.agent_definitions(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id) REFERENCES oao.principals(organization_id, project_id, id)
);

CREATE FUNCTION oao.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '23000';
END
$$;
CREATE TRIGGER agent_versions_immutable
BEFORE UPDATE OR DELETE ON oao.agent_versions
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE TABLE oao.threads (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id)
);

CREATE TABLE oao.sessions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  thread_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'idle', 'closed', 'errored')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, thread_id) REFERENCES oao.threads(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, agent_version_id) REFERENCES oao.agent_versions(organization_id, project_id, id)
);

CREATE TABLE oao.runs (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  thread_id uuid NOT NULL,
  session_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL,
  state oao.run_state NOT NULL DEFAULT 'queued',
  input_public jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL,
  cancellation_requested_at timestamptz,
  admitted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, idempotency_key),
  FOREIGN KEY (organization_id, project_id, thread_id) REFERENCES oao.threads(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, session_id) REFERENCES oao.sessions(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, agent_version_id) REFERENCES oao.agent_versions(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, created_by_principal_id) REFERENCES oao.principals(organization_id, project_id, id),
  CHECK ((state IN ('completed', 'failed', 'cancelled', 'timed_out')) = (settled_at IS NOT NULL)),
  CHECK (state <> 'retry_scheduled' OR admitted_at IS NULL)
);

CREATE TABLE oao.thread_admission_heads (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  run_id uuid NOT NULL,
  admission_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  state oao.admission_state NOT NULL DEFAULT 'reserved',
  fence bigint NOT NULL DEFAULT 1 CHECK (fence > 0),
  canonical_run_ref text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, thread_id),
  UNIQUE (organization_id, project_id, run_id),
  UNIQUE (organization_id, project_id, admission_key),
  FOREIGN KEY (organization_id, project_id, thread_id) REFERENCES oao.threads(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, run_id) REFERENCES oao.runs(organization_id, project_id, id)
);

CREATE TABLE oao.run_admission_attempts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  fence bigint NOT NULL CHECK (fence > 0),
  state text NOT NULL CHECK (state IN ('started', 'ambiguous', 'admitted', 'failed')),
  provider_request_id text,
  safe_error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, run_id, attempt),
  FOREIGN KEY (organization_id, project_id, run_id) REFERENCES oao.runs(organization_id, project_id, id)
);

CREATE FUNCTION oao.validate_run_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  legal boolean := false;
  has_head boolean;
BEGIN
  IF NEW.state = OLD.state THEN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  legal := CASE OLD.state
    WHEN 'queued' THEN NEW.state IN ('running', 'retry_scheduled', 'cancelled', 'failed', 'timed_out')
    WHEN 'retry_scheduled' THEN NEW.state IN ('queued', 'cancelled', 'failed', 'timed_out')
    WHEN 'running' THEN NEW.state IN ('waiting_for_tool', 'waiting_for_approval', 'completed', 'failed', 'cancelled', 'timed_out')
    WHEN 'waiting_for_tool' THEN NEW.state IN ('running', 'waiting_for_approval', 'failed', 'cancelled', 'timed_out')
    WHEN 'waiting_for_approval' THEN NEW.state IN ('running', 'waiting_for_tool', 'failed', 'cancelled', 'timed_out')
    ELSE false
  END;
  IF NOT legal THEN
    RAISE EXCEPTION 'illegal run transition: % -> %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'retry_scheduled' AND (OLD.admitted_at IS NOT NULL OR NEW.admitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'retry_scheduled is pre-admission only' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('queued', 'retry_scheduled') AND NEW.state = 'cancelled' THEN
    SELECT EXISTS (
      SELECT 1 FROM oao.thread_admission_heads h
      WHERE h.organization_id = OLD.organization_id AND h.project_id = OLD.project_id AND h.run_id = OLD.id
    ) INTO has_head;
    IF has_head THEN
      RAISE EXCEPTION 'reserved run cancellation requires reconciliation' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state = 'running' AND NEW.admitted_at IS NULL THEN NEW.admitted_at := clock_timestamp(); END IF;
  IF NEW.state IN ('completed', 'failed', 'cancelled', 'timed_out') AND NEW.settled_at IS NULL THEN NEW.settled_at := clock_timestamp(); END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER runs_validate_transition BEFORE UPDATE OF state ON oao.runs
FOR EACH ROW EXECUTE FUNCTION oao.validate_run_transition();

CREATE FUNCTION oao.reserve_thread_admission(
  p_organization_id uuid, p_project_id uuid, p_thread_id uuid, p_run_id uuid,
  p_admission_key text, p_request_hash bytea
) RETURNS oao.thread_admission_heads
LANGUAGE plpgsql AS $$
DECLARE head oao.thread_admission_heads; current_run oao.runs;
BEGIN
  SELECT * INTO current_run FROM oao.runs
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO head FROM oao.thread_admission_heads
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND thread_id = p_thread_id
  FOR UPDATE;
  IF FOUND THEN
    IF head.run_id <> p_run_id THEN
      RAISE EXCEPTION 'thread already has an admitted or ambiguous head' USING ERRCODE = '23505';
    END IF;
    IF head.admission_key <> p_admission_key OR head.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'admission idempotency conflict' USING ERRCODE = '22023';
    END IF;
    RETURN head;
  END IF;
  IF current_run.thread_id <> p_thread_id OR current_run.state NOT IN ('queued', 'retry_scheduled')
     OR current_run.cancellation_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'run is not eligible for admission' USING ERRCODE = '55000';
  END IF;
  INSERT INTO oao.thread_admission_heads
    (organization_id, project_id, thread_id, run_id, admission_key, request_hash)
  VALUES (p_organization_id, p_project_id, p_thread_id, p_run_id, p_admission_key, p_request_hash)
  ON CONFLICT (organization_id, project_id, thread_id) DO NOTHING;
  SELECT * INTO head FROM oao.thread_admission_heads
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND thread_id = p_thread_id FOR UPDATE;
  IF head.run_id <> p_run_id THEN RAISE EXCEPTION 'thread already has an admitted or ambiguous head' USING ERRCODE = '23505'; END IF;
  RETURN head;
END
$$;

CREATE FUNCTION oao.request_run_cancellation(
  p_organization_id uuid, p_project_id uuid, p_run_id uuid
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE current_run oao.runs; has_head boolean;
BEGIN
  SELECT * INTO current_run FROM oao.runs
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'run not found' USING ERRCODE = 'P0002'; END IF;
  IF current_run.state IN ('completed', 'failed', 'cancelled', 'timed_out') THEN RETURN 'already_settled'; END IF;
  SELECT EXISTS (SELECT 1 FROM oao.thread_admission_heads h
    WHERE h.organization_id = p_organization_id AND h.project_id = p_project_id AND h.run_id = p_run_id) INTO has_head;
  IF current_run.state IN ('queued', 'retry_scheduled') AND NOT has_head THEN
    UPDATE oao.runs SET state = 'cancelled', cancellation_requested_at = clock_timestamp()
    WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_run_id;
    RETURN 'cancelled_pre_admission';
  END IF;
  UPDATE oao.runs SET cancellation_requested_at = COALESCE(cancellation_requested_at, clock_timestamp())
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_run_id;
  RETURN 'reconcile_and_abort';
END
$$;

CREATE TABLE oao.messages (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  thread_id uuid NOT NULL,
  run_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  redacted_content text NOT NULL,
  flue_message_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, thread_id) REFERENCES oao.threads(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, run_id) REFERENCES oao.runs(organization_id, project_id, id)
);

CREATE TABLE oao.tool_calls (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  tool_name text NOT NULL,
  status oao.tool_call_status NOT NULL DEFAULT 'pending',
  safe_arguments jsonb NOT NULL DEFAULT '{}',
  claim_fence bigint NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  claimed_by_principal_id uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, run_id, id),
  FOREIGN KEY (organization_id, project_id, run_id) REFERENCES oao.runs(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, claimed_by_principal_id) REFERENCES oao.principals(organization_id, project_id, id),
  CHECK ((status = 'claimed') = (claimed_by_principal_id IS NOT NULL AND claim_expires_at IS NOT NULL))
);

CREATE TABLE oao.tool_call_results (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  tool_call_id uuid NOT NULL,
  claim_fence bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  safe_result jsonb NOT NULL,
  submitted_by_principal_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  PRIMARY KEY (organization_id, project_id, tool_call_id),
  UNIQUE (organization_id, project_id, idempotency_key),
  FOREIGN KEY (organization_id, project_id, tool_call_id) REFERENCES oao.tool_calls(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, submitted_by_principal_id) REFERENCES oao.principals(organization_id, project_id, id)
);
CREATE FUNCTION oao.validate_tool_result_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.committed_at IS NOT NULL OR NEW.committed_at IS NULL
     OR NEW.organization_id <> OLD.organization_id OR NEW.project_id <> OLD.project_id
     OR NEW.tool_call_id <> OLD.tool_call_id OR NEW.claim_fence <> OLD.claim_fence
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_hash <> OLD.request_hash
     OR NEW.safe_result <> OLD.safe_result OR NEW.submitted_by_principal_id <> OLD.submitted_by_principal_id
     OR NEW.submitted_at <> OLD.submitted_at THEN
    RAISE EXCEPTION 'tool call result is immutable' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tool_call_results_immutable BEFORE UPDATE OR DELETE ON oao.tool_call_results
FOR EACH ROW EXECUTE FUNCTION oao.validate_tool_result_mutation();

CREATE FUNCTION oao.claim_tool_call(
  p_organization_id uuid, p_project_id uuid, p_tool_call_id uuid,
  p_principal_id uuid, p_lease interval
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE next_fence bigint;
BEGIN
  UPDATE oao.tool_calls
  SET status = 'claimed', claim_fence = claim_fence + 1,
      claimed_by_principal_id = p_principal_id, claim_expires_at = clock_timestamp() + p_lease,
      updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id
    AND status IN ('pending', 'claimed')
    AND (status = 'pending' OR claim_expires_at <= clock_timestamp() OR claimed_by_principal_id = p_principal_id)
  RETURNING claim_fence INTO next_fence;
  IF next_fence IS NULL THEN RAISE EXCEPTION 'tool call is not claimable' USING ERRCODE = '55000'; END IF;
  RETURN next_fence;
END
$$;

CREATE FUNCTION oao.submit_tool_result(
  p_organization_id uuid, p_project_id uuid, p_tool_call_id uuid,
  p_principal_id uuid, p_claim_fence bigint, p_idempotency_key text,
  p_request_hash bytea, p_safe_result jsonb
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE call oao.tool_calls; existing oao.tool_call_results;
BEGIN
  SELECT * INTO call FROM oao.tool_calls
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tool call not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO existing FROM oao.tool_call_results
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND tool_call_id = p_tool_call_id;
  IF FOUND THEN
    IF existing.idempotency_key = p_idempotency_key AND existing.request_hash = p_request_hash THEN RETURN 'replayed'; END IF;
    RAISE EXCEPTION 'tool result idempotency conflict' USING ERRCODE = '22023';
  END IF;
  IF call.status <> 'claimed' OR call.claimed_by_principal_id <> p_principal_id
     OR call.claim_fence <> p_claim_fence OR call.claim_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'stale tool claim fence' USING ERRCODE = '55000';
  END IF;
  INSERT INTO oao.tool_call_results
    (organization_id, project_id, tool_call_id, claim_fence, idempotency_key, request_hash, safe_result, submitted_by_principal_id)
  VALUES (p_organization_id, p_project_id, p_tool_call_id, p_claim_fence, p_idempotency_key, p_request_hash, p_safe_result, p_principal_id);
  UPDATE oao.tool_calls SET status = 'result_submitted', claimed_by_principal_id = NULL,
    claim_expires_at = NULL, updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id;
  RETURN 'submitted';
END
$$;

CREATE FUNCTION oao.commit_tool_result(
  p_organization_id uuid, p_project_id uuid, p_tool_call_id uuid,
  p_claim_fence bigint, p_idempotency_key text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE result oao.tool_call_results;
BEGIN
  SELECT * INTO result FROM oao.tool_call_results
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND tool_call_id = p_tool_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tool result not found' USING ERRCODE = 'P0002'; END IF;
  IF result.claim_fence <> p_claim_fence OR result.idempotency_key <> p_idempotency_key THEN
    RAISE EXCEPTION 'tool result commit fence mismatch' USING ERRCODE = '55000';
  END IF;
  IF result.committed_at IS NOT NULL THEN RETURN 'replayed'; END IF;
  UPDATE oao.tool_call_results SET committed_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND tool_call_id = p_tool_call_id;
  UPDATE oao.tool_calls SET status = 'committed', updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id;
  RETURN 'committed';
END
$$;

CREATE TABLE oao.approvals (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  tool_call_id uuid,
  status oao.approval_status NOT NULL DEFAULT 'pending',
  summary text NOT NULL,
  expires_at timestamptz,
  resolved_by_principal_id uuid,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, run_id) REFERENCES oao.runs(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, tool_call_id) REFERENCES oao.tool_calls(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, resolved_by_principal_id) REFERENCES oao.principals(organization_id, project_id, id),
  CHECK ((status = 'pending') = (resolved_at IS NULL AND resolved_by_principal_id IS NULL))
);

CREATE FUNCTION oao.cleanup_resolved_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('denied', 'expired') AND NEW.tool_call_id IS NOT NULL THEN
    UPDATE oao.tool_calls SET status = 'cancelled', claim_fence = claim_fence + 1,
      claimed_by_principal_id = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
    WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id AND id = NEW.tool_call_id
      AND status IN ('pending', 'claimed');
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER approvals_cleanup AFTER UPDATE OF status ON oao.approvals
FOR EACH ROW EXECUTE FUNCTION oao.cleanup_resolved_approval();

CREATE FUNCTION oao.resolve_approval(
  p_organization_id uuid, p_project_id uuid, p_approval_id uuid,
  p_status oao.approval_status, p_principal_id uuid, p_note text
) RETURNS oao.approvals LANGUAGE plpgsql AS $$
DECLARE resolved oao.approvals;
BEGIN
  IF p_status NOT IN ('approved', 'denied') THEN RAISE EXCEPTION 'invalid approval resolution' USING ERRCODE = '22023'; END IF;
  UPDATE oao.approvals SET status = p_status, resolved_by_principal_id = p_principal_id,
    resolution_note = p_note, resolved_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_approval_id AND status = 'pending'
    AND (expires_at IS NULL OR expires_at > clock_timestamp()) RETURNING * INTO resolved;
  IF resolved.id IS NULL THEN RAISE EXCEPTION 'approval is not pending' USING ERRCODE = '55000'; END IF;
  RETURN resolved;
END
$$;

CREATE FUNCTION oao.expire_approvals(p_now timestamptz DEFAULT clock_timestamp()) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  UPDATE oao.approvals SET status = 'expired', resolved_at = p_now,
    resolved_by_principal_id = NULL, resolution_note = 'expired'
  WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= p_now;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

CREATE TABLE oao.api_idempotency (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status_code integer,
  response_public jsonb,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, project_id, scope, idempotency_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id),
  CHECK ((status_code IS NULL) = (response_public IS NULL))
);

CREATE FUNCTION oao.claim_idempotency(
  p_organization_id uuid, p_project_id uuid, p_scope text,
  p_key text, p_request_hash bytea, p_expires_at timestamptz
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE ledger oao.api_idempotency;
BEGIN
  INSERT INTO oao.api_idempotency
    (organization_id, project_id, scope, idempotency_key, request_hash, expires_at)
  VALUES (p_organization_id, p_project_id, p_scope, p_key, p_request_hash, p_expires_at)
  ON CONFLICT DO NOTHING;
  SELECT * INTO ledger FROM oao.api_idempotency
  WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND scope = p_scope AND idempotency_key = p_key FOR UPDATE;
  IF ledger.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'idempotency key reused with different request' USING ERRCODE = '22023';
  END IF;
  RETURN CASE WHEN ledger.status_code IS NULL THEN 'claimed' ELSE 'replayed' END;
END
$$;

CREATE TABLE oao.workos_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  safe_error jsonb
);

CREATE TABLE oao.session_summaries (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  summary_version bigint NOT NULL DEFAULT 1 CHECK (summary_version > 0),
  redacted_summary text NOT NULL DEFAULT '',
  run_count bigint NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_microunits bigint NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, session_id),
  FOREIGN KEY (organization_id, project_id, session_id) REFERENCES oao.sessions(organization_id, project_id, id)
);

CREATE TABLE oao.timeline_entries (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  entry_sequence bigint NOT NULL CHECK (entry_sequence > 0),
  entry_type text NOT NULL CHECK (entry_type IN (
    'run', 'model_invocation', 'tool_call', 'approval', 'sandbox', 'recovery', 'error'
  )),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  safe_detail jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (organization_id, project_id, run_id, entry_sequence),
  FOREIGN KEY (organization_id, project_id, run_id) REFERENCES oao.runs(organization_id, project_id, id),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE oao.model_invocations (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  provider_key text NOT NULL,
  model_key text NOT NULL,
  provider_request_id text,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'cancelled')),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cost_microunits bigint CHECK (cost_microunits >= 0),
  safe_request jsonb NOT NULL DEFAULT '{}',
  safe_response jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, run_id, attempt),
  FOREIGN KEY (organization_id, project_id, run_id) REFERENCES oao.runs(organization_id, project_id, id)
);

CREATE TABLE oao.project_event_positions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  committed_position bigint NOT NULL DEFAULT 0 CHECK (committed_position >= 0),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id)
);

CREATE FUNCTION oao.jsonb_has_forbidden_public_key(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE pair record; item jsonb;
BEGIN
  IF jsonb_typeof(p_value) = 'object' THEN
    FOR pair IN SELECT entry.key, entry.value FROM jsonb_each(p_value) AS entry LOOP
      IF pair.key ~* '(authorization|cookie|password|secret|token|chain.?of.?thought|reasoning|raw.?payload|tool.?payload)' THEN
        RETURN true;
      END IF;
      IF oao.jsonb_has_forbidden_public_key(pair.value) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR item IN SELECT jsonb_array_elements(p_value) LOOP
      IF oao.jsonb_has_forbidden_public_key(item) THEN RETURN true; END IF;
    END LOOP;
  END IF;
  RETURN false;
END
$$;

CREATE TABLE oao.product_events (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  project_position bigint NOT NULL CHECK (project_position > 0),
  id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence > 0),
  event_kind text NOT NULL CHECK (event_kind IN (
    'run.created', 'run.state_changed', 'run.cancellation_requested', 'message.created',
    'tool_call.requested', 'tool_call.claimed', 'tool_call.result_submitted', 'tool_call.result_committed',
    'approval.requested', 'approval.resolved', 'sandbox.created', 'sandbox.started',
    'sandbox.stopped', 'sandbox.failed', 'model.invocation_completed'
  )),
  public_payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, project_position),
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, aggregate_type, aggregate_id, aggregate_sequence),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id),
  CHECK (jsonb_typeof(public_payload) = 'object'),
  CHECK (NOT oao.jsonb_has_forbidden_public_key(public_payload))
);

CREATE FUNCTION oao.append_product_event(
  p_organization_id uuid, p_project_id uuid, p_id uuid,
  p_aggregate_type text, p_aggregate_id uuid, p_event_kind text,
  p_public_payload jsonb, p_occurred_at timestamptz
) RETURNS oao.product_events LANGUAGE plpgsql AS $$
DECLARE next_position bigint; next_sequence bigint; appended oao.product_events;
BEGIN
  INSERT INTO oao.project_event_positions (organization_id, project_id)
  VALUES (p_organization_id, p_project_id) ON CONFLICT DO NOTHING;
  UPDATE oao.project_event_positions SET committed_position = committed_position + 1
  WHERE organization_id = p_organization_id AND project_id = p_project_id
  RETURNING committed_position INTO next_position;
  SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 INTO next_sequence
  FROM oao.product_events WHERE organization_id = p_organization_id AND project_id = p_project_id
    AND aggregate_type = p_aggregate_type AND aggregate_id = p_aggregate_id;
  INSERT INTO oao.product_events (
    organization_id, project_id, project_position, id, aggregate_type, aggregate_id,
    aggregate_sequence, event_kind, public_payload, occurred_at
  ) VALUES (
    p_organization_id, p_project_id, next_position, p_id, p_aggregate_type, p_aggregate_id,
    next_sequence, p_event_kind, p_public_payload, p_occurred_at
  ) RETURNING * INTO appended;
  PERFORM pg_notify('oao_product_events', p_organization_id::text || '/' || p_project_id::text);
  RETURN appended;
END
$$;

CREATE TABLE oao.audit_chain_heads (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_hash bytea NOT NULL DEFAULT decode(repeat('00', 32), 'hex') CHECK (octet_length(last_hash) = 32),
  PRIMARY KEY (organization_id, project_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id)
);

CREATE TABLE oao.audit_entries (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  safe_detail jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  previous_hash bytea NOT NULL CHECK (octet_length(previous_hash) = 32),
  entry_hash bytea NOT NULL CHECK (octet_length(entry_hash) = 32),
  PRIMARY KEY (organization_id, project_id, sequence),
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, principal_id) REFERENCES oao.principals(organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES oao.projects(organization_id, id),
  CHECK (NOT oao.jsonb_has_forbidden_public_key(safe_detail))
);
CREATE TRIGGER audit_entries_immutable BEFORE UPDATE OR DELETE ON oao.audit_entries
FOR EACH ROW EXECUTE FUNCTION oao.reject_mutation();

CREATE FUNCTION oao.append_audit_entry(
  p_organization_id uuid, p_project_id uuid, p_id uuid, p_principal_id uuid,
  p_action text, p_resource_type text, p_resource_id text, p_safe_detail jsonb, p_occurred_at timestamptz
) RETURNS oao.audit_entries LANGUAGE plpgsql AS $$
DECLARE head oao.audit_chain_heads; next_hash bytea; appended oao.audit_entries;
BEGIN
  INSERT INTO oao.audit_chain_heads (organization_id, project_id)
  VALUES (p_organization_id, p_project_id) ON CONFLICT DO NOTHING;
  SELECT * INTO head FROM oao.audit_chain_heads
  WHERE organization_id = p_organization_id AND project_id = p_project_id FOR UPDATE;
  next_hash := digest(
    encode(head.last_hash, 'hex') || '|' || (head.last_sequence + 1)::text || '|' || p_id::text || '|' ||
    p_principal_id::text || '|' || p_action || '|' || p_resource_type || '|' || p_resource_id || '|' ||
    p_safe_detail::text || '|' || p_occurred_at::text,
    'sha256'
  );
  INSERT INTO oao.audit_entries (
    organization_id, project_id, sequence, id, principal_id, action, resource_type,
    resource_id, safe_detail, occurred_at, previous_hash, entry_hash
  ) VALUES (
    p_organization_id, p_project_id, head.last_sequence + 1, p_id, p_principal_id, p_action,
    p_resource_type, p_resource_id, p_safe_detail, p_occurred_at, head.last_hash, next_hash
  ) RETURNING * INTO appended;
  UPDATE oao.audit_chain_heads SET last_sequence = appended.sequence, last_hash = next_hash
  WHERE organization_id = p_organization_id AND project_id = p_project_id;
  RETURN appended;
END
$$;

CREATE INDEX runs_thread_created_idx ON oao.runs (organization_id, project_id, thread_id, created_at DESC, id DESC);
CREATE INDEX runs_state_created_idx ON oao.runs (organization_id, project_id, state, created_at, id);
CREATE INDEX sessions_activity_idx ON oao.sessions (organization_id, project_id, last_activity_at DESC, id DESC);
CREATE INDEX messages_thread_created_idx ON oao.messages (organization_id, project_id, thread_id, created_at, id);
CREATE INDEX tool_calls_pending_idx ON oao.tool_calls (organization_id, project_id, status, created_at) WHERE status IN ('pending', 'claimed');
CREATE INDEX approvals_pending_idx ON oao.approvals (organization_id, project_id, expires_at, created_at) WHERE status = 'pending';
CREATE INDEX product_events_aggregate_idx ON oao.product_events (organization_id, project_id, aggregate_type, aggregate_id, aggregate_sequence);
CREATE INDEX timeline_run_started_idx ON oao.timeline_entries (organization_id, project_id, run_id, started_at, entry_sequence);
CREATE INDEX model_invocations_run_idx ON oao.model_invocations (organization_id, project_id, run_id, started_at, attempt);

ALTER TABLE oao.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant ON oao.organizations
  USING (id = oao.current_organization_id()) WITH CHECK (id = oao.current_organization_id());

ALTER TABLE oao.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE oao.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant ON oao.projects
  USING (organization_id = oao.current_organization_id() AND id = oao.current_project_id())
  WITH CHECK (organization_id = oao.current_organization_id() AND id = oao.current_project_id());

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'principals', 'agent_definitions', 'agent_versions', 'threads', 'sessions', 'runs',
    'thread_admission_heads', 'run_admission_attempts', 'messages', 'tool_calls', 'tool_call_results',
    'approvals', 'api_idempotency', 'session_summaries', 'timeline_entries', 'model_invocations',
    'project_event_positions', 'product_events', 'audit_chain_heads', 'audit_entries'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA oao TO oao_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA oao FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA oao TO oao_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA oao REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA oao GRANT EXECUTE ON FUNCTIONS TO oao_app;

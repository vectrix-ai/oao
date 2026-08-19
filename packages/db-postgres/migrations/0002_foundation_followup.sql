ALTER TABLE oao.runs
  ADD CONSTRAINT runs_tenant_thread_id_key
  UNIQUE (organization_id, project_id, thread_id, id);

ALTER TABLE oao.sessions
  ADD CONSTRAINT sessions_tenant_id_thread_version_key
  UNIQUE (organization_id, project_id, id, thread_id, agent_version_id);

ALTER TABLE oao.thread_admission_heads
  ADD CONSTRAINT thread_admission_heads_run_thread_fkey
  FOREIGN KEY (organization_id, project_id, thread_id, run_id)
  REFERENCES oao.runs (organization_id, project_id, thread_id, id);

ALTER TABLE oao.runs
  ADD CONSTRAINT runs_session_thread_version_fkey
  FOREIGN KEY (organization_id, project_id, session_id, thread_id, agent_version_id)
  REFERENCES oao.sessions (organization_id, project_id, id, thread_id, agent_version_id);

ALTER TABLE oao.messages
  ADD CONSTRAINT messages_run_thread_fkey
  FOREIGN KEY (organization_id, project_id, thread_id, run_id)
  REFERENCES oao.runs (organization_id, project_id, thread_id, id);

ALTER TABLE oao.approvals
  ADD CONSTRAINT approvals_tool_call_run_fkey
  FOREIGN KEY (organization_id, project_id, run_id, tool_call_id)
  REFERENCES oao.tool_calls (organization_id, project_id, run_id, id);

CREATE TYPE oao.tool_owner AS ENUM ('caller', 'platform');
CREATE TYPE oao.tool_stage AS ENUM (
  'caller_pending',
  'caller_claimed',
  'platform_ready',
  'platform_executing',
  'result_submitted',
  'result_committed',
  'approval_denied',
  'approval_expired',
  'cancelled',
  'expired',
  'failed'
);

DROP INDEX oao.tool_calls_pending_idx;

ALTER TABLE oao.tool_calls
  ADD COLUMN owner oao.tool_owner NOT NULL DEFAULT 'caller',
  ADD COLUMN stage oao.tool_stage;

UPDATE oao.tool_calls
SET stage = CASE status
  WHEN 'pending' THEN 'caller_pending'::oao.tool_stage
  WHEN 'claimed' THEN 'caller_claimed'::oao.tool_stage
  WHEN 'result_submitted' THEN 'result_submitted'::oao.tool_stage
  WHEN 'committed' THEN 'result_committed'::oao.tool_stage
  WHEN 'cancelled' THEN 'cancelled'::oao.tool_stage
END;

ALTER TABLE oao.tool_calls
  ALTER COLUMN stage SET NOT NULL,
  ALTER COLUMN stage SET DEFAULT 'caller_pending',
  DROP COLUMN status;

ALTER TABLE oao.tool_calls
  RENAME COLUMN claimed_by_principal_id TO lease_holder_principal_id;

ALTER TABLE oao.tool_calls
  RENAME COLUMN claim_expires_at TO lease_expires_at;

DROP TYPE oao.tool_call_status;

ALTER TABLE oao.tool_calls
  ADD CONSTRAINT tool_calls_owner_stage_check CHECK (
    (owner = 'caller' AND stage NOT IN ('platform_ready', 'platform_executing'))
    OR
    (owner = 'platform' AND stage NOT IN ('caller_pending', 'caller_claimed'))
  ),
  ADD CONSTRAINT tool_calls_lease_stage_check CHECK (
    (stage IN ('caller_claimed', 'platform_executing'))
    =
    (lease_holder_principal_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

CREATE INDEX tool_calls_actionable_idx
  ON oao.tool_calls (organization_id, project_id, owner, stage, created_at)
  WHERE stage IN ('caller_pending', 'caller_claimed', 'platform_ready', 'platform_executing');

CREATE OR REPLACE FUNCTION oao.claim_tool_call(
  p_organization_id uuid, p_project_id uuid, p_tool_call_id uuid,
  p_principal_id uuid, p_lease interval
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE next_fence bigint;
BEGIN
  UPDATE oao.tool_calls
  SET stage = 'caller_claimed', claim_fence = claim_fence + 1,
      lease_holder_principal_id = p_principal_id, lease_expires_at = clock_timestamp() + p_lease,
      updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id
    AND owner = 'caller'
    AND stage IN ('caller_pending', 'caller_claimed')
    AND (stage = 'caller_pending' OR lease_expires_at <= clock_timestamp() OR lease_holder_principal_id = p_principal_id)
  RETURNING claim_fence INTO next_fence;
  IF next_fence IS NULL THEN RAISE EXCEPTION 'caller tool call is not claimable' USING ERRCODE = '55000'; END IF;
  RETURN next_fence;
END
$$;

CREATE FUNCTION oao.begin_platform_tool_execution(
  p_organization_id uuid, p_project_id uuid, p_tool_call_id uuid,
  p_service_principal_id uuid, p_lease interval
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE next_fence bigint;
BEGIN
  UPDATE oao.tool_calls
  SET stage = 'platform_executing', claim_fence = claim_fence + 1,
      lease_holder_principal_id = p_service_principal_id, lease_expires_at = clock_timestamp() + p_lease,
      updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id
    AND owner = 'platform'
    AND stage IN ('platform_ready', 'platform_executing')
    AND (stage = 'platform_ready' OR lease_expires_at <= clock_timestamp() OR lease_holder_principal_id = p_service_principal_id)
  RETURNING claim_fence INTO next_fence;
  IF next_fence IS NULL THEN RAISE EXCEPTION 'platform tool call is not executable' USING ERRCODE = '55000'; END IF;
  RETURN next_fence;
END
$$;

CREATE OR REPLACE FUNCTION oao.submit_tool_result(
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
  IF call.stage NOT IN ('caller_claimed', 'platform_executing')
     OR call.lease_holder_principal_id <> p_principal_id
     OR call.claim_fence <> p_claim_fence OR call.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'stale tool execution fence' USING ERRCODE = '55000';
  END IF;
  INSERT INTO oao.tool_call_results
    (organization_id, project_id, tool_call_id, claim_fence, idempotency_key, request_hash, safe_result, submitted_by_principal_id)
  VALUES (p_organization_id, p_project_id, p_tool_call_id, p_claim_fence, p_idempotency_key, p_request_hash, p_safe_result, p_principal_id);
  UPDATE oao.tool_calls SET stage = 'result_submitted', lease_holder_principal_id = NULL,
    lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id;
  RETURN 'submitted';
END
$$;

CREATE OR REPLACE FUNCTION oao.commit_tool_result(
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
  UPDATE oao.tool_calls SET stage = 'result_committed', updated_at = clock_timestamp()
  WHERE organization_id = p_organization_id AND project_id = p_project_id AND id = p_tool_call_id;
  RETURN 'committed';
END
$$;

CREATE OR REPLACE FUNCTION oao.cleanup_resolved_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('denied', 'expired') AND NEW.tool_call_id IS NOT NULL THEN
    UPDATE oao.tool_calls SET
      stage = CASE NEW.status
        WHEN 'denied' THEN 'approval_denied'::oao.tool_stage
        ELSE 'approval_expired'::oao.tool_stage
      END,
      claim_fence = claim_fence + 1,
      lease_holder_principal_id = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
    WHERE organization_id = NEW.organization_id AND project_id = NEW.project_id AND id = NEW.tool_call_id
      AND stage IN ('caller_pending', 'caller_claimed', 'platform_ready', 'platform_executing', 'result_submitted');
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION oao.is_sensitive_public_key(p_key text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE normalized text := lower(regexp_replace(p_key, '[^a-zA-Z0-9]', '', 'g'));
BEGIN
  IF normalized ~ '^(?:(?:cached)?(?:input|output)|total|reasoning)tokens?$'
     OR normalized ~ '^tokencounts?$' THEN
    RETURN false;
  END IF;
  IF normalized = ANY (ARRAY[
    'authorization', 'authorizationheader', 'cookie', 'cookies', 'setcookie',
    'password', 'passwd', 'dbpassword', 'secret', 'secrets', 'secretkey', 'secretvalue',
    'clientsecret', 'apisecret', 'apikey', 'accesskey', 'privatekey', 'signingsecret', 'webhooksecret',
    'rawprompt', 'rawprompts', 'promptraw', 'rawpayload', 'rawpayloads', 'payloadraw',
    'toolpayload', 'toolpayloads', 'reasoning', 'reasoningcontent', 'rawreasoning',
    'chainofthought', 'chainofthoughts', 'cot'
  ]) THEN
    RETURN true;
  END IF;
  IF normalized ~ '(authorization|cookie|password|passwd|secret|rawprompt|rawpayload|toolpayload|reasoning|chainofthought)' THEN
    RETURN true;
  END IF;
  RETURN normalized ~ '^(?:tokens?|(?:access|api|auth|bearer|csrf|id|oauth|personalaccess|provider|refresh|session)tokens?)$';
END
$$;

CREATE OR REPLACE FUNCTION oao.jsonb_has_forbidden_public_key(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE pair record; item jsonb;
BEGIN
  IF jsonb_typeof(p_value) = 'object' THEN
    FOR pair IN SELECT entry.key, entry.value FROM jsonb_each(p_value) AS entry LOOP
      IF oao.is_sensitive_public_key(pair.key) THEN RETURN true; END IF;
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

REVOKE ALL ON FUNCTION oao.begin_platform_tool_execution(uuid, uuid, uuid, uuid, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.begin_platform_tool_execution(uuid, uuid, uuid, uuid, interval) TO oao_app;
REVOKE ALL ON FUNCTION oao.is_sensitive_public_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.is_sensitive_public_key(text) TO oao_app;

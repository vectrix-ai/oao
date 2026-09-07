-- Publication replays only validate the persisted request. FOR UPDATE here
-- conflicts with approval cleanup's tool-stage update, while the publisher
-- can also wait on the approval row when replaying its INSERT. Keep the tool
-- identity stable without blocking non-key updates such as denial/expiry.
CREATE OR REPLACE FUNCTION oao.publish_runtime_tool_call(
  p_organization_id uuid, p_project_id uuid, p_id uuid, p_run_id uuid,
  p_flue_tool_call_ref text, p_request_key text, p_request_hash bytea,
  p_tool_name text, p_owner oao.tool_owner, p_safe_arguments jsonb
) RETURNS oao.tool_calls LANGUAGE plpgsql AS $$
DECLARE call oao.tool_calls;
BEGIN
  INSERT INTO oao.tool_calls (
    organization_id, project_id, id, run_id, tool_name, owner, stage,
    safe_arguments, flue_tool_call_ref, request_key, request_hash
  ) VALUES (
    p_organization_id, p_project_id, p_id, p_run_id, p_tool_name, p_owner,
    CASE WHEN p_owner = 'caller' THEN 'caller_pending'::oao.tool_stage ELSE 'platform_ready'::oao.tool_stage END,
    p_safe_arguments, p_flue_tool_call_ref, p_request_key, p_request_hash
  ) ON CONFLICT (organization_id, project_id, request_key) DO NOTHING;
  SELECT * INTO call FROM oao.tool_calls
    WHERE organization_id = p_organization_id AND project_id = p_project_id
      AND request_key = p_request_key FOR KEY SHARE;
  IF call.request_hash <> p_request_hash OR call.run_id <> p_run_id
     OR call.flue_tool_call_ref <> p_flue_tool_call_ref OR call.tool_name <> p_tool_name
     OR call.owner <> p_owner THEN
    RAISE EXCEPTION 'runtime tool request idempotency conflict' USING ERRCODE = '22023';
  END IF;
  RETURN call;
END
$$;

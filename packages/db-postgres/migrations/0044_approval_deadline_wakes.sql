-- Recheck deadlines when a gate closes, even with no worker or caller result.
-- Follow the requesting run, so a later follow-up does not pause old parents.
CREATE INDEX delegation_runs_requester_idx
  ON oao.delegation_runs (organization_id, project_id, requested_by_run_id);

CREATE FUNCTION oao.wake_resolved_approval_deadlines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_run uuid;
  wake_key text;
BEGIN
  FOR affected_run IN
    WITH RECURSIVE ancestors(run_id) AS (
      SELECT NEW.run_id
      UNION
      SELECT link.requested_by_run_id
      FROM oao.delegation_runs link JOIN ancestors ON ancestors.run_id=link.child_run_id
      WHERE link.organization_id=NEW.organization_id AND link.project_id=NEW.project_id
    )
    SELECT dispatch.run_id FROM oao.runtime_dispatches dispatch JOIN ancestors USING (run_id)
    WHERE dispatch.organization_id=NEW.organization_id AND dispatch.project_id=NEW.project_id
      AND dispatch.state <> 'settled'
    ORDER BY dispatch.run_id
  LOOP
    wake_key := 'approval-resolved:' || NEW.id::text || ':' || affected_run::text;
    PERFORM oao.enqueue_runtime_wake(
      NEW.organization_id,NEW.project_id,gen_random_uuid(),affected_run,
      wake_key,digest(wake_key,'sha256'),'deadline',
      '{"reason":"approval_resolved"}'::jsonb,clock_timestamp()
    );
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER approval_deadline_wakes AFTER UPDATE OF status ON oao.approvals
FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status <> 'pending')
EXECUTE FUNCTION oao.wake_resolved_approval_deadlines();

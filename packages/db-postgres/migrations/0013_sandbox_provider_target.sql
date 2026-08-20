ALTER TABLE oao.sandbox_instances
  ADD COLUMN provider_target text;

COMMENT ON COLUMN oao.sandbox_instances.target_preference IS
  'Requested provider placement preference; immutable for sandbox idempotency.';

COMMENT ON COLUMN oao.sandbox_instances.provider_target IS
  'Effective provider placement reported after successful sandbox creation.';

-- The configured IAP project anchors authentication and cannot participate in
-- the ordinary hard-delete lifecycle. Raise a deliberate validation error
-- before the project row reaches its default-tenant foreign key.
CREATE FUNCTION oao.protect_iap_default_project_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, oao
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM oao.iap_default_tenant defaults
    WHERE defaults.organization_id=OLD.organization_id
      AND defaults.project_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'The IAP default project cannot be deleted because it anchors console authentication'
      USING ERRCODE='22023';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER protect_iap_default_project_delete
BEFORE DELETE ON oao.projects
FOR EACH ROW EXECUTE FUNCTION oao.protect_iap_default_project_delete();

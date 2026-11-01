-- Frees the key of a removed MCP connection. Removal revokes a server, its
-- toolsets, and the policies and credentials only it used, but keeps the
-- rows: versions are immutable and history refers to them. Their keys stayed
-- unique, so adding the connection again failed with a conflict.
--
-- Like an archived agent, a revoked server, credential, policy, or toolset
-- now carries revoked_at, and keys are unique only among rows without it.

ALTER TABLE oao.mcp_servers ADD COLUMN revoked_at timestamptz;
ALTER TABLE oao.mcp_credentials ADD COLUMN revoked_at timestamptz;
ALTER TABLE oao.mcp_credential_policies ADD COLUMN revoked_at timestamptz;
ALTER TABLE oao.mcp_toolsets ADD COLUMN revoked_at timestamptz;

-- Rows already revoked are marked from their lifecycle. As in 0054, the
-- migration role is not exempt from row-level security, so forced row-level
-- security is lifted inside this transaction only.
ALTER TABLE oao.mcp_servers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_server_version_lifecycle NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_version_lifecycle NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_policies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_policy_version_lifecycle NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_toolsets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_toolset_version_lifecycle NO FORCE ROW LEVEL SECURITY;

UPDATE oao.mcp_servers resource
   SET revoked_at = lifecycle.updated_at
  FROM oao.mcp_server_version_lifecycle lifecycle
 WHERE lifecycle.organization_id = resource.organization_id
   AND lifecycle.server_version_id = resource.latest_version_id
   AND lifecycle.status = 'revoked';

UPDATE oao.mcp_credentials resource
   SET revoked_at = lifecycle.updated_at
  FROM oao.mcp_credential_version_lifecycle lifecycle
 WHERE lifecycle.organization_id = resource.organization_id
   AND lifecycle.credential_version_id = resource.active_version_id
   AND lifecycle.status = 'revoked';

UPDATE oao.mcp_credential_policies resource
   SET revoked_at = lifecycle.updated_at
  FROM oao.mcp_credential_policy_version_lifecycle lifecycle
 WHERE lifecycle.organization_id = resource.organization_id
   AND lifecycle.policy_version_id = resource.latest_version_id
   AND lifecycle.status = 'revoked';

UPDATE oao.mcp_toolsets resource
   SET revoked_at = lifecycle.updated_at
  FROM oao.mcp_toolset_version_lifecycle lifecycle
 WHERE lifecycle.organization_id = resource.organization_id
   AND lifecycle.project_id = resource.project_id
   AND lifecycle.toolset_version_id = resource.latest_version_id
   AND lifecycle.status = 'revoked';

ALTER TABLE oao.mcp_servers FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_server_version_lifecycle FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_version_lifecycle FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_policy_version_lifecycle FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_toolsets FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_toolset_version_lifecycle FORCE ROW LEVEL SECURITY;

ALTER TABLE oao.mcp_servers
  DROP CONSTRAINT mcp_servers_organization_id_server_key_key;
ALTER TABLE oao.mcp_credentials
  DROP CONSTRAINT mcp_credentials_organization_id_credential_key_key;
ALTER TABLE oao.mcp_credential_policies
  DROP CONSTRAINT mcp_credential_policies_organization_id_policy_key_key;
ALTER TABLE oao.mcp_toolsets
  DROP CONSTRAINT mcp_toolsets_organization_id_project_id_toolset_key_key;

CREATE UNIQUE INDEX mcp_servers_live_key_idx
  ON oao.mcp_servers (organization_id, server_key)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX mcp_credentials_live_key_idx
  ON oao.mcp_credentials (organization_id, credential_key)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX mcp_credential_policies_live_key_idx
  ON oao.mcp_credential_policies (organization_id, policy_key)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX mcp_toolsets_live_key_idx
  ON oao.mcp_toolsets (organization_id, project_id, toolset_key)
  WHERE revoked_at IS NULL;

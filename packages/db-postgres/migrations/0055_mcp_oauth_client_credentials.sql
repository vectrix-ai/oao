-- Adds the oauth_client_credentials MCP credential kind: the MCP Client
-- Credentials extension (io.modelcontextprotocol/oauth-client-credentials).
--
-- The authorization configuration an operator confirmed from discovery is
-- pinned on the immutable credential version next to the encrypted client
-- secret, so rotation always changes configuration and secret together and
-- the secret is bound to the issuer that registered it. The version's
-- destination is the pinned resource.
--
-- Each version now repeats its credential's kind. A composite foreign key
-- keeps the two equal, so a CHECK on the version can require the OAuth
-- columns exactly when the kind uses them.

ALTER TABLE oao.mcp_credentials
  DROP CONSTRAINT mcp_credentials_credential_kind_check,
  DROP CONSTRAINT mcp_credentials_check,
  ADD CONSTRAINT mcp_credentials_credential_kind_check CHECK (
    credential_kind IN ('static_bearer','api_key_header','oauth_client_credentials')
  ),
  ADD CONSTRAINT mcp_credentials_header_name_check CHECK (
    (credential_kind IN ('static_bearer','oauth_client_credentials') AND header_name IS NULL)
    OR
    (credential_kind='api_key_header' AND header_name IS NOT NULL
      AND length(header_name) BETWEEN 1 AND 64
      AND header_name ~ '^[a-zA-Z0-9!#$%&''*+.^_`|~-]+$'
      AND lower(header_name) NOT IN (
        'connection','content-length','cookie','host','proxy-authorization',
        'set-cookie','te','trailer','transfer-encoding','upgrade'
      ))
  ),
  ADD CONSTRAINT mcp_credentials_kind_key UNIQUE (organization_id, id, credential_kind);

ALTER TABLE oao.mcp_credential_versions
  ADD COLUMN credential_kind text,
  ADD COLUMN oauth_issuer text,
  ADD COLUMN oauth_token_endpoint text,
  ADD COLUMN oauth_client_id text,
  ADD COLUMN oauth_token_endpoint_auth_method text,
  ADD COLUMN oauth_scope text,
  ADD COLUMN oauth_resource text,
  ADD COLUMN oauth_resource_metadata_url text,
  ADD COLUMN oauth_send_resource boolean;

-- Existing versions take their credential's kind. As in 0054, the migration
-- role is not exempt from row-level security, so forced row-level security
-- is lifted inside this transaction only.
ALTER TABLE oao.mcp_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_versions DISABLE TRIGGER mcp_credential_versions_immutable;

UPDATE oao.mcp_credential_versions version
   SET credential_kind = credential.credential_kind
  FROM oao.mcp_credentials credential
 WHERE version.organization_id = credential.organization_id
   AND version.credential_id = credential.id;

ALTER TABLE oao.mcp_credential_versions ENABLE TRIGGER mcp_credential_versions_immutable;
ALTER TABLE oao.mcp_credential_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credentials FORCE ROW LEVEL SECURITY;

ALTER TABLE oao.mcp_credential_versions
  ALTER COLUMN credential_kind SET NOT NULL,
  ADD CONSTRAINT mcp_credential_versions_kind_fkey
    FOREIGN KEY (organization_id, credential_id, credential_kind)
    REFERENCES oao.mcp_credentials (organization_id, id, credential_kind),
  ADD CONSTRAINT mcp_credential_versions_oauth_check CHECK (
    (
      credential_kind <> 'oauth_client_credentials'
      AND oauth_issuer IS NULL
      AND oauth_token_endpoint IS NULL
      AND oauth_client_id IS NULL
      AND oauth_token_endpoint_auth_method IS NULL
      AND oauth_scope IS NULL
      AND oauth_resource IS NULL
      AND oauth_resource_metadata_url IS NULL
      AND oauth_send_resource IS NULL
    )
    OR (
      credential_kind = 'oauth_client_credentials'
      AND destination_origin IS NOT NULL
      AND length(oauth_issuer) BETWEEN 9 AND 2048
      AND oauth_issuer ~ '^https://[^#[:space:]]+$'
      AND length(oauth_token_endpoint) BETWEEN 9 AND 2048
      AND oauth_token_endpoint ~ '^https://[^#[:space:]]+$'
      AND length(oauth_client_id) BETWEEN 1 AND 512
      AND oauth_client_id ~ '^[ -~]+$'
      AND oauth_token_endpoint_auth_method IN ('client_secret_post','client_secret_basic')
      AND length(oauth_scope) BETWEEN 1 AND 1024
      -- RFC 6749 scope tokens: printable ASCII except '"' and '\'.
      AND oauth_scope ~ '^[!-~]+( [!-~]+)*$'
      AND strpos(oauth_scope, '"') = 0
      AND strpos(oauth_scope, chr(92)) = 0
      AND length(oauth_resource) BETWEEN 9 AND 2048
      AND oauth_resource ~ '^https://[^#[:space:]]+$'
      AND length(oauth_resource_metadata_url) BETWEEN 9 AND 2048
      AND oauth_resource_metadata_url ~ '^https://[^#[:space:]]+$'
      AND oauth_send_resource IS NOT NULL
    )
  );

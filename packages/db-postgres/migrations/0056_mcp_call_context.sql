-- Lets a credential policy version forward OAO call identity to the MCP
-- server it approves. When forward_call_context is true, the egress broker
-- sets X-OAO-Organization-Id and X-OAO-Project-Id on every request, and
-- X-OAO-Session-Id, X-OAO-Run-Id, X-OAO-Tool-Call-Id, and
-- X-OAO-Run-Key-Sha256 on the requests of a run's tool call. Existing policy
-- versions keep sending nothing: the constant default rewrites no row, so the
-- version immutability trigger does not fire.
ALTER TABLE oao.mcp_credential_policy_versions
  ADD COLUMN forward_call_context boolean NOT NULL DEFAULT false;

-- The broker strips every inbound x-oao-* header and sets the call context
-- itself, so no credential may use that header namespace. NOT VALID keeps an
-- existing credential from blocking the upgrade; the broker refuses to send
-- such a header name either way.
ALTER TABLE oao.mcp_credentials
  ADD CONSTRAINT mcp_credentials_header_name_not_call_context CHECK (
    header_name IS NULL OR lower(header_name) NOT LIKE 'x-oao-%'
  ) NOT VALID;

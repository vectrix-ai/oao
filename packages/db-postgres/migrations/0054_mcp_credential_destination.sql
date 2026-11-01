-- Binds every MCP credential version to the one destination its secret may be
-- sent to. Before this migration any principal allowed to write credential
-- policies could point an organization-shared credential at an arbitrary
-- origin and receive the secret through discovery.
--
-- A destination is a canonical HTTPS origin plus a path prefix. A credential
-- policy may use a credential only when the policy's exact origin equals the
-- destination origin and its path prefix lies inside the destination path
-- prefix on a path-segment boundary.
--
-- Existing versions are backfilled from the policies that already use them:
-- a credential whose policies share one origin is pinned to that origin, with
-- the policies' path prefix when they all use the same one and "/" otherwise.
-- Policy prefixes used to match as plain string prefixes, so "/mcp" also
-- admitted an endpoint at "/mcpx". When a server endpoint relies on that, or a
-- legacy SSE server may advertise a sibling message path, the destination is
-- the prefix's parent ("/mcp" becomes "/"). Every existing policy and every
-- endpoint it served therefore stays inside the pinned destination. A
-- credential without policies, with policies on more than one origin, or
-- with a policy origin or prefix that is not canonical keeps a NULL
-- destination: its existing policies keep working, no new policy can use it,
-- and rotating it with a destination pins it.

-- The form an HTTPS origin is compared in: lowercase, without a trailing
-- slash or the default port, as the URL origin a credential stores.
CREATE FUNCTION oao.mcp_canonical_origin(p_origin text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(lower(regexp_replace(p_origin, '/$', '')), ':443$', '')
$$;

ALTER TABLE oao.mcp_credential_versions
  ADD COLUMN destination_origin text,
  ADD COLUMN destination_path_prefix text,
  ADD CONSTRAINT mcp_credential_versions_destination_check CHECK (
    (destination_origin IS NULL AND destination_path_prefix IS NULL)
    OR (
      length(destination_origin) BETWEEN 9 AND 512
      AND destination_origin ~ '^https://[^/?#@[:space:]]+$'
      AND destination_origin = oao.mcp_canonical_origin(destination_origin)
      AND length(destination_path_prefix) BETWEEN 1 AND 1024
      AND destination_path_prefix ~ '^/[^?#]*$'
    )
  );

-- True when p_path equals p_prefix or continues it after a "/" boundary, so
-- "/mcp" contains "/mcp" and "/mcp/v2" but not "/mcpx".
CREATE FUNCTION oao.mcp_path_within(p_path text, p_prefix text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT p_path = p_prefix
      OR (
        left(p_path, length(p_prefix)) = p_prefix
        AND (
          right(p_prefix, 1) = '/'
          OR substr(p_path, length(p_prefix) + 1, 1) = '/'
        )
      )
$$;

-- True when a policy's exact origin and path prefix lie inside a pinned
-- credential destination. A NULL destination yields NULL, which callers treat
-- as outside.
CREATE FUNCTION oao.mcp_policy_within_destination(
  p_exact_origin text,
  p_path_prefix text,
  p_destination_origin text,
  p_destination_path_prefix text
) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT oao.mcp_canonical_origin(p_exact_origin) = p_destination_origin
     AND oao.mcp_path_within(p_path_prefix, p_destination_path_prefix)
$$;

REVOKE ALL ON FUNCTION oao.mcp_canonical_origin(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.mcp_path_within(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.mcp_policy_within_destination(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.mcp_canonical_origin(text) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.mcp_path_within(text,text) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.mcp_policy_within_destination(text,text,text,text) TO oao_app;

-- The backfill crosses organizations. The migration role owns these tables
-- but is not exempt from row-level security, so forced row-level security is
-- lifted inside this transaction only, and the immutability trigger is
-- suspended for the one-time column fill.
ALTER TABLE oao.mcp_credential_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_policy_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_server_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_versions DISABLE TRIGGER mcp_credential_versions_immutable;

WITH policies AS (
  SELECT policy.organization_id,
         policy.credential_id,
         oao.mcp_canonical_origin(policy.exact_origin) AS origin,
         policy.path_prefix,
         -- A server this policy served only through the old string-prefix
         -- match, or one that may send requests to another path.
         EXISTS (
           SELECT 1
             FROM oao.mcp_server_versions server
            WHERE server.organization_id = policy.organization_id
              AND oao.mcp_endpoint_matches_policy(
                server.endpoint_url, policy.exact_origin, policy.path_prefix
              )
              AND (
                server.transport = 'legacy_sse'
                OR NOT oao.mcp_path_within(
                  COALESCE(substring(server.endpoint_url from '^https://[^/]+(/[^?#]*)'), '/'),
                  policy.path_prefix
                )
              )
         ) AS widened
    FROM oao.mcp_credential_policy_versions policy
),
destinations AS (
  SELECT organization_id,
         credential_id,
         min(origin) AS origin,
         CASE WHEN count(DISTINCT path_prefix) > 1 THEN '/'
              WHEN bool_or(widened) THEN regexp_replace(min(path_prefix), '[^/]*$', '')
              ELSE min(path_prefix)
         END AS path_prefix
    FROM policies
   GROUP BY organization_id, credential_id
  HAVING count(DISTINCT origin) = 1
)
UPDATE oao.mcp_credential_versions version
   SET destination_origin = destinations.origin,
       destination_path_prefix = destinations.path_prefix
  FROM destinations
 WHERE version.organization_id = destinations.organization_id
   AND version.credential_id = destinations.credential_id
   AND destinations.origin ~ '^https://[^/?#@[:space:]]+$'
   AND destinations.path_prefix ~ '^/[^?#]*$';

ALTER TABLE oao.mcp_credential_versions ENABLE TRIGGER mcp_credential_versions_immutable;
ALTER TABLE oao.mcp_credential_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_credential_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE oao.mcp_server_versions FORCE ROW LEVEL SECURITY;

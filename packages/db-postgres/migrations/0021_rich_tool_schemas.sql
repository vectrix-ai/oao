-- Expand schemaVersion 1 in place for the pre-release MVP. Agent versions stay
-- immutable; newly published versions may use the documented rich tool-schema
-- subset while historical narrow schemas remain valid.

CREATE FUNCTION oao.tool_schema_primitive_matches_type(p_value jsonb, p_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_type
    WHEN 'string' THEN jsonb_typeof(p_value) = 'string'
    WHEN 'number' THEN jsonb_typeof(p_value) = 'number'
      AND abs((p_value #>> '{}')::numeric) <= 1.7976931348623157e308
    WHEN 'integer' THEN jsonb_typeof(p_value) = 'number'
      AND (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
      AND abs((p_value #>> '{}')::numeric) <= 9007199254740991
    WHEN 'boolean' THEN jsonb_typeof(p_value) = 'boolean'
    WHEN 'null' THEN jsonb_typeof(p_value) = 'null'
    ELSE false
  END
$$;

CREATE FUNCTION oao.is_valid_published_json_schema_node(p_schema jsonb, p_depth integer)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  schema_type text;
  nullable boolean := false;
  property_entry record;
  enum_entry jsonb;
  required_count integer;
  distinct_required_count integer;
  lower_bound numeric;
  upper_bound numeric;
BEGIN
  IF p_depth > 12 OR jsonb_typeof(p_schema) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_schema->'type') = 'string' THEN
    schema_type := p_schema->>'type';
    IF schema_type NOT IN ('string','number','integer','boolean','null','array','object') THEN
      RETURN false;
    END IF;
  ELSIF jsonb_typeof(p_schema->'type') = 'array' THEN
    nullable := true;
    IF jsonb_array_length(p_schema->'type') <> 2
       OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_schema->'type')) <> 2
       OR NOT (p_schema->'type') @> '["null"]'::jsonb
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_schema->'type') value
         WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
       ) THEN
      RETURN false;
    END IF;
    SELECT value #>> '{}' INTO schema_type
    FROM jsonb_array_elements(p_schema->'type') value
    WHERE value <> '"null"'::jsonb;
    IF schema_type IS NULL
       OR schema_type = 'null'
       OR schema_type NOT IN ('string','number','integer','boolean','array','object') THEN
      RETURN false;
    END IF;
  ELSIF p_schema ? 'type' THEN
    RETURN false;
  ELSIF NOT p_schema ? 'enum' AND NOT p_schema ? 'const' THEN
    RETURN false;
  END IF;

  IF p_schema ? 'title' AND (
    jsonb_typeof(p_schema->'title') IS DISTINCT FROM 'string'
    OR length(p_schema->>'title') NOT BETWEEN 1 AND 200
  ) THEN RETURN false; END IF;
  IF p_schema ? 'description' AND (
    jsonb_typeof(p_schema->'description') IS DISTINCT FROM 'string'
    OR length(p_schema->>'description') NOT BETWEEN 1 AND 2000
  ) THEN RETURN false; END IF;
  IF p_schema ? 'examples' AND (
    jsonb_typeof(p_schema->'examples') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_schema->'examples') > 8
  ) THEN RETURN false; END IF;

  IF p_schema ? 'enum' THEN
    IF jsonb_typeof(p_schema->'enum') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_schema->'enum') NOT BETWEEN 1 AND 100
       OR (SELECT count(*) FROM jsonb_array_elements(p_schema->'enum')) <>
          (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_schema->'enum')) THEN
      RETURN false;
    END IF;
    FOR enum_entry IN SELECT value FROM jsonb_array_elements(p_schema->'enum') LOOP
      IF jsonb_typeof(enum_entry) NOT IN ('null','string','number','boolean')
         OR (schema_type IS NOT NULL
             AND NOT (nullable AND jsonb_typeof(enum_entry) = 'null')
             AND NOT oao.tool_schema_primitive_matches_type(enum_entry, schema_type)) THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  IF p_schema ? 'const' THEN
    IF jsonb_typeof(p_schema->'const') NOT IN ('null','string','number','boolean')
       OR (schema_type IS NOT NULL
           AND NOT (nullable AND jsonb_typeof(p_schema->'const') = 'null')
           AND NOT oao.tool_schema_primitive_matches_type(p_schema->'const', schema_type)) THEN
      RETURN false;
    END IF;
  END IF;
  IF p_schema ? 'enum' AND p_schema ? 'const' THEN RETURN false; END IF;
  IF (p_schema ? 'enum' OR p_schema ? 'const')
     AND (p_schema - ARRAY['type','enum','const','title','description','examples']) <> '{}'::jsonb THEN
    RETURN false;
  END IF;

  IF schema_type IS NULL THEN
    RETURN (p_schema - ARRAY['enum','const','title','description','examples']) = '{}'::jsonb;
  END IF;

  IF schema_type = 'string' THEN
    IF (p_schema - ARRAY['type','enum','const','title','description','examples','minLength','maxLength','format']) <> '{}'::jsonb
       OR (p_schema ? 'minLength' AND (
         jsonb_typeof(p_schema->'minLength') IS DISTINCT FROM 'number'
         OR (p_schema->>'minLength') !~ '^[0-9]+$'
       ))
       OR (p_schema ? 'maxLength' AND (
         jsonb_typeof(p_schema->'maxLength') IS DISTINCT FROM 'number'
         OR (p_schema->>'maxLength') !~ '^[0-9]+$'
       ))
       OR (p_schema ? 'minLength' AND p_schema ? 'maxLength'
           AND (p_schema->>'minLength')::numeric > (p_schema->>'maxLength')::numeric)
       OR (p_schema ? 'format' AND (
         jsonb_typeof(p_schema->'format') IS DISTINCT FROM 'string'
         OR p_schema->>'format' NOT IN ('date','date-time','email','time','uri','uuid')
       )) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF schema_type IN ('number','integer') THEN
    IF (p_schema - ARRAY['type','enum','const','title','description','examples','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf']) <> '{}'::jsonb THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_each(p_schema) entry
      WHERE entry.key IN ('minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf')
        AND (
          jsonb_typeof(entry.value) IS DISTINCT FROM 'number'
          OR abs((entry.value #>> '{}')::numeric) > 1.7976931348623157e308
        )
    ) OR (p_schema ? 'multipleOf' AND (p_schema->>'multipleOf')::numeric <= 0)
      OR (p_schema ? 'minimum' AND p_schema ? 'exclusiveMinimum')
      OR (p_schema ? 'maximum' AND p_schema ? 'exclusiveMaximum') THEN
      RETURN false;
    END IF;
    lower_bound := CASE
      WHEN p_schema ? 'minimum' THEN (p_schema->>'minimum')::numeric
      WHEN p_schema ? 'exclusiveMinimum' THEN (p_schema->>'exclusiveMinimum')::numeric
      ELSE NULL
    END;
    upper_bound := CASE
      WHEN p_schema ? 'maximum' THEN (p_schema->>'maximum')::numeric
      WHEN p_schema ? 'exclusiveMaximum' THEN (p_schema->>'exclusiveMaximum')::numeric
      ELSE NULL
    END;
    RETURN lower_bound IS NULL OR upper_bound IS NULL OR lower_bound <= upper_bound;
  END IF;

  IF schema_type IN ('boolean','null') THEN
    RETURN (p_schema - ARRAY['type','enum','const','title','description','examples']) = '{}'::jsonb;
  END IF;

  IF schema_type = 'array' THEN
    IF (p_schema - ARRAY['type','enum','const','title','description','examples','items','minItems','maxItems']) <> '{}'::jsonb
       OR NOT p_schema ? 'items'
       OR NOT oao.is_valid_published_json_schema_node(p_schema->'items', p_depth + 1)
       OR (p_schema ? 'minItems' AND (
         jsonb_typeof(p_schema->'minItems') IS DISTINCT FROM 'number'
         OR (p_schema->>'minItems') !~ '^[0-9]+$'
       ))
       OR (p_schema ? 'maxItems' AND (
         jsonb_typeof(p_schema->'maxItems') IS DISTINCT FROM 'number'
         OR (p_schema->>'maxItems') !~ '^[0-9]+$'
       ))
       OR (p_schema ? 'minItems' AND p_schema ? 'maxItems'
           AND (p_schema->>'minItems')::numeric > (p_schema->>'maxItems')::numeric) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF (p_schema - ARRAY['type','enum','const','title','description','examples','properties','required','additionalProperties']) <> '{}'::jsonb
     OR (p_schema ? 'properties' AND jsonb_typeof(p_schema->'properties') IS DISTINCT FROM 'object')
     OR (p_schema ? 'required' AND jsonb_typeof(p_schema->'required') IS DISTINCT FROM 'array')
     OR (p_schema ? 'additionalProperties' AND jsonb_typeof(p_schema->'additionalProperties') NOT IN ('boolean','object')) THEN
    RETURN false;
  END IF;
  IF p_schema ? 'required' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_schema->'required') value
      WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
    ) THEN RETURN false; END IF;
    SELECT count(*), count(DISTINCT value)
      INTO required_count, distinct_required_count
    FROM jsonb_array_elements_text(p_schema->'required');
    IF required_count <> distinct_required_count
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(p_schema->'required') name
         WHERE NOT COALESCE(p_schema->'properties', '{}'::jsonb) ? name
       ) THEN
      RETURN false;
    END IF;
  END IF;
  FOR property_entry IN
    SELECT key, value FROM jsonb_each(COALESCE(p_schema->'properties', '{}'::jsonb))
  LOOP
    IF property_entry.key IN ('__proto__','constructor','prototype')
       OR length(property_entry.key) NOT BETWEEN 1 AND 200
       OR NOT oao.is_valid_published_json_schema_node(property_entry.value, p_depth + 1) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF jsonb_typeof(p_schema->'additionalProperties') = 'object'
     AND NOT oao.is_valid_published_json_schema_node(p_schema->'additionalProperties', p_depth + 1) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION oao.is_valid_published_json_schema(p_schema jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  node_count integer;
  maximum_depth integer;
  property_count integer;
BEGIN
  IF octet_length(p_schema::text) > 65536 THEN RETURN false; END IF;
  WITH RECURSIVE schema_nodes(schema, depth) AS (
    SELECT p_schema, 0
    UNION ALL
    SELECT children.schema, parent.depth + 1
    FROM schema_nodes parent
    CROSS JOIN LATERAL (
      SELECT value AS schema
      FROM jsonb_each(CASE
        WHEN jsonb_typeof(parent.schema->'properties') = 'object'
          THEN parent.schema->'properties'
        ELSE '{}'::jsonb
      END)
      UNION ALL
      SELECT parent.schema->'items' WHERE jsonb_typeof(parent.schema->'items') = 'object'
      UNION ALL
      SELECT parent.schema->'additionalProperties'
      WHERE jsonb_typeof(parent.schema->'additionalProperties') = 'object'
    ) children
    WHERE parent.depth < 13
  )
  SELECT count(*), max(depth), sum(CASE
    WHEN jsonb_typeof(schema->'properties') = 'object'
      THEN (SELECT count(*) FROM jsonb_object_keys(schema->'properties'))
    ELSE 0
  END)
  INTO node_count, maximum_depth, property_count
  FROM schema_nodes;
  RETURN node_count <= 512
    AND maximum_depth <= 12
    AND property_count <= 256
    AND oao.is_valid_published_json_schema_node(p_schema, 0);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION oao.tool_schema_primitive_matches_type(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.is_valid_published_json_schema_node(jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION oao.is_valid_published_json_schema(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oao.tool_schema_primitive_matches_type(jsonb, text) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.is_valid_published_json_schema_node(jsonb, integer) TO oao_app;
GRANT EXECUTE ON FUNCTION oao.is_valid_published_json_schema(jsonb) TO oao_app;

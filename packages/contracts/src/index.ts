import * as v from "valibot";

const IdSchema = v.pipe(v.string(), v.uuid());
const TimestampSchema = v.pipe(v.string(), v.isoTimestamp());
const JsonObjectSchema = v.record(v.string(), v.unknown());

export const PublicPrincipalSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  kind: v.picklist(["human", "api_key", "service"]),
  subject: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  displayName: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  scopes: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
});

export const AuthLogoutResultSchema = v.object({
  redirectUrl: v.optional(v.pipe(v.string(), v.url())),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export const TOOL_SCHEMA_LIMITS = Object.freeze({
  maximumBytes: 65_536,
  maximumDepth: 12,
  maximumNodes: 512,
  maximumProperties: 256,
  maximumDescriptionLength: 2_000,
  maximumTitleLength: 200,
  maximumExamples: 8,
} as const);

export const TOOL_RETRY_POLICY = Object.freeze({
  maximumRetries: 2,
  maximumAttempts: 3,
} as const);

export const RETRYABLE_TOOL_FAILURE_CODES = Object.freeze([
  "tool_expired",
  "tool_failed",
  "platform_tool_failed",
  "invalid_tool_arguments",
  "invalid_tool_result",
] as const);

const TOOL_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "array",
  "object",
]);
const TOOL_SCHEMA_FORMATS = new Set([
  "date",
  "date-time",
  "email",
  "time",
  "uri",
  "uuid",
]);
const PROHIBITED_PROPERTY_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const ANNOTATION_KEYS = ["title", "description", "examples"] as const;
const ENUM_KEYS = ["enum", "const"] as const;

export interface ToolSchemaIssue {
  readonly path: string;
  readonly message: string;
}

export interface ToolSchemaValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ToolSchemaIssue[];
}

function toolSchemaType(value: Record<string, unknown>): string | undefined {
  if (typeof value.type === "string") return value.type;
  if (
    Array.isArray(value.type) &&
    value.type.length === 2 &&
    value.type.includes("null")
  ) {
    const nonNull = value.type.find((entry) => entry !== "null");
    return typeof nonNull === "string" ? nonNull : undefined;
  }
  return undefined;
}

function isJsonPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > TOOL_SCHEMA_LIMITS.maximumDepth) return false;
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value))
    return value.every((entry) => isJsonValue(entry, depth + 1));
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([key, nested]) =>
        !PROHIBITED_PROPERTY_NAMES.has(key) && isJsonValue(nested, depth + 1),
    )
  );
}

function primitiveMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function validateToolJsonSchema(
  input: unknown,
  options: { readonly requireObjectRoot?: boolean } = {},
): ToolSchemaValidationResult {
  const issues: ToolSchemaIssue[] = [];
  let nodes = 0;
  let properties = 0;
  const issue = (path: string, message: string): void => {
    if (issues.length < 32) issues.push({ path, message });
  };

  let bytes = Number.POSITIVE_INFINITY;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    // The structural validation below reports the actionable error.
  }
  if (bytes > TOOL_SCHEMA_LIMITS.maximumBytes)
    issue("$", `schema exceeds ${TOOL_SCHEMA_LIMITS.maximumBytes} UTF-8 bytes`);

  const visit = (schema: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > TOOL_SCHEMA_LIMITS.maximumNodes) {
      issue("$", `schema exceeds ${TOOL_SCHEMA_LIMITS.maximumNodes} nodes`);
      return;
    }
    if (depth > TOOL_SCHEMA_LIMITS.maximumDepth) {
      issue(path, `schema exceeds depth ${TOOL_SCHEMA_LIMITS.maximumDepth}`);
      return;
    }
    if (!isPlainRecord(schema)) {
      issue(path, "schema must be a JSON object");
      return;
    }

    const typeValue = schema.type;
    const nullable = Array.isArray(typeValue);
    const type = toolSchemaType(schema);
    if (nullable) {
      if (
        typeValue.length !== 2 ||
        new Set(typeValue).size !== 2 ||
        !typeValue.includes("null") ||
        !type ||
        type === "null" ||
        !TOOL_SCHEMA_TYPES.has(type)
      )
        issue(
          `${path}.type`,
          'nullable type must contain exactly one supported type and "null"',
        );
    } else if (
      schema.type !== undefined &&
      (typeof schema.type !== "string" || !TOOL_SCHEMA_TYPES.has(schema.type))
    ) {
      issue(`${path}.type`, "type is not supported");
    }
    if (!type && schema.enum === undefined && schema.const === undefined)
      issue(path, "schema requires type, enum, or const");

    if (
      schema.title !== undefined &&
      (typeof schema.title !== "string" ||
        schema.title.length === 0 ||
        schema.title.length > TOOL_SCHEMA_LIMITS.maximumTitleLength)
    )
      issue(
        `${path}.title`,
        `title must contain 1-${TOOL_SCHEMA_LIMITS.maximumTitleLength} characters`,
      );
    if (
      schema.description !== undefined &&
      (typeof schema.description !== "string" ||
        schema.description.length === 0 ||
        schema.description.length > TOOL_SCHEMA_LIMITS.maximumDescriptionLength)
    )
      issue(
        `${path}.description`,
        `description must contain 1-${TOOL_SCHEMA_LIMITS.maximumDescriptionLength} characters`,
      );
    if (
      schema.examples !== undefined &&
      (!Array.isArray(schema.examples) ||
        schema.examples.length > TOOL_SCHEMA_LIMITS.maximumExamples ||
        !schema.examples.every((example) => isJsonValue(example)))
    )
      issue(
        `${path}.examples`,
        `examples must be an array of at most ${TOOL_SCHEMA_LIMITS.maximumExamples} JSON values`,
      );

    if (schema.enum !== undefined) {
      if (
        !Array.isArray(schema.enum) ||
        schema.enum.length === 0 ||
        schema.enum.length > 100 ||
        !schema.enum.every(isJsonPrimitive)
      ) {
        issue(
          `${path}.enum`,
          "enum must contain 1-100 finite primitive JSON values",
        );
      } else {
        if (
          new Set(schema.enum.map((entry) => JSON.stringify(entry))).size !==
          schema.enum.length
        )
          issue(`${path}.enum`, "enum values must be unique");
        if (
          type &&
          schema.enum.some(
            (entry) =>
              !(nullable && entry === null) &&
              !primitiveMatchesType(entry, type),
          )
        )
          issue(`${path}.enum`, "enum values must match the declared type");
      }
    }
    if (schema.const !== undefined) {
      if (!isJsonPrimitive(schema.const))
        issue(`${path}.const`, "const must be a finite primitive JSON value");
      else if (
        type &&
        !(nullable && schema.const === null) &&
        !primitiveMatchesType(schema.const, type)
      )
        issue(`${path}.const`, "const must match the declared type");
    }
    if (schema.enum !== undefined && schema.const !== undefined)
      issue(path, "enum and const cannot be combined");

    const common = ["type", ...ANNOTATION_KEYS, ...ENUM_KEYS];
    if (
      (schema.enum !== undefined || schema.const !== undefined) &&
      Object.keys(schema).some((key) => !common.includes(key))
    )
      issue(path, "enum and const cannot be combined with other constraints");
    let allowed = common;
    switch (type) {
      case "string": {
        allowed = [...common, "minLength", "maxLength", "format"];
        if (
          schema.minLength !== undefined &&
          !isNonNegativeInteger(schema.minLength)
        )
          issue(
            `${path}.minLength`,
            "minLength must be a non-negative integer",
          );
        if (
          schema.maxLength !== undefined &&
          !isNonNegativeInteger(schema.maxLength)
        )
          issue(
            `${path}.maxLength`,
            "maxLength must be a non-negative integer",
          );
        if (
          typeof schema.minLength === "number" &&
          typeof schema.maxLength === "number" &&
          schema.minLength > schema.maxLength
        )
          issue(path, "minLength cannot exceed maxLength");
        if (
          schema.format !== undefined &&
          (typeof schema.format !== "string" ||
            !TOOL_SCHEMA_FORMATS.has(schema.format))
        )
          issue(`${path}.format`, "format is not supported");
        break;
      }
      case "number":
      case "integer": {
        allowed = [
          ...common,
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "multipleOf",
        ];
        for (const key of [
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "multipleOf",
        ] as const) {
          if (
            schema[key] !== undefined &&
            (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
          )
            issue(`${path}.${key}`, `${key} must be a finite number`);
        }
        if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0)
          issue(`${path}.multipleOf`, "multipleOf must be greater than zero");
        if (
          schema.minimum !== undefined &&
          schema.exclusiveMinimum !== undefined
        )
          issue(path, "minimum and exclusiveMinimum cannot be combined");
        if (
          schema.maximum !== undefined &&
          schema.exclusiveMaximum !== undefined
        )
          issue(path, "maximum and exclusiveMaximum cannot be combined");
        const lower =
          typeof schema.minimum === "number"
            ? schema.minimum
            : schema.exclusiveMinimum;
        const upper =
          typeof schema.maximum === "number"
            ? schema.maximum
            : schema.exclusiveMaximum;
        if (
          typeof lower === "number" &&
          typeof upper === "number" &&
          lower > upper
        )
          issue(path, "numeric lower bound cannot exceed upper bound");
        break;
      }
      case "array":
        allowed = [...common, "items", "minItems", "maxItems"];
        if (schema.items === undefined)
          issue(`${path}.items`, "array schemas require items");
        else visit(schema.items, `${path}.items`, depth + 1);
        if (
          schema.minItems !== undefined &&
          !isNonNegativeInteger(schema.minItems)
        )
          issue(`${path}.minItems`, "minItems must be a non-negative integer");
        if (
          schema.maxItems !== undefined &&
          !isNonNegativeInteger(schema.maxItems)
        )
          issue(`${path}.maxItems`, "maxItems must be a non-negative integer");
        if (
          typeof schema.minItems === "number" &&
          typeof schema.maxItems === "number" &&
          schema.minItems > schema.maxItems
        )
          issue(path, "minItems cannot exceed maxItems");
        break;
      case "object": {
        allowed = [...common, "properties", "required", "additionalProperties"];
        const entries = schema.properties ?? {};
        if (!isPlainRecord(entries))
          issue(`${path}.properties`, "properties must be an object");
        else {
          properties += Object.keys(entries).length;
          if (properties > TOOL_SCHEMA_LIMITS.maximumProperties)
            issue(
              "$",
              `schema exceeds ${TOOL_SCHEMA_LIMITS.maximumProperties} properties`,
            );
          for (const [key, nested] of Object.entries(entries)) {
            if (PROHIBITED_PROPERTY_NAMES.has(key))
              issue(`${path}.properties.${key}`, "property name is prohibited");
            else if (key.length === 0 || key.length > 200)
              issue(
                `${path}.properties.${key}`,
                "property name must contain 1-200 characters",
              );
            visit(nested, `${path}.properties.${key}`, depth + 1);
          }
        }
        const required = schema.required ?? [];
        if (
          !Array.isArray(required) ||
          required.some((key) => typeof key !== "string")
        )
          issue(
            `${path}.required`,
            "required must be an array of property names",
          );
        else {
          if (new Set(required).size !== required.length)
            issue(`${path}.required`, "required property names must be unique");
          if (
            isPlainRecord(entries) &&
            required.some((key) => !(key in entries))
          )
            issue(
              `${path}.required`,
              "required names must exist in properties",
            );
        }
        const additional = schema.additionalProperties ?? true;
        if (typeof additional !== "boolean" && !isPlainRecord(additional))
          issue(
            `${path}.additionalProperties`,
            "additionalProperties must be boolean or a supported schema",
          );
        else if (isPlainRecord(additional))
          visit(additional, `${path}.additionalProperties`, depth + 1);
        break;
      }
      default:
        break;
    }
    if (!hasOnlyKeys(schema, allowed)) {
      const unknown = Object.keys(schema).filter(
        (key) => !allowed.includes(key),
      );
      issue(
        path,
        `unsupported keyword${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
      );
    }
  };

  visit(input, "$", 0);
  if (
    options.requireObjectRoot &&
    (!isPlainRecord(input) || toolSchemaType(input) !== "object")
  )
    issue("$.type", "tool root schema must have type object");
  return { valid: issues.length === 0, issues };
}

export function isSupportedToolJsonSchema(value: unknown): boolean {
  return validateToolJsonSchema(value).valid;
}

function appendValuePath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function jsonPrimitiveEqual(left: unknown, right: unknown): boolean {
  return left === right || (left === 0 && right === 0);
}

function matchesStringFormat(value: string, format: unknown): boolean {
  switch (format) {
    case "date":
      return v.safeParse(v.pipe(v.string(), v.isoDate()), value).success;
    case "date-time":
      return v.safeParse(v.pipe(v.string(), v.isoTimestamp()), value).success;
    case "email":
      return v.safeParse(v.pipe(v.string(), v.email()), value).success;
    case "time":
      return v.safeParse(v.pipe(v.string(), v.isoTime()), value).success;
    case "uri":
      return v.safeParse(v.pipe(v.string(), v.url()), value).success;
    case "uuid":
      return v.safeParse(v.pipe(v.string(), v.uuid()), value).success;
    default:
      return true;
  }
}

function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
  return Math.abs(quotient - Math.round(quotient)) <= tolerance;
}

/**
 * Validates one JSON value against OAO's published provider-neutral tool-schema
 * subset. This is deliberately validation-only: values are never coerced and
 * defaults are never applied.
 */
export function validateToolJsonValue(
  schemaInput: unknown,
  value: unknown,
): ToolSchemaValidationResult {
  const schemaValidation = validateToolJsonSchema(schemaInput);
  if (!schemaValidation.valid)
    return {
      valid: false,
      issues: [
        {
          path: "$",
          message: "published tool schema is invalid",
        },
      ],
    };

  const issues: ToolSchemaIssue[] = [];
  const issue = (path: string, message: string): void => {
    if (issues.length < 32) issues.push({ path, message });
  };
  if (!isJsonValue(value)) {
    issue("$", "value must be finite JSON without prohibited object keys");
    return { valid: false, issues };
  }

  const visit = (
    schema: Record<string, unknown>,
    nested: unknown,
    path: string,
  ): void => {
    const type = toolSchemaType(schema);
    const nullable = Array.isArray(schema.type) && schema.type.includes("null");

    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((entry) => jsonPrimitiveEqual(entry, nested))
    ) {
      issue(
        path,
        `value must be one of: ${schema.enum.map(String).join(", ")}`,
      );
      return;
    }
    if (
      schema.const !== undefined &&
      !jsonPrimitiveEqual(schema.const, nested)
    ) {
      issue(path, `value must equal ${JSON.stringify(schema.const)}`);
      return;
    }
    if (nested === null && nullable) return;
    if (!type) return;

    if (type === "string") {
      if (typeof nested !== "string") {
        issue(path, "value must be a string");
        return;
      }
      if (
        typeof schema.minLength === "number" &&
        nested.length < schema.minLength
      )
        issue(
          path,
          `string must contain at least ${schema.minLength} characters`,
        );
      if (
        typeof schema.maxLength === "number" &&
        nested.length > schema.maxLength
      )
        issue(
          path,
          `string must contain at most ${schema.maxLength} characters`,
        );
      if (!matchesStringFormat(nested, schema.format))
        issue(path, `string must match format ${String(schema.format)}`);
      return;
    }

    if (type === "number" || type === "integer") {
      if (
        typeof nested !== "number" ||
        !Number.isFinite(nested) ||
        (type === "integer" && !Number.isSafeInteger(nested))
      ) {
        issue(path, `value must be a finite ${type}`);
        return;
      }
      if (typeof schema.minimum === "number" && nested < schema.minimum)
        issue(path, `number must be at least ${schema.minimum}`);
      if (typeof schema.maximum === "number" && nested > schema.maximum)
        issue(path, `number must be at most ${schema.maximum}`);
      if (
        typeof schema.exclusiveMinimum === "number" &&
        nested <= schema.exclusiveMinimum
      )
        issue(path, `number must be greater than ${schema.exclusiveMinimum}`);
      if (
        typeof schema.exclusiveMaximum === "number" &&
        nested >= schema.exclusiveMaximum
      )
        issue(path, `number must be less than ${schema.exclusiveMaximum}`);
      if (
        typeof schema.multipleOf === "number" &&
        !isMultipleOf(nested, schema.multipleOf)
      )
        issue(path, `number must be a multiple of ${schema.multipleOf}`);
      return;
    }

    if (type === "boolean") {
      if (typeof nested !== "boolean") issue(path, "value must be a boolean");
      return;
    }
    if (type === "null") {
      if (nested !== null) issue(path, "value must be null");
      return;
    }
    if (type === "array") {
      if (!Array.isArray(nested)) {
        issue(path, "value must be an array");
        return;
      }
      if (
        typeof schema.minItems === "number" &&
        nested.length < schema.minItems
      )
        issue(path, `array must contain at least ${schema.minItems} items`);
      if (
        typeof schema.maxItems === "number" &&
        nested.length > schema.maxItems
      )
        issue(path, `array must contain at most ${schema.maxItems} items`);
      if (isPlainRecord(schema.items))
        nested.forEach((entry, index) =>
          visit(
            schema.items as Record<string, unknown>,
            entry,
            appendValuePath(path, index),
          ),
        );
      return;
    }

    if (!isPlainRecord(nested)) {
      issue(path, "value must be an object");
      return;
    }
    const properties = isPlainRecord(schema.properties)
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(nested, key))
        issue(appendValuePath(path, key), "required property is missing");
    }
    for (const [key, propertyValue] of Object.entries(nested)) {
      const propertySchema = properties[key];
      if (isPlainRecord(propertySchema)) {
        visit(propertySchema, propertyValue, appendValuePath(path, key));
        continue;
      }
      const additional = schema.additionalProperties ?? true;
      if (additional === false)
        issue(appendValuePath(path, key), "additional property is not allowed");
      else if (isPlainRecord(additional))
        visit(additional, propertyValue, appendValuePath(path, key));
    }
  };

  visit(schemaInput as Record<string, unknown>, value, "$");
  return { valid: issues.length === 0, issues };
}

function canonicalizeToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(schema).sort()) {
    const value = schema[key];
    if (key === "required" && Array.isArray(value)) {
      canonical[key] = [...value].sort();
    } else if (key === "properties" && isPlainRecord(value)) {
      canonical[key] = Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, nested]) => [
            name,
            canonicalizeToolSchema(nested as Record<string, unknown>),
          ]),
      );
    } else if (key === "items" && isPlainRecord(value)) {
      canonical[key] = canonicalizeToolSchema(value);
    } else if (key === "additionalProperties" && isPlainRecord(value)) {
      canonical[key] = canonicalizeToolSchema(value);
    } else {
      canonical[key] = value;
    }
  }
  return canonical;
}

const PublishedPropertySchema = v.pipe(
  JsonObjectSchema,
  v.check(
    (value: Record<string, unknown>) => isSupportedToolJsonSchema(value),
    "Tool JSON schema uses unsupported or ignored keywords",
  ),
);

const PublishedObjectSchema = v.pipe(
  v.strictObject({
    type: v.literal("object"),
    title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    description: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
    ),
    examples: v.optional(v.pipe(v.array(v.unknown()), v.maxLength(8))),
    properties: v.optional(v.record(v.string(), PublishedPropertySchema), {}),
    required: v.optional(v.array(v.string()), []),
    additionalProperties: v.optional(
      v.union([v.boolean(), PublishedPropertySchema]),
      true,
    ),
  }),
  v.check(
    (value) => validateToolJsonSchema(value, { requireObjectRoot: true }).valid,
    "Tool JSON schema must be a supported object schema",
  ),
  v.transform((value) => canonicalizeToolSchema(value) as typeof value),
);

export const OrganizationSchema = v.object({
  id: IdSchema,
  slug: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  createdAt: TimestampSchema,
});

export const ProjectSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  slug: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  createdAt: TimestampSchema,
});

export const CreateProjectInputSchema = v.strictObject({
  slug: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(80),
    v.regex(/^[a-z0-9][a-z0-9-]*$/u),
  ),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

export const ProjectMemberRoleSchema = v.picklist([
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const ProjectMemberSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  principalId: IdSchema,
  kind: v.picklist(["human", "api_key", "service"]),
  subject: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  displayName: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  email: v.optional(v.pipe(v.string(), v.email(), v.maxLength(320))),
  scopes: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
  role: ProjectMemberRoleSchema,
  createdAt: TimestampSchema,
});

export const CreateProjectMemberInputSchema = v.strictObject({
  subject: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  role: ProjectMemberRoleSchema,
  scopes: v.pipe(v.array(v.string()), v.minLength(1)),
});

export const UpdateProjectMemberInputSchema = v.strictObject({
  role: ProjectMemberRoleSchema,
});

export const AgentDefinitionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
  latestVersionId: v.nullable(IdSchema),
  createdAt: TimestampSchema,
});

export const AgentVersionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  agentDefinitionId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  config: JsonObjectSchema,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
});

export const SkillLifecycleStatusSchema = v.picklist([
  "active",
  "deprecated",
  "revoked",
]);

export const SkillSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  latestVersionId: v.nullable(IdSchema),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Set while the Skill is disabled; null (or absent) when it is enabled. */
  disabledAt: v.optional(v.nullable(TimestampSchema), null),
});

export const SkillVersionFileManifestSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  contentType: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export const SkillDraftEntrySchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
  kind: v.picklist(["directory", "file"]),
  contentType: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  sizeBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  sha256: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u))),
  dataBase64: v.optional(v.string()),
});

export const SkillDraftSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  skillId: v.nullable(IdSchema),
  sourceSkillVersionId: v.nullable(IdSchema),
  key: v.string(),
  displayName: v.string(),
  name: v.string(),
  description: v.string(),
  instructions: v.string(),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: v.picklist(["editing", "published", "discarded"]),
  publishedSkillVersionId: v.nullable(IdSchema),
  entries: v.array(SkillDraftEntrySchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const SkillVersionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  skillId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  instructions: v.pipe(v.string(), v.minLength(1), v.maxLength(200_000)),
  license: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  compatibility: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  metadata: v.record(v.string(), v.string()),
  allowedTools: v.nullable(v.pipe(v.string(), v.maxLength(2_000))),
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  totalBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: SkillLifecycleStatusSchema,
  files: v.optional(v.array(SkillVersionFileManifestSchema), []),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
});

export const ManagedSkillBindingSnapshotSchema = v.strictObject({
  skillId: IdSchema,
  skillVersionId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export const ThreadSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  title: v.optional(v.pipe(v.string(), v.maxLength(500))),
  createdAt: TimestampSchema,
});

export const SessionStatusSchema = v.picklist([
  "active",
  "idle",
  "closed",
  "errored",
]);
export const SessionSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  agentVersionId: IdSchema,
  status: SessionStatusSchema,
  inputTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  outputTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  cacheReadTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  cacheWriteTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: TimestampSchema,
  lastActivityAt: TimestampSchema,
});

export const RunStateSchema = v.picklist([
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const RunSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  sessionId: IdSchema,
  agentVersionId: IdSchema,
  createdByPrincipalId: IdSchema,
  state: RunStateSchema,
  cancellationRequestedAt: v.nullable(TimestampSchema),
  admittedAt: v.nullable(TimestampSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const MessageRoleSchema = v.picklist([
  "system",
  "user",
  "assistant",
  "tool",
]);

/**
 * Binary document formats that are extracted to bounded Markdown when a run is
 * admitted. Text and native image inputs are accepted separately by media type.
 */
export const RUN_DOCUMENT_CONTENT_TYPE_BY_EXTENSION = Object.freeze({
  pdf: "application/pdf",
  rtf: "application/rtf",
  doc: "application/msword",
  dot: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroenabled.12",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  dotm: "application/vnd.ms-word.template.macroenabled.12",
  xls: "application/vnd.ms-excel",
  xlt: "application/vnd.ms-excel",
  xla: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  xlam: "application/vnd.ms-excel.addin.macroenabled.12",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  xltm: "application/vnd.ms-excel.template.macroenabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pot: "application/vnd.ms-powerpoint",
  pps: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ppsm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
  potm: "application/vnd.ms-powerpoint.template.macroenabled.12",
  odt: "application/vnd.oasis.opendocument.text",
  ott: "application/vnd.oasis.opendocument.text-template",
  fodt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  ots: "application/vnd.oasis.opendocument.spreadsheet-template",
  fods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  otp: "application/vnd.oasis.opendocument.presentation-template",
  fodp: "application/vnd.oasis.opendocument.presentation",
  odg: "application/vnd.oasis.opendocument.graphics",
  otg: "application/vnd.oasis.opendocument.graphics-template",
  fodg: "application/vnd.oasis.opendocument.graphics",
  odf: "application/vnd.oasis.opendocument.formula",
  pages: "application/x-iwork-pages-sffpages",
  numbers: "application/x-iwork-numbers-sffnumbers",
  key: "application/x-iwork-keynote-sffkey",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
} as const);

export const RUN_DOCUMENT_EXTENSIONS = Object.freeze(
  Object.keys(RUN_DOCUMENT_CONTENT_TYPE_BY_EXTENSION),
);

export const RunFileSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  contentType: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  createdAt: TimestampSchema,
});
export const MessageSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  runId: IdSchema,
  role: MessageRoleSchema,
  redactedContent: v.string(),
  files: v.optional(v.array(RunFileSchema)),
  createdAt: TimestampSchema,
});

export const ToolOwnerSchema = v.picklist(["caller", "platform"]);
export const ToolStageSchema = v.picklist([
  "caller_pending",
  "caller_claimed",
  "platform_ready",
  "platform_executing",
  "result_submitted",
  "result_committed",
  "approval_denied",
  "approval_expired",
  "cancelled",
  "expired",
  "failed",
]);
export const ToolCallSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  owner: ToolOwnerSchema,
  stage: ToolStageSchema,
  safeArguments: JsonObjectSchema,
  claimFence: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/u)),
  createdAt: TimestampSchema,
});

export const ApprovalStatusSchema = v.picklist([
  "pending",
  "approved",
  "denied",
  "expired",
]);
export const ApprovalSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  toolCallId: v.nullable(IdSchema),
  status: ApprovalStatusSchema,
  summary: v.pipe(v.string(), v.maxLength(2_000)),
  expiresAt: v.nullable(TimestampSchema),
  resolvedByPrincipalId: v.nullable(IdSchema),
  resolvedAt: v.nullable(TimestampSchema),
});

export const ProductEventKindSchema = v.picklist([
  "delegation.created",
  "delegation.follow_up_created",
  "delegation.completed",
  "delegation.failed",
  "delegation.cancelled",
  "skill.draft_created",
  "skill.draft_discarded",
  "skill.created",
  "skill.version_published",
  "skill.version_deprecated",
  "skill.version_revoked",
  "skill.disabled",
  "skill.enabled",
  "skill.deleted",
  "skill.activated",
  "skill.resource_read",
  "mcp.server_created",
  "mcp.server_version_published",
  "mcp.discovery_completed",
  "mcp.discovery_failed",
  "mcp.toolset_published",
  "mcp.credential_created",
  "mcp.credential_rotated",
  "mcp.credential_revoked",
  "mcp.call_started",
  "mcp.call_completed",
  "mcp.call_failed",
  "mcp.call_cancelled",
  "harness.operation_started",
  "harness.operation_completed",
  "harness.operation_failed",
  "harness.operation_cancelled",
  "harness.operation_timed_out",
  "harness.operation_step",
  "run.created",
  "run.state_changed",
  "run.cancellation_requested",
  "message.created",
  "tool_call.requested",
  "tool_call.claimed",
  "tool_call.result_submitted",
  "tool_call.result_committed",
  "approval.requested",
  "approval.resolved",
  "sandbox.created",
  "sandbox.started",
  "sandbox.stopped",
  "sandbox.failed",
  "model.invocation_completed",
  "model.invocation_failed",
  "sandbox.command_started",
  "sandbox.command_completed",
  "sandbox.command_failed",
  "runtime.dispatch_reserved",
  "runtime.dispatch_admitted",
  "runtime.dispatch_reconciled",
  "runtime.recovery_started",
  "runtime.recovery_completed",
  "runtime.cancellation_draining",
  "session.summary_changed",
]);

export const RuntimeToolSnapshotSchema = v.strictObject({
  schemaVersion: v.optional(v.literal(1), 1),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  owner: v.picklist(["platform", "caller"]),
  approval: v.picklist(["never", "always"]),
  inputSchema: PublishedObjectSchema,
  outputSchema: PublishedObjectSchema,
});

export const ManagedMcpBindingSchema = v.strictObject({
  toolsetVersionId: IdSchema,
  credentialPolicyVersionId: IdSchema,
  namespace: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u),
  ),
});

export const ManagedMcpToolSnapshotSchema = v.strictObject({
  serverVersionId: IdSchema,
  toolsetVersionId: IdSchema,
  credentialPolicyVersionId: IdSchema,
  namespace: ManagedMcpBindingSchema.entries.namespace,
  remoteToolName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(200),
    v.regex(/^[a-zA-Z0-9_:-]+$/u),
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  approval: v.picklist(["never", "always"]),
  inputSchema: PublishedObjectSchema,
  outputSchema: v.nullable(PublishedObjectSchema),
  timeoutMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1_000),
    v.maxValue(120_000),
  ),
  maximumResponseBytes: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1_024),
    v.maxValue(10_485_760),
  ),
});

export const PLATFORM_MAX_TURNS = 32;

/**
 * Names installed by Flue, OAO orchestration, Skills, or the shared sandbox.
 * Agent-authored tools and Harness Operations may not shadow them.
 */
export const MANAGED_AGENT_RESERVED_TOOL_NAMES = Object.freeze([
  "task",
  "finish",
  "give_up",
  "activate_skill",
  "read_skill_resource",
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "delegate_agent",
  "message_agent",
] as const);

const ManagedHarnessOperationKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-z][a-z0-9_-]*$/u),
);

export const ManagedHarnessOperationSchema = v.strictObject({
  key: ManagedHarnessOperationKeySchema,
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  instructions: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
  resultSchema: PublishedObjectSchema,
  timeoutMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1_000),
    v.maxValue(300_000),
  ),
});

const ManagedHarnessOperationsSchema = v.pipe(
  v.array(ManagedHarnessOperationSchema),
  v.maxLength(32),
  v.check(
    (operations) =>
      new Set(operations.map((operation) => operation.key)).size ===
      operations.length,
    "Harness Operation keys must be unique",
  ),
);

export const SandboxCapabilitySchema = v.picklist([
  "filesystem_read",
  "filesystem_write",
  "shell",
  "browser",
]);

export const DEFAULT_SANDBOX_CAPABILITIES = Object.freeze([
  "filesystem_read",
  "filesystem_write",
  "shell",
] as const);

const LegacySandboxProviderKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^(?:local-fake|[a-z][a-z0-9]*(-[a-z0-9]+)*)$/u,
    "provider must be local-fake or a lowercase project provider key",
  ),
);

const ProjectSandboxProviderKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u,
    "provider key must be lowercase and hyphen separated",
  ),
  v.check((value) => value !== "local-fake", "local-fake is reserved"),
);

const SandboxCapabilitiesSchema = v.pipe(
  v.array(SandboxCapabilitySchema),
  v.check(
    (value) => new Set(value).size === value.length,
    "sandbox capabilities must be unique",
  ),
);

export const ManagedAgentDelegateSchema = v.strictObject({
  key: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  agentVersionId: IdSchema,
  maxParallel: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
    1,
  ),
});

const ManagedAgentDelegatesSchema = v.pipe(
  v.array(ManagedAgentDelegateSchema),
  v.maxLength(32),
  v.check(
    (delegates) =>
      new Set(delegates.map((delegate) => delegate.key)).size ===
        delegates.length &&
      new Set(delegates.map((delegate) => delegate.agentVersionId)).size ===
        delegates.length,
    "delegate keys and agent versions must be unique",
  ),
);

export const ManagedAgentPublicationConfigSchema = v.pipe(
  v.strictObject({
    systemPrompt: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
    modelPreset: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
    tools: v.pipe(
      v.array(RuntimeToolSnapshotSchema),
      v.maxLength(64),
      v.check(
        (tools) =>
          new Set(tools.map((tool) => tool.name)).size === tools.length &&
          tools.every(
            (tool) =>
              tool.name !== "delegate_agent" && tool.name !== "message_agent",
          ),
        "tool names must be unique; delegate_agent and message_agent are reserved platform tools",
      ),
    ),
    skillVersionIds: v.optional(v.array(IdSchema), []),
    harnessOperations: v.optional(ManagedHarnessOperationsSchema, []),
    mcpBindings: v.optional(
      v.pipe(
        v.array(ManagedMcpBindingSchema),
        v.maxLength(16),
        v.check(
          (bindings) =>
            new Set(bindings.map((binding) => binding.namespace)).size ===
              bindings.length &&
            new Set(
              bindings.map(
                (binding) =>
                  `${binding.toolsetVersionId}:${binding.credentialPolicyVersionId}`,
              ),
            ).size === bindings.length,
          "MCP namespaces and toolset-policy bindings must be unique",
        ),
      ),
      [],
    ),
    delegates: v.optional(ManagedAgentDelegatesSchema, []),
    sandbox: v.strictObject({
      enabled: v.boolean(),
      provider: ProjectSandboxProviderKeySchema,
      snapshotId: v.optional(IdSchema),
      network: v.picklist(["none", "restricted"]),
      capabilities: v.optional(SandboxCapabilitiesSchema, [
        ...DEFAULT_SANDBOX_CAPABILITIES,
      ]),
    }),
    limits: v.strictObject({
      maxTurns: v.literal(PLATFORM_MAX_TURNS),
      timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1_000)),
    }),
  }),
  v.check(
    (config) =>
      !config.sandbox.enabled || config.sandbox.snapshotId !== undefined,
    "sandbox.snapshotId is required when the sandbox is enabled",
  ),
  v.check((config) => {
    const names = [
      ...MANAGED_AGENT_RESERVED_TOOL_NAMES,
      ...config.tools.map((tool) => tool.name),
      ...config.harnessOperations.map((operation) => operation.key),
    ];
    return new Set(names).size === names.length;
  }, "Agent tools and Harness Operations must not collide with another mounted tool name"),
);

export function parseManagedAgentSnapshotForPublication(
  input: unknown,
): ManagedAgentPublicationConfig {
  return v.parse(ManagedAgentPublicationConfigSchema, input);
}

export const ManagedAgentSnapshotSchema = v.strictObject({
  agentVersionId: IdSchema,
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  systemPrompt: ManagedAgentPublicationConfigSchema.entries.systemPrompt,
  modelPreset: ManagedAgentPublicationConfigSchema.entries.modelPreset,
  tools: ManagedAgentPublicationConfigSchema.entries.tools,
  harnessOperations: v.optional(ManagedHarnessOperationsSchema, []),
  skills: v.optional(v.array(ManagedSkillBindingSnapshotSchema), []),
  mcpTools: v.optional(v.array(ManagedMcpToolSnapshotSchema), []),
  delegates: v.optional(ManagedAgentDelegatesSchema, []),
  sandbox: v.strictObject({
    enabled: v.boolean(),
    provider: v.optional(LegacySandboxProviderKeySchema, "local-fake"),
    snapshotId: v.optional(IdSchema),
    network: v.picklist(["none", "restricted"]),
    capabilities: v.optional(SandboxCapabilitiesSchema, [
      ...DEFAULT_SANDBOX_CAPABILITIES,
    ]),
  }),
  limits: ManagedAgentPublicationConfigSchema.entries.limits,
});

export const ManagedAgentInstanceDataSchema = v.object({
  organizationId: IdSchema,
  projectId: IdSchema,
  threadId: IdSchema,
  sessionId: IdSchema,
  workspace: v.optional(
    v.strictObject({
      id: IdSchema,
      ownerThreadId: IdSchema,
      ownerSessionId: IdSchema,
      ownerRunId: IdSchema,
    }),
  ),
  snapshot: ManagedAgentSnapshotSchema,
});

export const AgentDelegationStateSchema = v.picklist(["active", "cancelled"]);

export const AgentDelegationSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  parentRunId: IdSchema,
  parentThreadId: IdSchema,
  parentSessionId: IdSchema,
  parentAgentVersionId: IdSchema,
  delegateKey: ManagedAgentDelegateSchema.entries.key,
  childAgentVersionId: IdSchema,
  childThreadId: IdSchema,
  childSessionId: IdSchema,
  workspaceId: IdSchema,
  state: AgentDelegationStateSchema,
  latestChildRunId: IdSchema,
  latestChildRunState: RunStateSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ManagedRunDeliverySchema = v.object({
  version: v.literal("1"),
  runId: IdSchema,
  sessionId: IdSchema,
  snapshotHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export const ManagedRunInputV1Schema = v.object({
  message: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
  files: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: IdSchema,
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
          contentType: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
          sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
          sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
          storageProviderId: IdSchema,
          objectKey: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
        }),
      ),
      v.maxLength(8),
    ),
  ),
});

export const ToolResultFailureCodeSchema = v.picklist([
  "approval_denied",
  "approval_expired",
  "run_cancelled",
  "tool_expired",
  "tool_failed",
  "platform_tool_failed",
  "invalid_tool_arguments",
  "invalid_tool_result",
  "tool_retry_exhausted",
]);

export const ToolResultEnvelopeSchema = v.variant("status", [
  v.object({
    version: v.literal(1),
    status: v.literal("success"),
    value: JsonObjectSchema,
  }),
  v.object({
    version: v.literal(1),
    status: v.literal("failure"),
    error: v.object({
      code: ToolResultFailureCodeSchema,
      message: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    }),
  }),
]);

export function parseToolResultEnvelope(input: unknown): ToolResultEnvelope {
  return v.parse(ToolResultEnvelopeSchema, input);
}
export const ProductEventSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  aggregateType: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  aggregateId: IdSchema,
  aggregateSequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
  projectPosition: v.pipe(v.string(), v.regex(/^\d+$/u)),
  kind: ProductEventKindSchema,
  publicPayload: JsonObjectSchema,
  occurredAt: TimestampSchema,
});

export const CursorSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(256),
);
export const PaginationRequestSchema = v.object({
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)),
    50,
  ),
  cursor: v.optional(CursorSchema),
});
export const PageInfoSchema = v.object({
  nextCursor: v.nullable(CursorSchema),
  hasMore: v.boolean(),
});

export const ApiErrorCodeSchema = v.picklist([
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "rate_limited",
  "internal_error",
]);
export const ApiErrorSchema = v.object({
  error: v.object({
    code: ApiErrorCodeSchema,
    message: v.string(),
    requestId: v.optional(v.string()),
    details: v.optional(JsonObjectSchema),
  }),
});

export type Organization = v.InferOutput<typeof OrganizationSchema>;
export type Project = v.InferOutput<typeof ProjectSchema>;
export type CreateProjectInput = v.InferOutput<typeof CreateProjectInputSchema>;
export type ProjectMemberRole = v.InferOutput<typeof ProjectMemberRoleSchema>;
export type ProjectMember = v.InferOutput<typeof ProjectMemberSchema>;
export type CreateProjectMemberInput = v.InferOutput<
  typeof CreateProjectMemberInputSchema
>;
export type UpdateProjectMemberInput = v.InferOutput<
  typeof UpdateProjectMemberInputSchema
>;
export type AgentDefinition = v.InferOutput<typeof AgentDefinitionSchema>;
export type AgentVersion = v.InferOutput<typeof AgentVersionSchema>;
export type Skill = v.InferOutput<typeof SkillSchema>;
export type SkillVersion = v.InferOutput<typeof SkillVersionSchema>;
export type SkillDraft = v.InferOutput<typeof SkillDraftSchema>;
export type SkillDraftEntry = v.InferOutput<typeof SkillDraftEntrySchema>;
export type SkillLifecycleStatus = v.InferOutput<
  typeof SkillLifecycleStatusSchema
>;
export type ManagedSkillBindingSnapshot = v.InferOutput<
  typeof ManagedSkillBindingSnapshotSchema
>;
export type ManagedAgentDelegate = v.InferOutput<
  typeof ManagedAgentDelegateSchema
>;
export type ManagedHarnessOperation = v.InferOutput<
  typeof ManagedHarnessOperationSchema
>;
export type ManagedMcpBinding = v.InferOutput<typeof ManagedMcpBindingSchema>;
export type ManagedMcpToolSnapshot = v.InferOutput<
  typeof ManagedMcpToolSnapshotSchema
>;
export type Thread = v.InferOutput<typeof ThreadSchema>;
export type Session = v.InferOutput<typeof SessionSchema>;
export type RunState = v.InferOutput<typeof RunStateSchema>;
export type Run = v.InferOutput<typeof RunSchema>;
export type Message = v.InferOutput<typeof MessageSchema>;
export type RunFile = v.InferOutput<typeof RunFileSchema>;
export type ToolCall = v.InferOutput<typeof ToolCallSchema>;
export type ToolOwner = v.InferOutput<typeof ToolOwnerSchema>;
export type ToolStage = v.InferOutput<typeof ToolStageSchema>;
export type Approval = v.InferOutput<typeof ApprovalSchema>;
export type ProductEventKind = v.InferOutput<typeof ProductEventKindSchema>;
export type ProductEvent = v.InferOutput<typeof ProductEventSchema>;
export type ManagedAgentSnapshot = v.InferOutput<
  typeof ManagedAgentSnapshotSchema
>;
export type ManagedAgentPublicationConfig = v.InferOutput<
  typeof ManagedAgentPublicationConfigSchema
>;
export type SandboxCapability = v.InferOutput<typeof SandboxCapabilitySchema>;
export type ManagedAgentInstanceData = v.InferOutput<
  typeof ManagedAgentInstanceDataSchema
>;
export type AgentDelegation = v.InferOutput<typeof AgentDelegationSchema>;
export type AgentDelegationState = v.InferOutput<
  typeof AgentDelegationStateSchema
>;
export type ManagedRunDelivery = v.InferOutput<typeof ManagedRunDeliverySchema>;
export type ManagedRunInputV1 = v.InferOutput<typeof ManagedRunInputV1Schema>;
export type ToolResultEnvelope = v.InferOutput<typeof ToolResultEnvelopeSchema>;
export type ApiError = v.InferOutput<typeof ApiErrorSchema>;
export type Page<T> = {
  readonly data: readonly T[];
  readonly pageInfo: v.InferOutput<typeof PageInfoSchema>;
};

/**
 * Model presets are the only way an agent version names a model. The key is
 * stable and versioned so an already published, immutable agent version can
 * never be silently repointed at a different model or routing policy.
 */
export const MODEL_PRESET_KEY_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]{0,4}$/u;

const ProviderSlugSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(80),
  v.regex(/^[a-z0-9][a-z0-9._-]*$/u),
);
const ProviderSlugListSchema = v.pipe(
  v.array(ProviderSlugSchema),
  v.minLength(1),
  v.maxLength(16),
  v.check(
    (value: string[]) => new Set(value).size === value.length,
    "Provider list entries must be unique",
  ),
);
const PriceCapSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(1_000_000),
);

/**
 * Provider-neutral routing and data-handling policy. Provider specific wire
 * names stay behind the model adapter; the public contract never carries a
 * provider credential.
 */
export const ModelRoutingPolicySchema = v.strictObject({
  allowFallbacks: v.optional(v.boolean()),
  requireParameters: v.optional(v.boolean()),
  dataCollection: v.optional(v.picklist(["deny", "allow"])),
  zeroDataRetention: v.optional(v.boolean()),
  providerOrder: v.optional(ProviderSlugListSchema),
  providerAllowlist: v.optional(ProviderSlugListSchema),
  providerDenylist: v.optional(ProviderSlugListSchema),
  sort: v.optional(v.picklist(["price", "throughput", "latency"])),
  maxPromptPriceUsdPerMillion: v.optional(PriceCapSchema),
  maxCompletionPriceUsdPerMillion: v.optional(PriceCapSchema),
});

export const ModelPresetOriginSchema = v.picklist(["deployment", "project"]);
export const ModelProviderTypeSchema = v.picklist([
  "openrouter",
  "openai",
  "anthropic",
  "xai",
]);

/**
 * Provider-neutral generation controls stored with an immutable model preset.
 * Adapters translate these names to the selected provider's wire contract.
 */
export const OpenAIModelGenerationSettingsSchema = v.strictObject({
  textFormat: v.literal("text"),
  mode: v.picklist(["standard", "pro"]),
  effort: v.picklist(["none", "low", "medium", "high", "xhigh", "max"]),
  verbosity: v.picklist(["low", "medium", "high"]),
  summary: v.picklist(["auto", "concise", "detailed"]),
});

export const AnthropicModelGenerationSettingsSchema = v.strictObject({
  thinking: v.picklist(["disabled", "adaptive"]),
  maxTokens: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(300_000),
  ),
  effort: v.picklist(["low", "medium", "high", "xhigh", "max"]),
});

export const XAIModelGenerationSettingsSchema = v.strictObject({
  textFormat: v.literal("text"),
  effort: v.picklist(["low", "medium", "high", "xhigh"]),
});

export const ModelGenerationSettingsSchema = v.union([
  OpenAIModelGenerationSettingsSchema,
  AnthropicModelGenerationSettingsSchema,
  XAIModelGenerationSettingsSchema,
]);

export const DEFAULT_OPENAI_MODEL_GENERATION_SETTINGS = Object.freeze({
  textFormat: "text",
  mode: "standard",
  effort: "medium",
  verbosity: "medium",
  summary: "auto",
} as const);

export const DEFAULT_ANTHROPIC_MODEL_GENERATION_SETTINGS = Object.freeze({
  thinking: "adaptive",
  maxTokens: 20_000,
  effort: "high",
} as const);

export const DEFAULT_XAI_MODEL_GENERATION_SETTINGS = Object.freeze({
  textFormat: "text",
  effort: "high",
} as const);

const McpResourceKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
    "key must be lowercase and hyphen separated",
  ),
);

const McpEndpointSchema = v.pipe(
  v.string(),
  v.maxLength(2_048),
  v.url(),
  v.check((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  }, "MCP endpoint must be an HTTPS URL without user information or a fragment"),
);

export const McpTransportSchema = v.picklist(["streamable_http", "legacy_sse"]);
export const McpLifecycleStatusSchema = v.picklist([
  "active",
  "deprecated",
  "revoked",
]);
export const McpCredentialKindSchema = v.picklist([
  "static_bearer",
  "api_key_header",
]);

const McpCredentialHeaderSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/u),
  v.check(
    (value) =>
      !new Set([
        "connection",
        "content-length",
        "cookie",
        "host",
        "proxy-authorization",
        "set-cookie",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ]).has(value.toLowerCase()),
    "credential header is not allowed",
  ),
);

export const McpDiscoveredToolSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  title: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  inputSchema: PublishedObjectSchema,
  outputSchema: v.nullable(PublishedObjectSchema),
  schemaHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
});

export const McpServerSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  key: McpResourceKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  latestVersionId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  endpointUrl: McpEndpointSchema,
  transport: McpTransportSchema,
  status: McpLifecycleStatusSchema,
  tools: v.array(McpDiscoveredToolSchema),
  lastDiscoveredAt: v.nullable(TimestampSchema),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CreateMcpServerInputSchema = v.strictObject({
  key: McpResourceKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  endpointUrl: McpEndpointSchema,
  transport: v.optional(McpTransportSchema, "streamable_http"),
});

export const DiscoverMcpServerInputSchema = v.strictObject({
  credentialPolicyVersionId: v.optional(IdSchema),
});

export const McpCredentialSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  key: McpResourceKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  kind: McpCredentialKindSchema,
  headerName: v.nullable(McpCredentialHeaderSchema),
  credentialConfigured: v.literal(true),
  credentialFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/u)),
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: McpLifecycleStatusSchema,
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CreateMcpCredentialInputSchema = v.pipe(
  v.strictObject({
    key: McpResourceKeySchema,
    displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    kind: McpCredentialKindSchema,
    headerName: v.optional(v.nullable(McpCredentialHeaderSchema), null),
    secret: v.pipe(v.string(), v.minLength(8), v.maxLength(16_384)),
  }),
  v.check(
    (value) =>
      (value.kind === "static_bearer" && value.headerName === null) ||
      (value.kind === "api_key_header" && value.headerName !== null),
    "headerName is required only for API-key-header credentials",
  ),
);

export const RotateMcpCredentialInputSchema = v.strictObject({
  secret: v.pipe(v.string(), v.minLength(8), v.maxLength(16_384)),
});

export const McpCredentialPolicySchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  key: McpResourceKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  latestVersionId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  credentialId: IdSchema,
  exactOrigin: v.pipe(v.string(), v.url()),
  pathPrefix: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1_000)),
  maximumResponseBytes: v.pipe(v.number(), v.integer(), v.minValue(1_024)),
  status: McpLifecycleStatusSchema,
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CreateMcpCredentialPolicyInputSchema = v.strictObject({
  key: McpResourceKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  credentialId: IdSchema,
  exactOrigin: v.pipe(
    v.string(),
    v.url(),
    v.check((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    }, "exactOrigin must be an HTTPS origin without a path, query, user information or fragment"),
  ),
  pathPrefix: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(1_024),
    v.check((value) => value.startsWith("/"), "pathPrefix must be absolute"),
  ),
  timeoutMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(120_000)),
    30_000,
  ),
  maximumResponseBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1_024), v.maxValue(10_485_760)),
    1_048_576,
  ),
});

export const McpToolsetToolSchema = v.object({
  remoteToolName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
  inputSchema: PublishedObjectSchema,
  outputSchema: v.nullable(PublishedObjectSchema),
  approval: v.picklist(["never", "always"]),
});

export const McpToolsetSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  projectId: IdSchema,
  key: McpResourceKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  latestVersionId: IdSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  serverVersionId: IdSchema,
  status: McpLifecycleStatusSchema,
  tools: v.array(McpToolsetToolSchema),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CreateMcpToolsetInputSchema = v.strictObject({
  key: McpResourceKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  serverVersionId: IdSchema,
  tools: v.pipe(
    v.array(
      v.strictObject({
        remoteToolName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        approval: v.optional(v.picklist(["never", "always"]), "always"),
      }),
    ),
    v.minLength(1),
    v.maxLength(64),
    v.check(
      (tools) =>
        new Set(tools.map((tool) => tool.remoteToolName)).size === tools.length,
      "toolset tool names must be unique",
    ),
  ),
});

export const ProjectModelProviderSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: ModelProviderTypeSchema,
  credentialConfigured: v.literal(true),
  credentialFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/u)),
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const ModelProviderKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u,
    "key must be lowercase and hyphen separated",
  ),
);

export const CreateProjectModelProviderInputSchema = v.strictObject({
  key: ModelProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: ModelProviderTypeSchema,
  apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
});

export const RotateProjectModelProviderCredentialInputSchema = v.strictObject({
  apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
});

const SandboxDomainSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(253),
  v.regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "domain must be a hostname or wildcard hostname",
  ),
);

const SandboxCidrSchema = v.pipe(
  v.string(),
  v.minLength(3),
  v.maxLength(64),
  v.regex(/^[0-9a-f:.]+\/[0-9]{1,3}$/u, "CIDR must include a prefix length"),
);

export const SandboxRestrictedEgressSchema = v.strictObject({
  allowedDomains: v.optional(v.array(SandboxDomainSchema), []),
  allowedCidrs: v.optional(v.array(SandboxCidrSchema), []),
});

export const ProjectSandboxProviderSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("daytona"),
  credentialConfigured: v.literal(true),
  credentialFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/u)),
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  target: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  restrictedEgress: SandboxRestrictedEgressSchema,
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** Safe, credential-free metadata for a Daytona snapshot. */
export const SandboxSnapshotEntrySchema = v.object({
  id: IdSchema,
  providerType: v.literal("daytona"),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  state: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  available: v.boolean(),
  imageName: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  general: v.boolean(),
  cpu: v.pipe(v.number(), v.minValue(0)),
  gpu: v.pipe(v.number(), v.minValue(0)),
  memoryGiB: v.pipe(v.number(), v.minValue(0)),
  diskGiB: v.pipe(v.number(), v.minValue(0)),
  regionIds: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  sandboxClass: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(80))),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastUsedAt: v.nullable(TimestampSchema),
});

export const CreateProjectSandboxProviderInputSchema = v.strictObject({
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("daytona"),
  apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
  target: v.optional(
    v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    null,
  ),
  restrictedEgress: v.optional(SandboxRestrictedEgressSchema, {
    allowedDomains: [],
    allowedCidrs: [],
  }),
});

export const RotateProjectSandboxProviderCredentialInputSchema = v.strictObject(
  {
    apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
  },
);

export const UpdateProjectSandboxProviderConfigurationInputSchema =
  v.strictObject({
    target: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    restrictedEgress: SandboxRestrictedEgressSchema,
  });

const S3EndpointSchema = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.url(),
  v.check(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "endpoint must use HTTP or HTTPS",
  ),
);

const S3ObjectPrefixSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.check(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((segment) => segment && segment !== "." && segment !== ".."),
    "object prefix must be a safe relative path",
  ),
);

export const ProjectStorageProviderSchema = v.object({
  id: IdSchema,
  organizationId: IdSchema,
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("s3"),
  endpoint: v.nullable(S3EndpointSchema),
  region: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  bucket: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  prefix: v.nullable(S3ObjectPrefixSchema),
  forcePathStyle: v.boolean(),
  default: v.boolean(),
  credentialConfigured: v.literal(true),
  credentialFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{12}$/u)),
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  createdByPrincipalId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const S3CredentialFields = {
  accessKeyId: v.pipe(v.string(), v.minLength(3), v.maxLength(512)),
  secretAccessKey: v.pipe(v.string(), v.minLength(8), v.maxLength(4096)),
  sessionToken: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(8192)),
  ),
};

export const CreateProjectStorageProviderInputSchema = v.strictObject({
  key: ProjectSandboxProviderKeySchema,
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerType: v.literal("s3"),
  endpoint: v.nullable(S3EndpointSchema),
  region: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  bucket: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  prefix: v.nullable(S3ObjectPrefixSchema),
  forcePathStyle: v.boolean(),
  setDefault: v.optional(v.boolean(), true),
  ...S3CredentialFields,
});

export const RotateProjectStorageProviderCredentialInputSchema =
  v.strictObject(S3CredentialFields);

export const ModelPresetSchema = v.object({
  id: v.nullable(IdSchema),
  organizationId: v.nullable(IdSchema),
  projectId: v.nullable(IdSchema),
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  origin: ModelPresetOriginSchema,
  providerId: v.nullable(IdSchema),
  providerType: v.nullable(ModelProviderTypeSchema),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  routing: ModelRoutingPolicySchema,
  settings: v.nullable(ModelGenerationSettingsSchema),
  hosted: v.boolean(),
  available: v.boolean(),
  createdByPrincipalId: v.nullable(IdSchema),
  createdAt: v.nullable(TimestampSchema),
});

export const CreateModelPresetInputSchema = v.strictObject({
  key: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(120),
    v.regex(
      MODEL_PRESET_KEY_PATTERN,
      "key must be lowercase, hyphen separated, and end with a version suffix such as -v1",
    ),
  ),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  providerId: IdSchema,
  model: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(300),
    v.regex(
      /^(?:openrouter\/(?:@preset\/)?[a-zA-Z0-9~][a-zA-Z0-9._:~/-]*|(?:openai|anthropic|xai)\/[a-z0-9~][a-z0-9._:~/-]*)$/u,
      "model must be an approved OpenRouter, OpenAI, Anthropic, or xAI model or OpenRouter preset reference",
    ),
  ),
  routing: v.optional(ModelRoutingPolicySchema, {}),
  settings: v.optional(v.nullable(ModelGenerationSettingsSchema), null),
});

/** Safe, credential-free metadata for one provider catalog model or preset. */
export const ModelCatalogEntrySchema = v.object({
  providerType: ModelProviderTypeSchema,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  catalogId: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
  contextWindow: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  maxOutputTokens: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  reasoning: v.boolean(),
  adaptiveThinking: v.optional(v.boolean()),
  thinkingCanBeDisabled: v.optional(v.boolean()),
  effortLevels: v.optional(
    v.array(v.picklist(["low", "medium", "high", "xhigh", "max"])),
  ),
});

export function parseCreateProjectInput(input: unknown): CreateProjectInput {
  return v.parse(CreateProjectInputSchema, input);
}

export function parseCreateModelPresetInput(
  input: unknown,
): CreateModelPresetInput {
  return v.parse(CreateModelPresetInputSchema, input);
}

export function parseCreateProjectModelProviderInput(
  input: unknown,
): CreateProjectModelProviderInput {
  return v.parse(CreateProjectModelProviderInputSchema, input);
}

export function parseRotateProjectModelProviderCredentialInput(
  input: unknown,
): RotateProjectModelProviderCredentialInput {
  return v.parse(RotateProjectModelProviderCredentialInputSchema, input);
}

export function parseCreateProjectSandboxProviderInput(
  input: unknown,
): CreateProjectSandboxProviderInput {
  return v.parse(CreateProjectSandboxProviderInputSchema, input);
}

export function parseRotateProjectSandboxProviderCredentialInput(
  input: unknown,
): RotateProjectSandboxProviderCredentialInput {
  return v.parse(RotateProjectSandboxProviderCredentialInputSchema, input);
}

export function parseUpdateProjectSandboxProviderConfigurationInput(
  input: unknown,
): UpdateProjectSandboxProviderConfigurationInput {
  return v.parse(UpdateProjectSandboxProviderConfigurationInputSchema, input);
}

export function parseCreateProjectStorageProviderInput(
  input: unknown,
): CreateProjectStorageProviderInput {
  return v.parse(CreateProjectStorageProviderInputSchema, input);
}

export function parseRotateProjectStorageProviderCredentialInput(
  input: unknown,
): RotateProjectStorageProviderCredentialInput {
  return v.parse(RotateProjectStorageProviderCredentialInputSchema, input);
}

export function parseCreateMcpServerInput(
  input: unknown,
): CreateMcpServerInput {
  return v.parse(CreateMcpServerInputSchema, input);
}

export function parseDiscoverMcpServerInput(
  input: unknown,
): DiscoverMcpServerInput {
  return v.parse(DiscoverMcpServerInputSchema, input);
}

export function parseCreateMcpCredentialInput(
  input: unknown,
): CreateMcpCredentialInput {
  return v.parse(CreateMcpCredentialInputSchema, input);
}

export function parseRotateMcpCredentialInput(
  input: unknown,
): RotateMcpCredentialInput {
  return v.parse(RotateMcpCredentialInputSchema, input);
}

export function parseCreateMcpCredentialPolicyInput(
  input: unknown,
): CreateMcpCredentialPolicyInput {
  return v.parse(CreateMcpCredentialPolicyInputSchema, input);
}

export function parseCreateMcpToolsetInput(
  input: unknown,
): CreateMcpToolsetInput {
  return v.parse(CreateMcpToolsetInputSchema, input);
}

export function parseModelRoutingPolicy(input: unknown): ModelRoutingPolicy {
  return v.parse(ModelRoutingPolicySchema, input);
}

export type ModelRoutingPolicy = v.InferOutput<typeof ModelRoutingPolicySchema>;
export type PublicPrincipal = v.InferOutput<typeof PublicPrincipalSchema>;
export type AuthLogoutResult = v.InferOutput<typeof AuthLogoutResultSchema>;
export type ModelPresetOrigin = v.InferOutput<typeof ModelPresetOriginSchema>;
export type ModelProviderType = v.InferOutput<typeof ModelProviderTypeSchema>;
export type McpTransport = v.InferOutput<typeof McpTransportSchema>;
export type McpLifecycleStatus = v.InferOutput<typeof McpLifecycleStatusSchema>;
export type McpCredentialKind = v.InferOutput<typeof McpCredentialKindSchema>;
export type McpDiscoveredTool = v.InferOutput<typeof McpDiscoveredToolSchema>;
export type McpServer = v.InferOutput<typeof McpServerSchema>;
export type CreateMcpServerInput = v.InferOutput<
  typeof CreateMcpServerInputSchema
>;
export type DiscoverMcpServerInput = v.InferOutput<
  typeof DiscoverMcpServerInputSchema
>;
export type McpCredential = v.InferOutput<typeof McpCredentialSchema>;
export type CreateMcpCredentialInput = v.InferOutput<
  typeof CreateMcpCredentialInputSchema
>;
export type RotateMcpCredentialInput = v.InferOutput<
  typeof RotateMcpCredentialInputSchema
>;
export type McpCredentialPolicy = v.InferOutput<
  typeof McpCredentialPolicySchema
>;
export type CreateMcpCredentialPolicyInput = v.InferOutput<
  typeof CreateMcpCredentialPolicyInputSchema
>;
export type McpToolsetTool = v.InferOutput<typeof McpToolsetToolSchema>;
export type McpToolset = v.InferOutput<typeof McpToolsetSchema>;
export type CreateMcpToolsetInput = v.InferOutput<
  typeof CreateMcpToolsetInputSchema
>;
export type ProjectModelProvider = v.InferOutput<
  typeof ProjectModelProviderSchema
>;
export type CreateProjectModelProviderInput = v.InferOutput<
  typeof CreateProjectModelProviderInputSchema
>;
export type RotateProjectModelProviderCredentialInput = v.InferOutput<
  typeof RotateProjectModelProviderCredentialInputSchema
>;
export type SandboxRestrictedEgress = v.InferOutput<
  typeof SandboxRestrictedEgressSchema
>;
export type ProjectSandboxProvider = v.InferOutput<
  typeof ProjectSandboxProviderSchema
>;
export type SandboxSnapshotEntry = v.InferOutput<
  typeof SandboxSnapshotEntrySchema
>;
export type CreateProjectSandboxProviderInput = v.InferOutput<
  typeof CreateProjectSandboxProviderInputSchema
>;
export type RotateProjectSandboxProviderCredentialInput = v.InferOutput<
  typeof RotateProjectSandboxProviderCredentialInputSchema
>;
export type UpdateProjectSandboxProviderConfigurationInput = v.InferOutput<
  typeof UpdateProjectSandboxProviderConfigurationInputSchema
>;
export type ProjectStorageProvider = v.InferOutput<
  typeof ProjectStorageProviderSchema
>;
export type CreateProjectStorageProviderInput = v.InferOutput<
  typeof CreateProjectStorageProviderInputSchema
>;
export type RotateProjectStorageProviderCredentialInput = v.InferOutput<
  typeof RotateProjectStorageProviderCredentialInputSchema
>;
export type ModelPreset = v.InferOutput<typeof ModelPresetSchema>;
export type ModelGenerationSettings = v.InferOutput<
  typeof ModelGenerationSettingsSchema
>;
export type CreateModelPresetInput = v.InferOutput<
  typeof CreateModelPresetInputSchema
>;
export type ModelCatalogEntry = v.InferOutput<typeof ModelCatalogEntrySchema>;

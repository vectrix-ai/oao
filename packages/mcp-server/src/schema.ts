import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";

type JsonSchemaTarget = "draft-07" | "draft-2020-12" | "openapi-3.0";

/**
 * Lets a Valibot schema serve as an MCP tool input: Valibot validates the
 * arguments and the same schema is published as the tool's JSON Schema.
 */
export function toolInput<Schema extends v.GenericSchema>(
  schema: Schema,
): StandardSchemaWithJSON<v.InferInput<Schema>, v.InferOutput<Schema>> {
  const convert = (options: { readonly target: string }) =>
    toJsonSchema(schema, {
      target: jsonSchemaTarget(options.target),
      typeMode: "input",
      // Refinements without a JSON Schema form, such as cross-field checks,
      // still run in Valibot; the published schema just omits them.
      errorMode: "ignore",
    }) as Record<string, unknown>;
  const standard = schema["~standard"];
  return {
    "~standard": {
      version: standard.version,
      vendor: standard.vendor,
      validate: standard.validate,
      jsonSchema: { input: convert, output: convert },
    },
  } as StandardSchemaWithJSON<v.InferInput<Schema>, v.InferOutput<Schema>>;
}

function jsonSchemaTarget(target: string): JsonSchemaTarget {
  return target === "draft-07" || target === "openapi-3.0"
    ? target
    : "draft-2020-12";
}

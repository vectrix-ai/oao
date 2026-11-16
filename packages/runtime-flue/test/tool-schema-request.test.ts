import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createOpenRouterProjectProvider } from "@oao/models-openrouter";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { runtimeTesting } from "../src/index.js";

/**
 * The shape of an extraction MCP tool: one required property, optional ones
 * (some nullable), closed objects, and free-form `fields` objects.
 */
const submitExtraction = {
  type: "object",
  required: ["orders"],
  properties: {
    orders: {
      type: "array",
      items: {
        type: "object",
        required: ["shipments"],
        properties: {
          fields: {
            type: "object",
            description: "Order fields.",
            additionalProperties: true,
          },
          shipments: {
            type: "array",
            items: {
              type: "object",
              required: ["stops"],
              properties: {
                stops: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type"],
                    properties: {
                      type: { type: "string", minLength: 1, maxLength: 100 },
                      fields: {
                        type: "object",
                        description: "Stop fields.",
                        additionalProperties: true,
                      },
                      locationId: { type: ["string", "null"], maxLength: 200 },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    bulkUpload: {
      type: "object",
      required: ["shipments"],
      properties: {
        orders: { type: "integer" },
        shipments: { type: "integer" },
      },
      additionalProperties: false,
    },
    customerId: { type: ["string", "null"], maxLength: 200 },
    noOrderReason: { type: ["string", "null"], maxLength: 1000 },
  },
  additionalProperties: false,
} as const;

/** The JSON Schema Flue gives the model for a tool's input schema. */
function flueParameters(schema: unknown): Record<string, unknown> {
  const parameters = {
    ...(toJsonSchema(schema as Parameters<typeof toJsonSchema>[0], {
      errorMode: "ignore",
    }) as Record<string, unknown>),
  };
  delete parameters.$schema;
  return parameters;
}

async function sentTools(
  catalogId: string,
  parameters: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const provider = createOpenRouterProjectProvider({
    providerId: "project-model-test",
    catalogId,
    label: "test-v1",
    apiKey: "sk-or-tool-schema-test",
    settings: null,
    routing: undefined,
  });
  const model = provider.getModels()[0];
  assert.ok(model, catalogId);
  let payload: Record<string, unknown> | undefined;
  await provider
    .streamSimple(
      model,
      normalizeContext({
        messages: [{ role: "user", content: "Save the order.", timestamp: 1 }],
        tools: [
          {
            name: "submit_extraction",
            description: "Save the extraction.",
            parameters: parameters as never,
          },
        ],
      }),
      {
        apiKey: "sk-or-tool-schema-test",
        maxRetries: 0,
        fetch: async (_input, init) => {
          payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ error: { message: "expected test stop" } }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        },
      },
    )
    .result();
  assert.ok(payload, catalogId);
  return payload.tools as Record<string, unknown>[];
}

test("an MCP tool reaches OpenRouter as a non-strict tool, with optional properties and open objects", async () => {
  const compiled = runtimeTesting.compileToolInputSchema(
    submitExtraction as never,
  );
  const parameters = flueParameters(compiled);
  // Optional properties stay optional, closed objects closed, and free-form
  // objects open, in what the model is shown.
  assert.deepEqual(parameters.required, ["orders"]);
  const properties = parameters.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(properties.bulkUpload?.additionalProperties, false);
  const order = (properties.orders?.items ?? {}) as Record<string, unknown>;
  const orderFields = (
    order.properties as Record<string, Record<string, unknown>>
  ).fields;
  assert.notEqual(orderFields?.additionalProperties, false);
  assert.deepEqual(orderFields?.required ?? [], []);

  for (const catalogId of [
    "@preset/azure-sol-61",
    "openai/gpt-6.1-sol",
    "anthropic/claude-haiku-5.5",
  ]) {
    const tool = (await sentTools(catalogId, parameters)).find(
      (entry) => entry.name === "submit_extraction",
    );
    assert.ok(tool, catalogId);
    // Responses reads a function tool without `strict` as strict, which
    // requires every property and closes every object.
    assert.equal(tool.strict, false, catalogId);
    assert.deepEqual(tool.parameters, parameters, catalogId);
  }

  // Keys the model writes into a free-form object survive validation.
  const parsed = v.parse(compiled, {
    orders: [
      {
        fields: { reference: "PO 4500918273" },
        shipments: [
          {
            stops: [
              {
                type: "pickup",
                fields: { city: "Bornem", postal_code: "2880" },
              },
            ],
          },
        ],
      },
    ],
  }) as {
    orders: {
      fields: Record<string, unknown>;
      shipments: { stops: { fields: Record<string, unknown> }[] }[];
    }[];
  };
  assert.deepEqual(parsed.orders[0]?.fields, { reference: "PO 4500918273" });
  assert.deepEqual(parsed.orders[0]?.shipments[0]?.stops[0]?.fields, {
    city: "Bornem",
    postal_code: "2880",
  });
  assert.equal("bulkUpload" in (parsed as object), false);
});

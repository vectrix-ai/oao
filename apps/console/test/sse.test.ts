import { describe, expect, it } from "vitest";
import { parseProductEvent, parseSseFrames } from "../src/api/sse";

describe("resumable SSE parser", () => {
  it("retains partial frames and parses public product events", () => {
    const event = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      organizationId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      aggregateType: "session",
      aggregateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      aggregateSequence: 2,
      projectPosition: "42",
      kind: "run.state_changed",
      publicPayload: { state: "running" },
      occurredAt: "2026-08-20T07:05:44.000Z",
    };
    const input = `id: djE6NDI\nevent: product-event\ndata: ${JSON.stringify(event)}\n\nid: partial`;
    const parsed = parseSseFrames(input);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]?.id).toBe("djE6NDI");
    expect(parsed.rest).toBe("id: partial");
    expect(parseProductEvent(parsed.frames[0]!)).toEqual(event);
  });
});

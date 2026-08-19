import type { ProductEvent } from "@oao/contracts";
import * as v from "valibot";
import { ProductEventSchema } from "@oao/contracts";

interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

export function parseSseFrames(buffer: string): {
  frames: SseFrame[];
  rest: string;
} {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const chunk of chunks) {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const value =
        separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
      if (field === "id") id = value;
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    if (data.length > 0)
      frames.push({
        ...(id ? { id } : {}),
        ...(event ? { event } : {}),
        data: data.join("\n"),
      });
  }
  return { frames, rest };
}

export function parseProductEvent(frame: SseFrame): ProductEvent | null {
  if (frame.event === "heartbeat") return null;
  return v.parse(ProductEventSchema, JSON.parse(frame.data));
}

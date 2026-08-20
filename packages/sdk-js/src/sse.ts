export interface ParsedSseEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
  readonly retry?: number;
}

/** Incrementally parses a standards-compatible text/event-stream response. */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;

  const dispatch = (): ParsedSseEvent | undefined => {
    if (data.length === 0) {
      id = undefined;
      event = undefined;
      retry = undefined;
      return undefined;
    }
    const parsed: ParsedSseEvent = {
      data: data.join("\n"),
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
      ...(retry === undefined ? {} : { retry }),
    };
    data = [];
    id = undefined;
    event = undefined;
    retry = undefined;
    return parsed;
  };

  const consumeLine = (line: string): ParsedSseEvent | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        data.push(value);
        break;
      case "event":
        event = value;
        break;
      case "id":
        if (!value.includes("\u0000")) id = value;
        break;
      case "retry":
        if (/^\d+$/u.test(value)) retry = Number(value);
        break;
    }
    return undefined;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = consumeLine(
          rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine,
        );
        if (parsed !== undefined) yield parsed;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const parsed = consumeLine(
        buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer,
      );
      if (parsed !== undefined) yield parsed;
    }
    const final = dispatch();
    if (final !== undefined) yield final;
  } finally {
    reader.releaseLock();
  }
}

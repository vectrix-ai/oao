import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpConsoleApi } from "../src/api/http";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP console adapter authentication", () => {
  it("includes cookie credentials on ordinary requests", async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response;
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    const api = new HttpConsoleApi({ baseUrl: "/console-api" });
    await api.getContext();

    expect(fetchMock).toHaveBeenCalledWith(
      "/console-api/context",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("includes cookies and optional bearer headers on resumable SSE without URL tokens", async () => {
    let aborted = false;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          void input;
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpConsoleApi({
      baseUrl: "/console-api",
      getAccessToken: async () => "machine-token",
    });

    const connection = api.connectEvents({
      after: "djE6NDI",
      onEvent: vi.fn(),
      onCursor: vi.fn(),
      onError: vi.fn(),
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/console-api/events");
    expect(String(url)).not.toContain("machine-token");
    expect(init).toEqual(
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          accept: "text/event-stream",
          authorization: "Bearer machine-token",
          "last-event-id": "djE6NDI",
        }),
      }),
    );
    connection.close();
    await waitFor(() => expect(aborted).toBe(true));
  });
});

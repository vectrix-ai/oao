// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveApiMode, resolveAuthProvider } from "../vite.config.js";

describe("console build auth provider", () => {
  it("prefers the process environment used by CI", () => {
    expect(
      resolveAuthProvider(
        { AUTH_PROVIDER: "development" },
        { AUTH_PROVIDER: "workos" },
      ),
    ).toBe("workos");
  });

  it("falls back to the loaded dotenv environment", () => {
    expect(resolveAuthProvider({ AUTH_PROVIDER: "iap" }, {})).toBe("iap");
  });

  it("discovers authentication when the build has no provider", () => {
    expect(resolveAuthProvider({}, {})).toBe("");
  });

  it("keeps explicitly selected development authentication", () => {
    expect(resolveAuthProvider({}, { AUTH_PROVIDER: "development" })).toBe(
      "development",
    );
  });

  it("keeps a hosted provider-neutral image in discovery mode", () => {
    expect(resolveAuthProvider({}, { AUTH_PROVIDER: "" })).toBe("");
  });
});

describe("console build environment", () => {
  it("passes and hashes provider and API mode through Turbo's strict environment", () => {
    const configuration = JSON.parse(
      readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8"),
    ) as { tasks: { build: { env: string[] } } };
    expect(configuration.tasks.build.env).toEqual(
      expect.arrayContaining(["AUTH_PROVIDER", "VITE_OAO_API_MODE"]),
    );
  });
});

describe("console build API mode", () => {
  it("uses the hosted Docker build setting from the process environment", () => {
    expect(
      resolveApiMode(
        { VITE_OAO_API_MODE: "demo" },
        { VITE_OAO_API_MODE: "http" },
      ),
    ).toBe("http");
  });

  it("keeps the demo default when no API mode is configured", () => {
    expect(resolveApiMode({}, {})).toBeUndefined();
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
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
    expect(resolveAuthProvider({ AUTH_PROVIDER: "workos" }, {})).toBe("workos");
  });

  it("defaults to development authentication", () => {
    expect(resolveAuthProvider({}, {})).toBe("development");
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

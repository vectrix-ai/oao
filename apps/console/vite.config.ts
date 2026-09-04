import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export function resolveAuthProvider(
  loadedEnvironment: Readonly<Record<string, string | undefined>>,
  runtimeEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
): string {
  return (
    runtimeEnvironment.AUTH_PROVIDER ??
    loadedEnvironment.AUTH_PROVIDER ??
    "development"
  );
}

export function resolveApiMode(
  loadedEnvironment: Readonly<Record<string, string | undefined>>,
  runtimeEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
): string | undefined {
  return (
    runtimeEnvironment.VITE_OAO_API_MODE ?? loadedEnvironment.VITE_OAO_API_MODE
  );
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, ".", "");
  const proxyTarget =
    environment.VITE_OAO_API_PROXY_TARGET ?? "http://127.0.0.1:3000";
  const authProvider = resolveAuthProvider(environment);
  const apiMode = resolveApiMode(environment);
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_OAO_AUTH_PROVIDER": JSON.stringify(authProvider),
      "import.meta.env.VITE_OAO_API_MODE": JSON.stringify(apiMode),
    },
    server: {
      port: 8080,
      proxy: { "/v1": { target: proxyTarget, changeOrigin: false } },
    },
    preview: { port: 4173 },
    test: {
      environment: "jsdom",
      setupFiles: "./test/setup.ts",
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      css: true,
    },
  };
});

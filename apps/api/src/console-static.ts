import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono } from "hono";

export function mountConsoleStatic<E extends Env>(
  app: Hono<E>,
  root = "../console/dist",
): void {
  const serveFile = serveStatic({ root });
  const serveIndex = serveStatic({ root, path: "index.html" });

  app.get("*", async (c, next) => {
    if (c.req.path === "/v1" || c.req.path.startsWith("/v1/")) {
      return next();
    }

    return serveFile(c, async () => {
      const response = await serveIndex(c, next);
      if (response) {
        c.res = response;
      }
    });
  });
}

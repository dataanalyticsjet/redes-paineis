import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

function fastApiDevProxy(target: string): Plugin {
  return {
    name: "redes-paineis-fastapi-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url ?? "/";
        if (
          (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH" && request.method !== "DELETE" && request.method !== "OPTIONS") ||
          !requestUrl.startsWith("/") ||
          requestUrl.startsWith("//")
        ) {
          return next();
        }

        let pathname: string;
        let targetUrl: URL;
        try {
          pathname = new URL(requestUrl, "http://vite.local").pathname;
          if (pathname !== "/api" && !pathname.startsWith("/api/")) return next();
          targetUrl = new URL(requestUrl, target);
        } catch {
          return next();
        }

        const requestUpstream = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
        const upstream = requestUpstream(
          targetUrl,
          { method: request.method, headers: request.headers },
          (upstreamResponse) => {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              upstreamResponse.statusMessage,
              upstreamResponse.headers,
            );
            upstreamResponse.pipe(response);
          },
        );
        upstream.on("error", () => {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          response.statusCode = 502;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "fastapi_unavailable" }));
        });
        request.pipe(upstream);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const viteEnv = loadEnv(mode, process.cwd(), "");
  const fastApiDevTarget =
    process.env.FASTAPI_DEV_TARGET ??
    viteEnv.FASTAPI_DEV_TARGET ??
    "http://127.0.0.1:8001";
  const frontendPort = Number(
    process.env.FRONTEND_PORT ?? viteEnv.FRONTEND_PORT ?? 3001,
  );
  const nitroPreset =
    process.env.NITRO_PRESET ?? viteEnv.NITRO_PRESET ?? "node-server";

  return {
    plugins: [
      fastApiDevProxy(fastApiDevTarget),
      tanstackStart(),
      nitro({ preset: nitroPreset }),
      react(),
    ],
    server: {
      host: "127.0.0.1",
      port: frontendPort,
      strictPort: true,
    },
  };
});

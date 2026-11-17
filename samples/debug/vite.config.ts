import { defineConfig, type PreviewServer, type ViteDevServer } from "vite";

function installSink(server: ViteDevServer | PreviewServer): void {
  let fail = false;
  server.middlewares.use((request, response, next) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/debug-sink" && request.method === "PUT") {
      fail = url.searchParams.get("fail") === "true";
      response.end();
      return;
    }
    if (!["/v1/traces", "/v1/logs"].includes(url.pathname) || request.method !== "POST") {
      next();
      return;
    }
    const rejected = fail;
    request.resume();
    request.on("end", () => {
      setTimeout(() => {
        response.statusCode = rejected ? 400 : 200;
        response.setHeader("Content-Type", "application/json");
        response.end(rejected ? '{"message":"Intentional test rejection"}' : "{}");
      }, 400);
    });
  });
}

export default defineConfig({
  plugins: [
    {
      name: "local-debug-telemetry-sink",
      configureServer: installSink,
      configurePreviewServer: installSink,
    },
  ],
});

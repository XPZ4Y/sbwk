// SBWK dummy backend — a tiny, zero-dependency stand-in for "your application".
// Replaces the ~200MB kennethreitz/httpbin image. Shares the node:22-alpine base
// with the rest of the stack, so it adds no extra base-image pull.
//
// httpbin-compatible:  GET /status/:code   (e.g. /status/500, /status/404)
// App-like routes:     /users (database), /external (third-party), /health
// Failure injection:   POST /_control {"mode":"normal|database|external"}
// Latency injection:   GET /delay/:seconds
import http from "node:http";

const PORT = Number(process.env.PORT || 8000);
let failMode = process.env.FAIL_MODE || "normal";

const users = [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }];

function getUsersFromDatabase() {
  if (failMode === "database") throw new Error("Database error: connection pool exhausted (100/100 connections in use)");
  return users;
}
function callExternalApi() {
  if (failMode === "external") { const e = new Error("Upstream third-party API returned HTTP 503"); e.statusCode = 503; throw e; }
  return { ok: true, provider: "third-party-api" };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise(resolve => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => resolve(d)); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "POST" && p === "/_control") {
    try { const { mode } = JSON.parse((await readBody(req)) || "{}"); if (["normal", "database", "external"].includes(mode)) failMode = mode; } catch { /* ignore */ }
    return json(res, 200, { failMode });
  }

  try {
    if (p === "/health") return json(res, 200, { status: "healthy", failMode });
    if (p === "/") return json(res, 200, { service: "sbwk-dummy-server", routes: ["/users", "/external", "/status/:code", "/delay/:seconds", "/health"] });

    // httpbin-compatible status endpoint.
    const statusMatch = p.match(/^\/status\/(\d{3})$/);
    if (statusMatch) {
      const code = Number(statusMatch[1]);
      if (code < 100 || code > 599) return json(res, 400, { error: "status must be 100-599" });
      return json(res, code, { status: code, message: `Simulated HTTP ${code}` });
    }

    // Latency injection for slow-response detection.
    const delayMatch = p.match(/^\/delay\/(\d+(?:\.\d+)?)$/);
    if (delayMatch) {
      const seconds = Math.min(Number(delayMatch[1]), 10);
      await new Promise(r => setTimeout(r, seconds * 1000));
      return json(res, 200, { delayed: seconds });
    }

    if (p === "/users") return json(res, 200, { users: getUsersFromDatabase() });
    if (p === "/external") return json(res, 200, callExternalApi());
    return json(res, 404, { error: "Not Found", path: p });
  } catch (err) {
    return json(res, err.statusCode || 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(JSON.stringify({ level: "info", event: "dummy_server_listening", service: "dummy-server", port: PORT, failMode, timestamp: new Date().toISOString() })));

function shutdown(signal) { console.log(JSON.stringify({ level: "info", event: "dummy_server_shutdown", signal })); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); }
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

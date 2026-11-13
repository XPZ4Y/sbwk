// Demo application Server monitored by SBWK.
// This is a deliberately simple app with a couple of failure modes so the
// middleware can detect anomalies and Agent Core can diagnose them. Its source
// doubles as the read-only "codebase" the agent inspects.
import http from "node:http";

const PORT = Number(process.env.PORT || 8000);
let failMode = process.env.FAIL_MODE || "normal"; // normal | database | external

const users = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Linus" }
];

// Simulates reading users from the database.
function getUsersFromDatabase() {
  if (failMode === "database") {
    throw new Error("Database error: connection pool exhausted (100/100 connections in use)");
  }
  return users;
}

// Simulates calling a third-party API.
function callExternalApi() {
  if (failMode === "external") {
    const err = new Error("Upstream third-party API returned HTTP 503");
    err.statusCode = 503;
    throw err;
  }
  return { ok: true, provider: "third-party-api" };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function readBody(req) {
  return new Promise(resolve => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Demo control: flip the failure mode at runtime.
  if (req.method === "POST" && url.pathname === "/_control") {
    const body = await readBody(req);
    try {
      const { mode } = JSON.parse(body || "{}");
      if (["normal", "database", "external"].includes(mode)) failMode = mode;
    } catch { /* ignore */ }
    return json(res, 200, { failMode });
  }

  try {
    if (url.pathname === "/health") return json(res, 200, { status: "healthy", failMode });
    if (url.pathname === "/") return json(res, 200, { service: "demo-target", routes: ["/users", "/external"] });
    if (url.pathname === "/users") return json(res, 200, { users: getUsersFromDatabase() });
    if (url.pathname === "/external") return json(res, 200, callExternalApi());
    return json(res, 404, { error: "Not Found", path: url.pathname });
  } catch (err) {
    return json(res, err.statusCode || 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[demo-target] listening on ${PORT} (failMode=${failMode})`);
});

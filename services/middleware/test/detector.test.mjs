import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, categoryForUpstreamError, buildIncident, DispatchThrottle } from "../detector.mjs";

test("flags 5xx at the default threshold", () => {
  const d = classifyStatus(500, 500);
  assert.equal(d.detect, true);
  assert.equal(d.category, "server_error");
});

test("does not flag 404 when threshold is 500", () => {
  assert.equal(classifyStatus(404, 500).detect, false);
});

test("flags 404 as client error when threshold is 400", () => {
  const d = classifyStatus(404, 400);
  assert.equal(d.detect, true);
  assert.equal(d.category, "client_error");
});

test("never flags 2xx/3xx", () => {
  assert.equal(classifyStatus(200, 400).detect, false);
  assert.equal(classifyStatus(302, 400).detect, false);
});

test("maps upstream errors to categories", () => {
  assert.equal(categoryForUpstreamError("TIMEOUT"), "timeout");
  assert.equal(categoryForUpstreamError("CONNECTION_FAILED"), "upstream_unreachable");
});

test("throttle suppresses duplicates within the window", () => {
  const t = new DispatchThrottle(10000);
  const base = { method: "GET", path: "/users", statusCode: 500 };
  assert.equal(t.shouldDispatch(base, 1000), true);
  assert.equal(t.shouldDispatch(base, 2000), false);
  assert.equal(t.shouldDispatch(base, 11001), true);
});

test("throttle treats different paths/statuses independently", () => {
  const t = new DispatchThrottle(10000);
  const base = { method: "GET", path: "/users", statusCode: 500 };
  assert.equal(t.shouldDispatch(base, 1000), true);
  assert.equal(t.shouldDispatch({ ...base, path: "/orders" }, 1000), true);
  assert.equal(t.shouldDispatch({ ...base, statusCode: 503 }, 1000), true);
});

test("buildIncident splits path/query and rounds duration", () => {
  const i = buildIncident({ id: "id", requestId: "req", method: "GET", url: "/users?id=42", statusCode: 500, durationMs: 12.3456, upstream: "http://server:80", category: "server_error", reason: "HTTP 500", responseSample: "boom" });
  assert.equal(i.path, "/users");
  assert.equal(i.query, "id=42");
  assert.equal(i.durationMs, 12.35);
  assert.equal(i.source, "middleware");
});

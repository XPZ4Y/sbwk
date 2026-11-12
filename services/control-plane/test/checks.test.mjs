import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseRepoUrl, checkReachability } from "../checks.mjs";

test("parseRepoUrl handles https, .git, git remote and shorthand", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/caaplin/sbwk"), { owner: "caaplin", repo: "sbwk" });
  assert.deepEqual(parseRepoUrl("https://github.com/caaplin/sbwk.git"), { owner: "caaplin", repo: "sbwk" });
  assert.deepEqual(parseRepoUrl("git@github.com:caaplin/sbwk.git"), { owner: "caaplin", repo: "sbwk" });
  assert.deepEqual(parseRepoUrl("caaplin/sbwk"), { owner: "caaplin", repo: "sbwk" });
  assert.equal(parseRepoUrl("not a url"), null);
});

test("checkReachability: any HTTP response (even 404) means reachable", async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end("nope"); });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const r = await checkReachability(`http://localhost:${port}/logs`);
  assert.equal(r.reachable, true);
  assert.equal(r.status, 404);
  assert.equal(r.method, "http");
  server.close();
});

test("checkReachability: closed port is unreachable", async () => {
  const r = await checkReachability("http://localhost:1/", { timeoutMs: 1000 });
  assert.equal(r.reachable, false);
});

test("checkReachability: invalid URL is rejected", async () => {
  const r = await checkReachability("not a url");
  assert.equal(r.ok, false);
  assert.equal(r.reachable, false);
});

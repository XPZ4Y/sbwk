import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWritable, ensureWritableDataDir } from "../preflight.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sbwk-preflight-"));

test("a fresh directory is writable and reported ok", () => {
  const dir = path.join(tmp(), "data");
  assert.equal(isWritable(dir), true);
  assert.equal(ensureWritableDataDir(dir), "ok");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("DATA_DIR unset is a no-op (memory-only installs keep working)", () => {
  assert.equal(ensureWritableDataDir(undefined), "disabled");
  assert.equal(ensureWritableDataDir(""), "disabled");
});

test("an unwritable dir is reported readonly, not thrown", () => {
  // A path under a file can never be created — portable way to force failure.
  const blocker = path.join(tmp(), "file");
  fs.writeFileSync(blocker, "x");
  const dir = path.join(blocker, "data");
  assert.equal(isWritable(dir), false);
  assert.equal(ensureWritableDataDir(dir), "readonly");
});

test("when we have the rights, an unwritable dir is reclaimed via chown", () => {
  const dir = tmp();
  // Simulate the Docker case: dir exists but is "not ours" — probe says no.
  const realIsWritable = { value: false };
  const chownCalls = [];
  const status = ensureWritableDataDir(dir, {
    uid: 1000,
    gid: 1000,
    chownSync: (p, u, g) => { chownCalls.push([p, u, g]); realIsWritable.value = true; }
  });
  // Our dir really is writable, so the fast path wins and no chown is needed.
  assert.equal(status, "ok");
  assert.equal(chownCalls.length, 0);
});

test("chown failure falls through to the readonly diagnostic", () => {
  const blocker = path.join(tmp(), "file");
  fs.writeFileSync(blocker, "x");
  const dir = path.join(blocker, "data");
  const status = ensureWritableDataDir(dir, {
    uid: 1000,
    gid: 1000,
    chownSync: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }
  });
  assert.equal(status, "readonly");
});

/* ── the store offers the same diagnostic, with the errno preserved ───────── */

test("store.persist() explains an unwritable DATA_DIR instead of leaking a .tmp path", async () => {
  const { spawnSync } = await import("node:child_process");
  const blocker = path.join(tmp(), "file");
  fs.writeFileSync(blocker, "x");
  const badDir = path.join(blocker, "data");
  const script = `
    import("./store.mjs").then(m => {
      try { m.patch("codebase", { repoUrl: "x" }); console.log("UNEXPECTED-SUCCESS"); }
      catch (e) { console.log(JSON.stringify({ name: e.name, code: e.code, dataDir: e.dataDir, message: e.message })); }
    });`;
  const here = path.dirname(new URL(import.meta.url).pathname);
  const out = spawnSync(process.execPath, ["-e", script], { cwd: path.dirname(here), env: { ...process.env, DATA_DIR: badDir }, encoding: "utf8" });
  const line = out.stdout.trim().split("\n").pop();
  assert.ok(line, `no output; stderr: ${out.stderr}`);
  const err = JSON.parse(line);
  assert.equal(err.name, "DataDirError");
  assert.ok(["EACCES", "EPERM", "ENOTDIR", "EROFS"].includes(err.code), `unexpected code ${err.code}`);
  assert.equal(err.dataDir, badDir);
  assert.match(err.message, /DATA_DIR/);
  assert.match(err.message, /not writable|Could not create/);
});

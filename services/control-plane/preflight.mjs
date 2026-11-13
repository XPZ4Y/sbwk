// Entrypoint glue so a mounted DATA_DIR can never block onboarding saves.
//
// The failure this prevents (seen in the wild):
//
//   save failed: could not save: EACCES: permission denied,
//   open '/data/onboarding.json.tmp'
//
// Cause: `control-plane-data` is a named volume, so Docker creates the empty
// directory as root:root, while the image runs as `USER node` (uid 1000). The
// store's atomic write (temp file + rename) then fails on the temp file, and the
// error names onboarding.json.tmp instead of the real culprit, the directory.
//
// Two independent defences:
//   1. `docker-entrypoint.sh` (ships in the image) chowns DATA_DIR to the runtime
//      user at container start, then drops from root to that user. Existing
//      installs heal on `docker compose up` — no manual chown needed.
//   2. `ensureWritableDataDir()` here upgrades a non-root start when we happen to
//      have the rights (root, or CAP_CHOWN), and otherwise leaves the failure to
//      store.mjs, which explains exactly what to fix.
import fs from "node:fs";
import path from "node:path";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "control-plane", timestamp: new Date().toISOString(), ...fields }));

/** Can this process create files in `dir`? Probed for real; not guessed from mode bits. */
export function isWritable(dir) {
  if (!dir) return true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.sbwk-write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort repair of a freshly-mounted volume. Returns a short status string
 * for the boot log; never throws (an unwritable dir is reported, not fatal, so
 * the UI can still show the onboarding pages).
 */
export function ensureWritableDataDir(dir = process.env.DATA_DIR, opts = {}) {
  if (!dir) return "disabled";
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  const gid = opts.gid ?? (typeof process.getgid === "function" ? process.getgid() : null);
  const chownImpl = opts.chownSync || fs.chownSync;

  if (isWritable(dir)) {
    // Already ours. Still make sure a stale root-owned file cannot block renames.
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours to chmod; harmless */ }
    return "ok";
  }

  // Not writable: try to take ownership (works when we are root / have CAP_CHOWN).
  try {
    if (uid !== null && gid !== null) chownImpl(dir, uid, gid);
    if (isWritable(dir)) {
      log("warn", "data_dir_reclaimed", { dir, uid, gid });
      return "reclaimed";
    }
  } catch { /* no rights — fall through to the diagnostic path */ }

  log("error", "data_dir_not_writable", {
    dir, uid,
    hint: `chown -R ${uid}:${uid} ${dir} (or recreate the volume). Saves will fail until this is fixed.`
  });
  return "readonly";
}

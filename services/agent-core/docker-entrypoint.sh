#!/bin/sh
# Start as root only long enough to make the mounted DATA_DIR writable by the
# unprivileged runtime user, then drop to it.
#
# Why: a named volume (control-plane-data) is created root:root 0755, but the
# image runs as `node` (uid 1000). Every save then died with
#   EACCES: permission denied, open '/data/onboarding.json.tmp'
#
# This makes existing volumes self-heal on the next `docker compose up`, and makes
# fresh ones correct on first boot. If we are not root, do nothing and let the
# store report the exact remedy (running as an arbitrary uid is still supported).
set -e

RUNTIME_USER="${SBWK_RUNTIME_USER:-node}"

if [ "$(id -u)" = "0" ]; then
  if [ -n "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR"
    # Only touch ownership when it is wrong, so a correct volume stays cheap.
    if [ "$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null)" != "$(id -u "$RUNTIME_USER"):$(id -g "$RUNTIME_USER")" ]; then
      chown -R "$RUNTIME_USER:$RUNTIME_USER" "$DATA_DIR" 2>/dev/null || true
      echo "{\"level\":\"warn\",\"event\":\"data_dir_chowned\",\"service\":\"control-plane\",\"dataDir\":\"$DATA_DIR\",\"user\":\"$RUNTIME_USER\"}"
    fi
  fi
  exec su-exec "$RUNTIME_USER" "$@"
fi

# Already unprivileged (e.g. compose `user:` override): just run.
exec "$@"

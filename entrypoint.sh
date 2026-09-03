#!/bin/bash
set -euo pipefail

TARGET_UID="${SHANNON_HOST_UID:-}"
TARGET_GID="${SHANNON_HOST_GID:-}"
CURRENT_UID=$(id -u pentest 2>/dev/null || echo "")

if [ -n "$TARGET_UID" ] && [ "$TARGET_UID" != "$CURRENT_UID" ]; then
  # Fork modification (Corvus): SHANNON_ALLOW_ROOT deployments — a root service
  # (e.g. a container-hosted worker) spawns the CLI, so the remap variables carry
  # UID/GID 0. groupadd/useradd cannot create a second UID/GID 0; under set -e the
  # remap path would abort and the container would die at startup (observed exit
  # code 4). The CLI-side opt-in already documents the root-owned-files trade-off;
  # the only consistent container behavior is to run as root directly.
  if [ "$TARGET_UID" = "0" ]; then
    exec "$@"
  fi

  userdel pentest 2>/dev/null || true
  groupdel pentest 2>/dev/null || true

  groupadd -g "$TARGET_GID" pentest
  useradd -u "$TARGET_UID" -g pentest -s /bin/bash -M pentest

  chown -R pentest:pentest /app/sessions /app/workspaces /tmp/.claude /tmp/.pi
fi

exec su -m pentest -c "exec $*"

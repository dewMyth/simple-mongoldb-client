#!/usr/bin/env bash
# Runs a command (e.g. `npx playwright test`) on a headless Linux CI box: a virtual display, plus an
# unlocked gnome-keyring in a D-Bus session so Electron's safeStorage can encrypt saved passwords
# (the app refuses to store secrets without it). Needs: xvfb, xauth, dbus-x11, gnome-keyring.
# Exits with the command's own status.
set -uo pipefail
status_file=$(mktemp)
dbus-run-session -- bash -c '
  echo -n "ci" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" "${@:2}"
  echo $? > "$1"
' bash "$status_file" "$@"
outer=$?
status=$(cat "$status_file" 2>/dev/null || echo 127)
rm -f "$status_file"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::notice::linux-e2e: command exited $status (session $outer)"; fi
exit "$status"

#!/usr/bin/env bash
# Runs a command (e.g. `npx playwright test`) on a headless Linux CI box: a virtual display, plus an
# unlocked gnome-keyring in a D-Bus session so Electron's safeStorage can encrypt saved passwords
# (the app refuses to store secrets without it). Needs: xvfb, dbus-x11, gnome-keyring.
set -euo pipefail
exec dbus-run-session -- bash -c '
  echo -n "ci" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" "$@"
' bash "$@"

#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/build-android-ascii.ps1" "$@"

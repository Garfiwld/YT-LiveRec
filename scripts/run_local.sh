#!/bin/bash
# Local equivalent of record-live.yml: reads channel handles from a .txt
# file and checks/records each one in parallel, using the same
# check_and_record.sh logic the GitHub Actions workflows use.
#
# Usage: ./scripts/run_local.sh [channels-file]   (default: scripts/channels.txt)
set -e
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
file="${1:-$dir/channels.txt}"

while IFS= read -r handle; do
  [ -z "$handle" ] && continue
  case "$handle" in \#*) continue ;; esac
  "$dir/check_and_record.sh" "https://www.youtube.com/${handle}/live" &
done < "$file"

wait

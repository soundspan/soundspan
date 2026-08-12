#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <release-version>" >&2
  exit 1
fi

release_version="$1"
if [ -z "$release_version" ]; then
  echo "Release tag is missing." >&2
  exit 1
fi
if [[ "$release_version" == v* ]]; then
  echo "Release tags must be plain semantic versions without a 'v' prefix (example: 1.2.3)." >&2
  exit 1
fi
if ! [[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must be container-tag-compatible semantic versioning without build metadata (example: 1.2.3 or 1.2.3-rc.1)." >&2
  exit 1
fi

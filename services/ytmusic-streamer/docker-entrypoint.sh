#!/bin/sh
set -e
# Legacy /data volumes may be root-owned (created before this image ran as a
# non-root user; older images papered over that with chmod 777). When the
# container starts as root (plain docker/compose default), repair ownership
# and drop privileges to the ytmusic user via setpriv (util-linux, present in
# python:*-slim). Under Kubernetes runAsUser/fsGroup the process starts
# non-root already and this is a no-op passthrough.
if [ "$(id -u)" = "0" ]; then
  chown -R ytmusic:ytmusic /data
  exec setpriv --reuid=ytmusic --regid=ytmusic --init-groups "$@"
fi
exec "$@"

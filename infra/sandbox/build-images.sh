#!/usr/bin/env bash
# Builds the sandbox images locally (or on the VM). Idempotent.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
for major in ${NODE_MAJORS:-18 20 22 24}; do
  echo "== autodeploy-build:node${major}"
  docker build -q --build-arg NODE_MAJOR="$major" -t "autodeploy-build:node${major}" -f "$here/Dockerfile.build" "$here"
done
echo "== autodeploy-validator"
docker build -q -t autodeploy-validator:latest "$here/validator"
echo "== autodeploy-egress"
docker build -q -t autodeploy-egress:latest "$here/egress"

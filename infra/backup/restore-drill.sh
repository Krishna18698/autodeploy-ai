#!/usr/bin/env bash
# Restore drill: proves the latest backup actually restores, and how long it
# takes. Restores into a throwaway Postgres, checks row counts, reports RTO.
#   AGE_IDENTITY=~/.config/age/backup.key ./restore-drill.sh path/to/backup.sql.gz.age
set -euo pipefail
file=${1:?backup file}
: "${AGE_IDENTITY:?path to the age private key}"
start=$(date +%s)
docker run -d --rm --name ad-restore-drill -e POSTGRES_PASSWORD=drill -e POSTGRES_USER=autodeploy -e POSTGRES_DB=autodeploy postgres:17-alpine >/dev/null
trap 'docker rm -f ad-restore-drill >/dev/null 2>&1' EXIT
until docker exec ad-restore-drill pg_isready -U autodeploy >/dev/null 2>&1; do sleep 1; done
docker exec ad-restore-drill psql -U autodeploy -d autodeploy -qc "create role app_user nologin" >/dev/null
age -d -i "$AGE_IDENTITY" "$file" | gunzip | docker exec -i ad-restore-drill pg_restore -U autodeploy -d autodeploy --no-owner
counts=$(docker exec ad-restore-drill psql -U autodeploy -d autodeploy -Atc \
  "select 'projects=' || count(*) from projects union all select 'deployments=' || count(*) from deployments union all select 'events=' || count(*) from deployment_events")
echo "restored in $(( $(date +%s) - start ))s · $(echo "$counts" | tr '\n' ' ')"

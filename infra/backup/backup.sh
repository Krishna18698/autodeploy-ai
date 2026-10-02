#!/usr/bin/env bash
# Nightly: pg_dump → gzip → age-encrypt (public key only on the VM) → B2.
# Retention: 7 daily + 4 weekly (Sundays). Run from cron on the VM.
set -euo pipefail
cd "$(dirname "$0")/../deploy"
set -a; source .env.prod; set +a
: "${BACKUP_AGE_RECIPIENT:?age public key required}"
stamp=$(date -u +%Y-%m-%dT%H%MZ)
kind=$([ "$(date -u +%u)" = 7 ] && echo weekly || echo daily)
out="/tmp/autodeploy-${stamp}.sql.gz.age"
docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U autodeploy --format=custom --compress=0 autodeploy | gzip -9 | age -r "$BACKUP_AGE_RECIPIENT" > "$out"
docker run --rm -v /tmp:/tmp -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
  amazon/aws-cli s3 cp "$out" "s3://${S3_BUCKET}/backups/${kind}/$(basename "$out")" --endpoint-url "$S3_ENDPOINT" --only-show-errors
rm -f "$out"
echo "✓ backup ${kind}/${stamp} ($(date -u))"
# Prune: keep the newest 7 daily and 4 weekly objects.
for k in daily:7 weekly:4; do
  prefix=${k%%:*}; keep=${k##*:}
  docker run --rm -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" amazon/aws-cli \
    s3 ls "s3://${S3_BUCKET}/backups/${prefix}/" --endpoint-url "$S3_ENDPOINT" | sort | head -n -"$keep" | awk '{print $4}' |
    while read -r f; do
      [ -n "$f" ] && docker run --rm -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" amazon/aws-cli \
        s3 rm "s3://${S3_BUCKET}/backups/${prefix}/${f}" --endpoint-url "$S3_ENDPOINT" --only-show-errors
    done
done

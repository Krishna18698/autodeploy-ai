# Runbook: rotate the encryption master key

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Append to `ENCRYPTION_KEYS` with the next version: `1:<old>,2:<new>`; deploy.
3. New secrets use v2 immediately. The leader's `key-rotation` task re-wraps
   data keys still on v1 (values themselves are never re-encrypted).
4. When `select count(*) from env_vars where key_version < 2` and the same for
   `webhook_endpoints` are both 0, remove `1:<old>` and deploy again.

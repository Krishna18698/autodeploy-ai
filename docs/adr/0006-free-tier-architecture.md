# 6. ₹0 recurring cost

Status: accepted · 2026-09

| Need | Choice | Why this one |
|---|---|---|
| Compute | Oracle Always Free A1 (2 OCPU / 12 GB) | only indefinite free VM with enough RAM; cannot bill on the free tier |
| DB / cache / events | self-hosted Postgres 17, Valkey 8, Kafka 4.2 | Neon's compute hours run out under 24/7 polling; Upstash command quotas too small |
| Object storage | Backblaze B2 with $0 daily caps | real hard spending cap; S3-compatible |
| Edge | Cloudflare Workers + KV, wildcard route | free plan supports wildcard DNS + routes on a custom domain |
| Dashboard | Vercel Hobby | pauses instead of billing |
| AI | NVIDIA build.nvidia.com → OpenRouter :free; Workers AI classifier | free without a card; providers behind one interface |

Every provider sits behind an interface (executor, route store, storage, AI
provider), so a tier change is configuration plus one adapter.

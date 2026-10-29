# ADR-0009: Host the demo on one Azure VM with Docker Compose

## Status
Accepted (2026-10-28). Decides the hosting left open in [dev-spec](../specs/dev-spec.md) §21 (T20, #31).

## Date
2026-10-28

## Context
- **What the app needs from a host:**
  - A live rating or Time Machine re-rate holds its request open for 40–60 s, and the event stream stays open.
  - Rating runs, quarter jobs and the rate limits live inside the API process.
  - Postgres with pgvector.
  - It must stay up, free for judges, until judging ends on Dec 15.
- **The database is small:** the showcase export is under 2 MB.
- **Ranked options (§21):**
  - Nebius Serverless needs Nebius AI Cloud credits we don't have.
  - Free tiers sleep (Render after about 15 minutes, Hugging Face Spaces after 48 hours), cold-start in a minute, kill in-process runs, and Render's free Postgres expires after 30 days.
  - Splitting the frontend onto Vercel adds a second platform and a 120 s proxy limit.
- **Credits:** the team approved the owner's personal Azure credit ($150 a month, Visual Studio subscription) for hosting.

## Decision
- **One Azure VM** (B2s: 2 vCPU, 4 GB, Ubuntu 24.04, static IP) runs the whole stack with Docker Compose (`deploy/compose.yml`):
  - Postgres 16 with pgvector;
  - the API, one uvicorn process that runs migrations on start;
  - the standalone Next.js server;
  - Caddy.
- **Caddy** gets a Let's Encrypt certificate for the address and routes `/api/*` straight to the API. Long requests and the event stream skip the Next.js proxy, and the API sees each visitor's address with `TRUSTED_PROXY_HOPS=1`.
- **The address** is the VM's free Azure DNS name (`wildworth.<region>.cloudapp.azure.com`) unless the team buys a domain; either way it's just `SITE_ADDRESS`.
- **Deploys are pulled, not pushed, and on demand:** after a merge, `deploy/update.sh` on the VM deploys `main`, waits for both health checks, and rolls back to the previous commit if they fail (cron can run it instead). GitHub needs no secrets and no access to the VM.
- **Data comes from a laptop's database:** `deploy/export-db.sh` prunes visitor sandboxes from a scratch copy (`python -m app.cli prune-sandboxes`) and dumps the template and live worlds, so every ID and the ledgers come along. `deploy/backup.sh` keeps nightly dumps on the VM.

## Consequences
- **Good:**
  - Always on and no cold starts, with no request-length limits beyond ours.
  - One place to look, and about $40 a month, well inside the credit.
  - A merge goes live with one command, with an automatic rollback.
  - Secrets stay on the VM, in `deploy/.env` and `deploy/secrets/`.
- **Bad:**
  - One VM is a single point of failure.
  - We patch nothing but Ubuntu's automatic security updates.
  - Backups stay on the same disk.
  - Acceptable for a demo until Dec 15; Azure disk snapshots are the next step if it matters.
- **Revisit:** if Nebius AI Cloud credits arrive, the same Compose stack runs on a Nebius VM unchanged.

# Deploying WildWorth

The demo runs on **one Azure VM** with Docker Compose ([ADR-0009](adr/0009-one-vm-on-azure.md)): Postgres with pgvector, the API, the web app and Caddy, which serves HTTPS and routes `/api` straight to the API. After a merge, one command on the VM (`deploy/update.sh`) deploys `main`, and it goes back by itself if the new version isn't healthy.

```
visitor ──HTTPS──▶ Caddy ─┬─ /api/* ─▶ API (FastAPI, uvicorn) ─▶ Postgres + pgvector
                          └─ the rest ─▶ web (Next.js)  ── server-side calls ─▶ API
```

| File | What it does |
|---|---|
| `deploy/compose.yml` | The stack; only Caddy publishes ports |
| `deploy/Caddyfile` | HTTPS (Let's Encrypt), `/api` to the API, the rest to the web app |
| `deploy/.env.example` | Production settings; copy to `deploy/.env` on the VM |
| `deploy/update.sh` | Deploy `main` or one commit, check health, roll back if unhealthy |
| `deploy/export-db.sh` | On a laptop: the local database minus visitor sandboxes, as a dump |
| `deploy/import-db.sh` | On the VM: load that dump |
| `deploy/backup.sh` | On the VM: nightly dump, keeps the last 7 |
| `backend/Dockerfile`, `frontend/Dockerfile` | The API and web images |

Cost on a Visual Studio subscription's $150 monthly credit: a B2s VM (2 vCPU, 4 GB) about $30, the static IP about $4, a 64 GB disk about $5; about **$40 a month**.

## 1. Create the VM (once)

With the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) on your laptop:

```bash
az login
az account set --subscription "<your subscription>"
az group create --name wildworth --location westus2
az vm create --resource-group wildworth --name wildworth --image Ubuntu2404 --size Standard_B2s \
  --admin-username azureuser --generate-ssh-keys --os-disk-size-gb 64 \
  --public-ip-sku Standard --public-ip-address-allocation static \
  --public-ip-address-dns-name wildworth --nsg-rule SSH
az vm open-port --resource-group wildworth --name wildworth --port 80,443 --priority 900
# SSH from your own address only
az network nsg rule update --resource-group wildworth --nsg-name wildworthNSG \
  --name default-allow-ssh --source-address-prefixes "$(curl -s https://ifconfig.me)/32"
```

- **Address:** the VM gets `wildworth.westus2.cloudapp.azure.com` for free. For your own domain, add an A record for the VM's IP (`az vm show -d -g wildworth -n wildworth --query publicIps -o tsv`); with Cloudflare, keep it "DNS only", because its proxy cuts requests at 100 s and hides visitors' addresses from the rate limits.
- **Budget alert:** Cost Management → Budgets → $100 a month, with an email alert.
- **If a policy blocks SSH from the internet,** run each command below with `az vm run-command invoke --resource-group wildworth --name wildworth --command-id RunShellScript --scripts "<command>"`.

## 2. Prepare the VM (once)

```bash
ssh azureuser@wildworth.westus2.cloudapp.azure.com
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# 2 GB of swap: building the web app needs more than the B2s's 4 GB at peak
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
exit   # log in again so the docker group applies
```

```bash
git clone https://github.com/melvin1117/wildworth.git ~/wildworth && cd ~/wildworth
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
nano deploy/.env          # the address, generated secrets and the API keys
mkdir -m 700 deploy/secrets
```

From your laptop, copy the Earth Engine service-account key, then let the API's container user read it (the folder stays private):

```bash
scp ee-key.json azureuser@wildworth.westus2.cloudapp.azure.com:~/wildworth/deploy/secrets/ee-service-account.json
ssh azureuser@wildworth.westus2.cloudapp.azure.com chmod 644 wildworth/deploy/secrets/ee-service-account.json
```

Keys live only in `deploy/.env` and `deploy/secrets/` on the VM: never in git, never in an image, never sent to the browser.

## 3. Load the data

The showcase (communities, listings, ratings, trades, history and their logged model calls) comes from a laptop's database. On the laptop:

```bash
docker compose up -d
deploy/export-db.sh wildworth.dump          # the template and live worlds; visitor sandboxes left out
scp wildworth.dump azureuser@wildworth.westus2.cloudapp.azure.com:~/
```

On the VM (it replaces the deployed database, visitors' sandboxes included):

```bash
cd ~/wildworth && deploy/import-db.sh ~/wildworth.dump
```

Every ID comes along, so the ledgers still verify. `LLM_BUDGET_USD` counts the imported calls too (about $1.40 today), which is why it's set above the deployment's own $15.

## 4. Start

```bash
cd ~/wildworth && FORCE=1 deploy/update.sh    # the first build takes 5–10 minutes
```

Then open the address: the welcome page loads, **Try it yourself** opens a sandbox, and `https://<address>/api/healthz` answers `{"status": "ok"}`.

## 5. Backups, and updating after a merge

Nightly backups: `crontab -e` on the VM, then add

```
30 3 * * * cd ~/wildworth && deploy/backup.sh >> ~/backup.log 2>&1
```

To deploy after a merge to `main`, from your laptop:

```bash
ssh azureuser@wildworth.westus2.cloudapp.azure.com 'cd ~/wildworth && deploy/update.sh'
```

- **Updates:** on demand. `main` only changes through reviewed PRs with green CI, and the VM pulls it; nothing outside can push into the VM. It takes a minute, or a few when an image rebuilds. To have it automatic instead, add `*/30 * * * * cd ~/wildworth && deploy/update.sh >> ~/deploy.log 2>&1` to the crontab (a run that finds nothing new only fetches).
- **A bad version:** if the API or the web app isn't healthy within 5 minutes, `update.sh` goes back to the commit that ran before and skips the bad one until `main` moves on.
- **Roll back on purpose:** `deploy/update.sh <commit sha>` pins that commit (later runs keep it); `deploy/update.sh --unpin` follows `main` again.
- **Settings change:** edit `deploy/.env`, then `FORCE=1 deploy/update.sh`.
- **Restore a backup:** `deploy/import-db.sh ~/backups/<file>.dump`.

## Security

- **Secrets stay on the VM.**
  - `deploy/.env` (API keys, generated secrets, the database password) is readable only by its owner (`chmod 600`).
  - The Earth Engine key sits in `deploy/secrets/`, a folder only its owner can enter (`chmod 700`).
  - Both are git-ignored and never baked into an image.
  - The API reads the key through a read-only mount, so the container can't change it.
  - The file itself is `644` only so the API's non-root container user can read it; the private folder keeps everyone else out.
- **Nothing secret reaches the browser.** Only the API uses the Nebius, Tavily and Earth Engine keys; the web app gets just the API's internal address.
- **What's reachable:**
  - Only ports 80 and 443 are open to everyone, and port 80 only redirects to HTTPS.
  - SSH is open to your own address only, with a key; Azure turns off password login for key-based VMs.
  - Postgres isn't reachable from outside the VM.
- **On the machine:**
  - The API and the web app run as non-root users.
  - Azure encrypts the disk at rest.
  - Ubuntu installs security updates by itself.
- **The app's own guards:**
  - secure, HTTP-only cookies;
  - writes accepted only from the site's own origin;
  - per-visitor rate limits;
  - hard caps on model and search spend.
- **Least privilege:**
  - Give the Earth Engine service account only the Earth Engine roles it needs (Earth Engine Resource Viewer, and Service Usage Consumer).
  - Use separate keys for the deployment, not the ones on laptops.
- **After setup:** delete the local copies once the VM has them (the bundle on your laptop, and `~/wildworth.dump` on the VM once loaded).
- **After judging ends (Dec 15):** rotate or revoke every key, then delete the resource group.

## Operating it

- **Logs:** `docker compose -f deploy/compose.yml logs -f backend` (also `web`, `caddy`); each service keeps 50 MB.
- **Spend:** `LLM_BUDGET_USD` caps model spend logged in the database, with `LLM_RESERVE_USD` kept for judging; each sandbox gets `SANDBOX_LLM_BUDGET_USD` and live ratings are capped per sandbox and per day. Past a cap, a rating still comes out with the tested formulas' numbers, without the AI write-up. News Scout pauses below `TAVILY_MIN_CREDITS_LEFT`. Check the Token Factory and Tavily consoles too.
- **Earth Engine:** live computations run one at a time and only for newly drawn boundaries (every boundary is cached); the non-commercial Community tier allows 150 EECU-hours a month (see the quota page in Google Cloud).
- **Try it locally first:** in `deploy/.env` set `SITE_ADDRESS=http://localhost:8088`, `SITE_URL` and `ALLOWED_ORIGINS` to the same, `HTTP_PORT=8088` and `HTTPS_PORT=8443`, then steps 3 and 4 on your laptop (`docker compose -f deploy/compose.yml down -v` removes it).
- **After judging (Dec 15):** `az group delete --name wildworth` removes everything.

# Deploying Paceo on an old laptop

One container runs the API, the background jobs and the PWA. Postgres runs next to it. HTTPS comes
from a **Cloudflare Tunnel**, so the laptop needs **no open router ports**. Caddy is the alternative
for a VM with a public IP. The whole stack fits in 1–2 GB of RAM.

```
phone (PWA) ──HTTPS──► Cloudflare ──tunnel──► cloudflared ──► api:3000 ──► postgres:5432
                                                             (Fastify + pg-boss + web/dist)
```

| File | What it is |
|---|---|
| `Dockerfile` | Multi-stage pnpm build. It bundles `apps/api` with esbuild, builds `apps/web` when it exists, and ships only the production `node_modules`. |
| `docker-compose.yml` | `api` + `postgres:16`, plus optional profiles: `tunnel` (cloudflared) or `caddy` |
| `Caddyfile` | Used only by the `caddy` profile |
| `.env.example` | Lists every setting. Copy it to `.env`. |
| `backup.sh` | Nightly `pg_dump` with 14 daily and 8 weekly copies, and an optional rclone copy off the box |

## 1. Prepare the laptop (Ubuntu Server 24.04 LTS)

1. Install Ubuntu Server and enable **OpenSSH** in the installer. Use a wired connection if you can.
2. From your own computer, set up key-only SSH:
   ```bash
   ssh-copy-id kenny@<laptop-ip>
   # then on the laptop:
   sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
   sudo systemctl restart ssh
   ```
3. Turn on automatic security updates:
   ```bash
   sudo apt update && sudo apt -y upgrade
   sudo apt -y install unattended-upgrades
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```
4. **Keep the laptop running with the lid closed**, and stop it from sleeping:
   ```bash
   sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/; s/^#\?HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/' /etc/systemd/logind.conf
   sudo systemctl restart systemd-logind
   sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
   ```
   Optional: blank the console screen after 1 minute to save power. Add `consoleblank=60` to
   `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, then run `sudo update-grub`.
5. In the BIOS, set **"Power on after AC loss"** (sometimes called "Restore on AC power") if the
   laptop has it. The battery acts as a small UPS.
6. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER   # log out and back in
   docker compose version
   ```
   Docker starts on boot, and the containers use `restart: unless-stopped`, so the stack comes back
   after a power cut.
7. Limit the size of the systemd journal: `sudo journalctl --vacuum-size=200M`. Docker's own logs
   are already capped by the compose file (10 MB × 3 per container).

## 2. Configure

```bash
git clone https://github.com/KungFuKennyOG/paceo.git ~/paceo
cd ~/paceo/deploy
cp .env.example .env && chmod 600 .env
openssl rand -hex 24      # → POSTGRES_PASSWORD
openssl rand -base64 48   # → SESSION_SECRET
openssl rand -base64 32   # → PACEO_ENCRYPTION_KEY
nano .env
```

**Save `PACEO_ENCRYPTION_KEY` in your password manager.** It encrypts everyone's intervals.icu API
key. If you lose it, the backups still restore, but every user has to reconnect intervals.icu.

## 3. Build and start

Building the web app needs about 1.5 GB of RAM. On a 2 GB laptop, build it there:

```bash
docker compose build
docker compose run --rm --no-deps api node dist/cli/vapid-keys.js   # paste both lines into .env
docker compose up -d
docker compose ps        # both services should become "healthy"
curl -s localhost:3000/api/health
```

On a 1 GB machine, build on your dev machine and copy the image across instead:

```bash
docker build -f deploy/Dockerfile -t paceo-api:latest .        # from the repo root
docker save paceo-api:latest | gzip | ssh kenny@<laptop> 'gunzip | docker load'
ssh kenny@<laptop> 'cd ~/paceo/deploy && docker compose up -d --no-build'
```

Database migrations run automatically when the container starts. An advisory lock stops two
instances from migrating at the same time.

## 4. HTTPS with Cloudflare Tunnel (recommended for a home laptop)

You need a domain that uses Cloudflare DNS.

1. In Cloudflare **Zero Trust → Networks → Tunnels**, choose **Create a tunnel**, pick
   **Cloudflared** and name it `paceo`.
2. Copy the tunnel **token** into `TUNNEL_TOKEN` in `.env`. You don't need the dashboard's install
   command, because compose runs cloudflared.
3. Under **Public Hostname**, add `paceo.yourdomain.com`. Set the service type to **HTTP** and the
   URL to **`api:3000`**.
4. Set `PUBLIC_URL=https://paceo.yourdomain.com` in `.env`, then run:
   ```bash
   docker compose --profile tunnel up -d
   ```
5. Open `https://paceo.yourdomain.com`. HTTPS is required for the service worker, the PWA install
   and web push.

No router ports are opened. The API is bound to `127.0.0.1:3000` on the laptop only.

**Alternative: Caddy on a VM.** Point the domain's DNS at the VM. Set `DOMAIN` in `.env`, open ports
80 and 443, and run `docker compose --profile caddy up -d`. Caddy gets the certificates itself.

## 5. First admin and invites

```bash
docker compose exec api node dist/cli/create-invite.js
```

This prints a single-use code that is valid for 7 days. On an empty database, **whoever registers
first becomes the admin**, so use this first code yourself. After that, create invites for friends
from the app (the admin endpoint `POST /api/admin/invites`), or with the same command.

## 6. Backups

`backup.sh` writes `pg_dump -Fc` archives to `$BACKUP_DIR`, checks that each archive can be read,
and keeps 14 daily and 8 weekly copies. The dump contains everything: users, plans, FIT files (they
are stored in Postgres) and the job queue.

```bash
sudo mkdir -p /var/backups/paceo && sudo chown $USER /var/backups/paceo
./backup.sh                       # try it once
crontab -e
# 30 4 * * * /home/kenny/paceo/deploy/backup.sh >> /home/kenny/paceo-backup.log 2>&1
```

Run it at 04:30, after the nightly jobs that start at 03:00 local time.

**Copy backups off the box.** A backup that lives on the same laptop dies with the laptop.

1. `sudo apt install rclone`, then run `rclone config`.
2. Add a remote for Backblaze B2, Cloudflare R2, a Hetzner Storage Box, or SFTP to another machine.
3. Wrap it in a **crypt** remote, e.g. `paceo-crypt:` → `b2:my-bucket/paceo`, so the copies are
   encrypted.
4. Set `RCLONE_REMOTE=paceo-crypt:` in `.env`. Each run then ends with `rclone sync`.

**Test a restore every month**, into a scratch database:

```bash
docker compose exec -T postgres createdb -U paceo paceo_restore_test
docker compose exec -T postgres pg_restore -U paceo -d paceo_restore_test --no-owner < /var/backups/paceo/daily/<latest>.dump
docker compose exec -T postgres psql -U paceo -d paceo_restore_test -c 'select count(*) from users'
docker compose exec -T postgres dropdb -U paceo paceo_restore_test
```

**Full restore** after losing the machine: set up a new box with the same `.env` (the same
`PACEO_ENCRYPTION_KEY`). Run `docker compose up -d postgres`, then
`pg_restore --clean --if-exists -U paceo -d paceo < dump`, then `docker compose up -d`.

## 7. Updates

```bash
cd ~/paceo && git pull
cd deploy && docker compose build api && docker compose up -d
docker image prune -f
```

Migrations apply on start. To roll back, check out the previous commit and rebuild. Migrations only
move forward, so restore a backup if a schema change has to be undone.

Other day-to-day commands:
- Logs: `docker compose logs -f api`
- Uptime monitoring: set `HEALTHCHECK_PING_URL` to a healthchecks.io check with a 15-minute period.
  The job dispatcher pings it every 15 minutes, so a missed ping means jobs stopped running.
- Rotating the encryption key: set `PACEO_ENCRYPTION_KEY_PREVIOUS=<old version>:<old key>`, put the
  new key in `PACEO_ENCRYPTION_KEY` and bump `PACEO_ENCRYPTION_KEY_VERSION`. New writes use the new
  key and old rows still decrypt. A bulk re-encrypt script is not written yet.

## Memory budget

| Service | Limit | Typical |
|---|---|---|
| postgres (shared_buffers 128 MB) | 512 MB | 150–300 MB |
| api (`--max-old-space-size=256`) | 512 MB | 120–250 MB |
| cloudflared or caddy | 128 MB | 20–40 MB |

The stack fits comfortably on a 2 GB laptop with room left for the OS.

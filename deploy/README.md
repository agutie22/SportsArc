# Running the SportsArc beta

The private beta runs as one Docker Compose stack. You run it on your own
machine first, then move the same stack to the Hostinger VPS. Production
later is the same kit on another host with different secrets.

Everything lives in `deploy/`:

| file | what it is |
|---|---|
| `compose.yml` | the stack (below) |
| `.env.beta.example` | every setting, commented; your copy is `.env` (never committed) |
| `local.sh` | run it on your machine: `deploy/local.sh up` |
| `deploy.sh` | rolling deploys, rollbacks and status on the VPS |
| `bootstrap-vps.sh` | one-time setup of a fresh Ubuntu VPS |
| `Caddyfile` | HTTPS, load balancing, request IDs, security headers |
| `backup/` | nightly database dumps, restore, optional S3 copy |
| `observability/` | Grafana dashboards and alerts, Loki, Alloy, Prometheus |

What runs:

- **caddy** is the only thing reachable from outside (ports 80/443, or 8080 locally).
- **app1** and **app2** are two copies of the app (API + website). A deploy
  restarts them one at a time, so the site stays up.
- **migrate** applies database migrations before the apps start, then exits.
- **postgres** is the database (profile `db`).
- **backup** writes a database dump every night.
- **grafana**, **loki**, **alloy**, **prometheus** and **events** handle logs,
  dashboards and alerts (profile `observability`).
- **tunnel** gives you a public https URL for phone testing (profile `tunnel`, local only).
- **backup-s3** copies backups to a bucket (profile `s3`, off by default).

Photos people upload are stored on disk, in a volume both app containers share.

---

## 1. Run it on your machine

### Install Docker (Linux)

On Ubuntu or Debian, with Docker's own packages:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"     # then log out and back in
docker compose version              # must print v2.20 or newer
```

(On a Mac, install Docker Desktop instead. Everything works except the disk
and memory numbers in Grafana, which describe Docker's VM rather than your Mac.)

### Start it

From the repo root:

```bash
deploy/local.sh up
```

The first run:

1. writes `deploy/.env` from `.env.beta.example`, generating the session
   secret, the database password and the Grafana password;
2. builds the app image from your checkout (a few minutes the first time);
3. starts Postgres, runs the migrations, starts both app containers, Caddy,
   the backup job and the monitoring stack;
4. prints the addresses:
   - SportsArc: <http://localhost:8080>
   - Grafana: <http://localhost:3001> (user `admin`; the password is
     `GRAFANA_ADMIN_PASSWORD` in `deploy/.env`)

### Sign in

The beta is invite-only. Put your own email in `deploy/.env` first:

```bash
ADMIN_EMAILS=you@example.com
```

then `deploy/local.sh up` again. Until Brevo is set up (section 3), no
email is sent: login codes print to the app log instead.

```bash
deploy/local.sh otp          # shows the latest [otp] lines
```

Once signed in, invite testers from **Invite testers** in the account menu.

### Everyday commands

```bash
deploy/local.sh ps               # what is running
deploy/local.sh logs app1 app2   # follow logs (Ctrl-C to stop)
deploy/local.sh stats            # memory and CPU per container
deploy/local.sh up               # after a git pull: rebuild and restart
deploy/local.sh down             # stop everything; data is kept
deploy/local.sh destroy          # stop and delete the database, uploads and logs
deploy/local.sh compose <args>   # any docker compose command for this stack
```

### Demo data

`scripts/seed.ts` fills the database with Los Angeles pickup games in every
state the app has: open, full with a waitlist, hosted by someone who does
not play, cancelled, check-in open now, sides being set, locked with no
result yet, recorded and still correctable, and settled as a win, a draw or
not played (each with a recap), plus earlier settled games behind each
venue's regulars ladder. About 30 fictional people, posts and follows come
with them. With `--me` it puts your own account into those games as player,
host (playing or not), co-host and seated player, so every screen has
something for you to do; on an invite-only stack it also invites that email.

The app image does not contain `scripts/`, so mount it. From the repo root,
with the stack up:

```bash
deploy/local.sh compose run --rm --no-deps -v "$PWD/scripts:/app/scripts:ro" \
  app1 node --import=tsx scripts/seed.ts --me you@example.com
```

- Run it again to refresh: it replaces the earlier demo data. "Check-in
  open now" and "sides being set" only hold for about 50 minutes.
- `--reset` instead of `--me ...` removes the demo data and stops.
- Demo accounts all end in `@demo.sportsarc.test`; reset removes only
  those, their games and the venues nobody else uses. Your own account
  stays.
- The seed refuses to run when `NODE_ENV=production` (the stack once Brevo
  is set up). Add `-e SEED_ALLOW_PRODUCTION=1` after `--no-deps` if you
  really mean to seed that database. Never do it on the VPS.
- Outside Docker: `node --env-file=.env --import=tsx scripts/seed.ts --me you@example.com`.

The summary at the end lists each game's state, its id and its API path.

## 2. Test on your phone (tunnel)

Check-in at a court needs the phone's location, and browsers only give
location to https sites. The tunnel gives your local stack a public https
address through Cloudflare, with no account and no domain:

```bash
deploy/local.sh tunnel
# ==> Public URL: https://some-random-words.trycloudflare.com
```

Open that URL on your phone. Things to know:

- **The URL changes every time the tunnel starts.** Run `deploy/local.sh url`
  to see the current one.
- Anyone who has the URL can reach your stack while it runs. Stop it when you
  are done: `deploy/local.sh compose stop tunnel`.
- Your computer has to stay on and online.

## 3. Email login codes (Brevo)

1. Create a Brevo account. Under **Senders, domains & dedicated IPs** >
   **Senders**, add and verify the address mail will come from (a Gmail
   address works while SportsArc has no domain of its own).
2. Under **SMTP & API** > **API keys**, create a key (`xkeysib-...`).
3. In `deploy/.env`:

   ```bash
   EMAIL_PROVIDER=brevo
   BREVO_API_KEY=xkeysib-...
   EMAIL_FROM="SportsArc <the-verified-address@gmail.com>"
   NODE_ENV=production
   ```

4. `deploy/local.sh up`.

In production mode the app refuses to start without these three settings, so
the VPS always sends real email.

## 4. Alerts on Telegram

Grafana watches the logs and metrics and sends alerts to a Telegram chat.

1. In Telegram, open a chat with **@BotFather**, send `/newbot`, and follow
   the prompts. It replies with a token like `123456789:AA...`. That is
   `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot (or add it to a group and send a message
   there), so it can write to that chat.
3. Find the chat ID. In a browser, open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and look for
   `"chat":{"id":...}`. That number is `TELEGRAM_CHAT_ID` (a group's ID
   starts with `-`).
4. In `deploy/.env` (or `/opt/sportsarc/.env` on the VPS):

   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_CHAT_ID=987654321
   ```

5. Restart Grafana: `deploy/local.sh compose up -d grafana` (VPS:
   `./deploy.sh compose up -d grafana`).
6. Check it: in Grafana, **Alerting** > **Contact points** > `sportsarc-alerts` > **Test**.

**Email or Discord instead:** set `ALERT_CHANNEL=email` with `ALERT_EMAIL_TO`
and the `GF_SMTP_*` settings (Brevo's SMTP relay works:
`GF_SMTP_HOST=smtp-relay.brevo.com:587`, your Brevo SMTP login and key), or
`ALERT_CHANNEL=discord` with `DISCORD_WEBHOOK_URL` (a channel's
**Integrations** > **Webhooks**). With nothing configured, alerts still show
under **Alerting** > **Alert rules** in Grafana.

### What is monitored

Dashboard: Grafana > **Dashboards** > **SportsArc** > **SportsArc overview**:
requests per second, 5xx rate, latency, healthy app containers, 5xx by route,
errors by source (server, browser, background jobs), busiest and slowest
routes, disk and memory, container events, and the latest errors. Open an
error line to follow its request ID to every other line of the same request,
and a browser error to the server lines of the API call that failed.

Alerts:

| alert | fires when |
|---|---|
| Server errors | more than 5 server errors in 5 minutes |
| Background job failing | a job logs an error or a failed tick (per job) |
| Browser errors | more than 20 browser error reports in 15 minutes |
| App 5xx responses | 5 or more 5xx responses in 5 minutes |
| Unstructured app errors | plain-text error lines from the app (e.g. a crash before logging starts) |
| Edge 5xx above 5% | Caddy's 5xx share passes 5% (includes "no app container answered") |
| App container failing health checks | Caddy has taken an app container out of rotation for 1 minute |
| Docker health check failing | any container reports unhealthy |
| Container crashed or restarting | a container exits with an error or runs out of memory |
| Disk nearly full | a disk is more than 85% full for 10 minutes |
| Database backup failed | the nightly backup logged an error |

Thresholds live in `deploy/observability/grafana/provisioning/alerting/rules.yml`.

## 5. The blockchain (testnet)

The chain layer is on from day one, on testnets only. Fill in the chain block
of `.env` (`WEB3_CHAIN`, `WEB3_RPC_URL`, `TESTNET_PRIVATE_KEY`, the contract
addresses, `CIRCLE_APP_ID`, `CIRCLE_API_KEY`). How to deploy the contracts and
where the addresses come from: [CONTRACTS.md](CONTRACTS.md).
`TESTNET_PRIVATE_KEY` must be a throwaway testnet key, never one that holds
real funds.

On a server that wrote to an older record contract (RecordAnchor), the
migration that adds `record_entries` drops the old table, and the next
ticks write every entry again to SportsArcRecord, one transaction each
(docs/verified-record.md).

---

## 6. Move to the VPS

### What you need

- The Hostinger VPS with **Ubuntu 24.04** (or 22.04) and its IP address.
  4 GB of RAM is enough (see section 8).
- A domain or subdomain for the beta, e.g. `beta.example.com`.
- The repo on GitHub, with Actions enabled.

### 6.1 Hostinger's firewall

Hostinger has its own firewall in front of the server, managed in hPanel
under your VPS (look for **Firewall**, usually in the security settings; menu
names change). If a firewall is enabled for the server, add rules that
**accept TCP 22, TCP 80, TCP 443 and UDP 443**. If it blocks 80 or 443,
Caddy cannot get a certificate and the site is unreachable, however the
server itself is set up.

### 6.2 Point the domain at the VPS

At your DNS provider (or Hostinger's **Domains** > **DNS / Nameservers**),
add an **A** record for the beta name (e.g. `beta`) with the VPS's IPv4
address. If the VPS has IPv6, add an **AAAA** record too, or none at all;
never a wrong one. Check that it has propagated:

```bash
dig +short beta.example.com      # must print the VPS address
```

### 6.3 Make a deploy key

On your machine, a key pair only GitHub Actions will use:

```bash
ssh-keygen -t ed25519 -N "" -C "sportsarc github-actions" -f ~/.ssh/sportsarc-deploy
```

`~/.ssh/sportsarc-deploy.pub` goes to the server; the private file
`~/.ssh/sportsarc-deploy` becomes a GitHub secret.

### 6.4 Bootstrap the server

Copy `deploy/` over and run the bootstrap as root (Hostinger gives you the
root password or key in hPanel):

```bash
scp -r deploy root@<VPS-IP>:/root/sportsarc-deploy
ssh root@<VPS-IP> "bash /root/sportsarc-deploy/bootstrap-vps.sh \
  --ssh-key '$(cat ~/.ssh/sportsarc-deploy.pub)' \
  --domain beta.example.com --email you@example.com"
```

It prints each step as `changed` or `ok`, and is safe to run again. It
installs Docker; creates the `deploy` user with that key; opens only ports
22, 80 and 443; turns on automatic security updates; adds swap if there is
none; creates `/opt/sportsarc` with the stack and a `.env` (mode 600) whose
secrets it generates; and sets up log rotation. At the end it prints the
server's SSH host key fingerprint; keep that for 6.6.

Optionally add your own key too (`--ssh-key` can be given more than once), so
you can log in as `deploy` for the commands in section 7.

### 6.5 Fill in the server's .env

```bash
ssh root@<VPS-IP>
nano /opt/sportsarc/.env
```

Set at least: `BREVO_API_KEY`, `EMAIL_FROM` (section 3), `ADMIN_EMAILS`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (section 4), and the chain block
(section 5). The bootstrap already set `SITE_ADDRESS` and `DOMAIN`,
`COOKIE_SECURE=1`, `NODE_ENV=production`, the ports and the generated secrets.
Leave `APP_IMAGE` and `APP_TAG` alone; deploys set them.

### 6.6 GitHub

1. **Workflows** live in `.github/workflows/` (`ci.yml`, `deploy.yml`).
   Pushing changes to them needs a token with the `workflow` scope.
2. **Secrets**: repo **Settings** > **Secrets and variables** > **Actions** >
   **New repository secret** (or put them on an environment called `beta`,
   under **Settings** > **Environments**, which also lets you require an
   approval before each deploy):

   | secret | value |
   |---|---|
   | `VPS_HOST` | the VPS IP address (or its DNS name) |
   | `VPS_USER` | `deploy` |
   | `VPS_SSH_KEY` | the whole contents of `~/.ssh/sportsarc-deploy` (the private key) |
   | `VPS_SSH_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 <VPS-IP>` |

   Check `VPS_SSH_KNOWN_HOSTS` before saving it:
   `ssh-keyscan -t ed25519 <VPS-IP> | ssh-keygen -lf -` must print the same
   fingerprint the bootstrap printed. The deploy refuses any other host key.
   GHCR (the image registry) needs no secret; the workflow uses its own token.

### 6.7 First deploy

Push to `main`, or run **Actions** > **Deploy** > **Run workflow**. CI runs
first (typecheck, tests, contract tests, the deploy kit and an image build);
when it passes, **Deploy** builds the image, pushes it to
`ghcr.io/<owner>/sportsarc:<commit>`, copies the stack files to the server
and runs `deploy.sh`. Caddy gets the certificate on the first request (give
it a minute), then:

```bash
curl https://beta.example.com/health/ready     # {"status":"ready",...}
```

Every later push to `main` that passes CI deploys the same way.

**What a deploy does** (`deploy.sh deploy <tag>`):

1. pulls the new image (a failed pull stops here);
2. starts or updates Postgres, Caddy, backups and monitoring, and reloads the
   Caddyfile (a bad one stops here);
3. runs the migrations with the new image. They run in one transaction, so a
   failing migration changes nothing, and the deploy stops with the old
   version still serving;
4. replaces app1, waits until it is healthy and ready and Caddy routes to it,
   then does the same for app2. If a new container never gets healthy, the
   containers already switched go back to the old version and the deploy
   fails;
5. records the release and keeps the previous image for rollback.

Tested here: no failed requests during a deploy, a rollback, or a stopped
app container.

**Migrations must work with the previous release** (add tables and columns;
drop them one release later). During a deploy one old container is still
serving, and a rollback does not undo migrations.

## 7. Running it on the VPS

Log in as `deploy` (or root) and work in `/opt/sportsarc`:

```bash
ssh deploy@<VPS-IP>
cd /opt/sportsarc
./deploy.sh status               # current and previous release, containers
./deploy.sh history              # past releases
```

**Logs:**

```bash
./deploy.sh compose logs -f --tail=100 app1 app2
./deploy.sh compose logs -f caddy
```

or in Grafana (next).

**Grafana** is not on the internet. Open an SSH tunnel from your machine and
browse to <http://localhost:3001>:

```bash
ssh -N -L 3001:127.0.0.1:3001 deploy@<VPS-IP>
```

**Restart** one app container (the other keeps serving):

```bash
./deploy.sh compose restart app1
```

**Roll back** to the previous release (no migrations run):

```bash
./deploy.sh rollback             # or: ./deploy.sh rollback <commit-sha>
```

Or run **Actions** > **Deploy** > **Run workflow** with an older commit sha
as the tag. Only the current and previous images stay on the server; the
workflow pulls any other.

**Backups:** every night at `BACKUP_HOUR_UTC` (03:00 UTC by default) into
`/opt/sportsarc/backups`, keeping the last 7 daily and 4 weekly dumps:

```bash
./deploy.sh compose run --rm backup list
./deploy.sh compose run --rm backup now
```

**Restore a backup** (this replaces the database's contents):

```bash
./deploy.sh compose stop app1 app2
./deploy.sh compose run --rm backup restore daily/sportsarc-20260927T030000Z.dump --yes
./deploy.sh compose start app1 app2
```

To try a dump without touching the live database, restore it into another
database with `--url postgresql://user:pass@host:5432/otherdb`.

**Off-site copies:** create a bucket (AWS S3, Backblaze B2, Cloudflare R2,
Wasabi), fill in the `S3_*` settings in `.env`, add `s3` to
`COMPOSE_PROFILES`, then `./deploy.sh compose up -d backup-s3`. It mirrors the
backups directory every hour.

**Add a third app container:** create `/opt/sportsarc/compose.override.yml`:

```yaml
services:
  app3:
    extends:
      file: compose.yml
      service: app2
```

add it to Caddy's pool in `.env`:

```bash
APP_UPSTREAMS=app1:3000 app2:3000 app3:3000
```

and run `./deploy.sh deploy $(grep ^APP_TAG= .env | cut -d= -f2)`. It
starts app3 (with the same shared uploads volume), and later deploys roll
app1, app2 and app3 in turn. Changing the pool restarts Caddy, which drops
requests for a second or two (tested: 9 of 651), so do it at a quiet time.
Each app container takes up to `APP_MEMORY` (384 MB); check the budget
below first. Removing it again: delete the override, put `APP_UPSTREAMS`
back, and run `./deploy.sh compose up -d --remove-orphans caddy`.

## 8. Memory budget

Limits (the most each container may use) and what each used while serving
test traffic:

| container | limit | in use |
|---|---|---|
| app1, app2 | 384 MB each | 110–120 MB each |
| postgres | 512 MB | 55 MB |
| loki | 384 MB | 90–105 MB |
| grafana | 256 MB | 95–110 MB |
| alloy | 256 MB | 60–70 MB |
| prometheus | 256 MB | 25 MB |
| caddy | 128 MB | 15–20 MB |
| backup | 128 MB | 2 MB (more while dumping) |
| events | 32 MB | 8 MB |
| migrate (during deploys only) | 384 MB | |

The limits add up to 2.7 GB (3.1 GB during a deploy), and real use is about
0.6 GB, so a 4 GB VPS has room for the operating system and growth. Logs are
kept 14 days; metrics 15 days (at most 1 GB).

## 9. When something goes wrong

- **The deploy job failed.** Read its log in GitHub Actions; `deploy.sh`
  says which step failed, and the old version is still serving. Then
  `./deploy.sh compose logs --tail=100 app1`.
- **The app will not start** and the log says `EMAIL_PROVIDER`: set the Brevo
  settings (section 3).
- **No certificate / browser warns.** Check the DNS record (6.2), Hostinger's
  firewall (6.1), and `./deploy.sh compose logs caddy`.
- **Disk nearly full.** `docker system prune` removes unused images; lower
  `BACKUP_KEEP_DAILY`; or grow the disk.
- **Locked out by the firewall.** Use the browser terminal Hostinger offers
  for the VPS in hPanel, and run `ufw status`.

## 10. Later: production

The same kit on a new host: run the bootstrap there, give it its own `.env`
(new secrets, the production domain), and point a copy of the deploy workflow
at it with its own `VPS_*` secrets in a `production` environment. A managed
database instead of the bundled one: set `DATABASE_URL` and drop `db` from
`COMPOSE_PROFILES`.

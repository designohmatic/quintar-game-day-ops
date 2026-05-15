# DEPLOY.md — Quintar Game Day Ops, initial AWS deploy

> Single runbook for the first push to `https://playground.quintar.ai`.
> Pair this with `IT_SETUP_V2.md` (locked architecture) and `IT_SETUP_V2.1.md`
> (refinements). Anything those say about *what* the target looks like; this
> file says *how* to actually do it, in order.
>
> Target deadline: testing kicks off **Thursday 2026-05-21**. Today: 2026-05-15.

---

## At a glance

| Layer       | Lives at                                     | Pushed by                              |
| ----------- | -------------------------------------------- | -------------------------------------- |
| Frontend    | S3 → CloudFront → `playground.quintar.ai`    | `npm run build:frontend` + `deploy-frontend.sh` |
| Backend     | EC2 (existing box) PM2 app `quintar-ops`:3005 | `scripts/deploy-backend.sh`            |
| DB          | SQLite at `/opt/quintar/game-day-ops/data/ops.db` | created automatically on first boot    |
| Realtime    | AWS AppSync Event API, channel `/default/updates` | already exists, key rotated by IT      |
| Secrets     | IT's call — default path is AWS Secrets Manager at `quintar-ops/dev` in us-east-1 | IT (see Step 1) |
| Region      | us-east-1                                    |                                        |

CloudFront routes:
- `/api/*` → EC2:3005
- everything else → S3

WebSocket traffic does **not** go through CloudFront — browsers connect to AppSync directly.

---

## Pre-flight — what Charlie owns before the meeting

IT is handling token rotation (both `SLACK_BOT_TOKEN` and the AppSync API key) and the choice of secret store on their side — not blocking on Charlie.

- [ ] Skim `scripts/secret-template.json` — that's the schema of keys the server expects, regardless of whether IT lands them in AWS Secrets Manager, SSM Parameter Store, or somewhere else (see note in Step 1).
- [ ] After IT rotates and shares the new bot token, signing secret, and AppSync key, update local `.env.local` and `amplify_outputs.js` so Charlie's dev environment matches prod.
- [ ] Have answers ready (or ask IT during meeting): S3 bucket name, CloudFront distribution ID, EC2 host, SSH key path. See "Open questions for IT" at bottom.

---

## Step 1 — Secret store  *(IT picks; default path is AWS Secrets Manager)*

The server expects three secrets: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SESSION_SECRET`. Schema reference: [`scripts/secret-template.json`](scripts/secret-template.json).

`server/secrets.js` currently reads from **AWS Secrets Manager** when `NODE_ENV` is `production` or `prod` (secret name `quintar-ops/dev` in `us-east-1`, single JSON blob). If that's what IT picks, the code works as-is:

1. Region: **us-east-1**.
2. Secrets Manager → Store a new secret → Secret type = **Other type**.
3. Pick **Plaintext** view, paste the keys from [`scripts/secret-template.json`](scripts/secret-template.json) (strip the `_*_help_` comment keys), fill in the rotated values.
4. Secret name: `quintar-ops/dev` (literal — server reads this exact name).
5. Encryption: default AWS-managed key is fine for dev.
6. EC2 instance role needs `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:us-east-1:*:secret:quintar-ops/*`:

   ```json
   {
     "Effect": "Allow",
     "Action": "secretsmanager:GetSecretValue",
     "Resource": "arn:aws:secretsmanager:us-east-1:*:secret:quintar-ops/*"
   }
   ```

If IT prefers a different store (SSM Parameter Store, Vault, env files written by systemd, etc.), say so at the meeting — `server/secrets.js` is the only file that needs to change. The simplest swap: have IT inject the three values into `process.env` at PM2 start, and we tweak `secrets.js` to read straight from there.

---

## Step 2 — EC2 backend  *(IT, with SSH to the box)*

### One-time setup

```bash
# As root or with sudo:
mkdir -p /opt/quintar/game-day-ops/data
chown -R <pm2-user>:<pm2-user> /opt/quintar/game-day-ops
```

### Merge the PM2 entry

Open the existing `ecosystem.config.js` (wherever IT keeps it). Copy the
single `quintar-ops` app object from this repo's [`ecosystem.config.js`](ecosystem.config.js)
into the existing `apps[]` array. Don't replace the file — append.

Key fields IT may need to confirm:
- `cwd: '/opt/quintar/game-day-ops'` — the install path
- `script: 'server/index.js'`
- `NODE_ENV: 'production'` — **must** be `production` or `prod`; anything else makes `server/secrets.js` skip Secrets Manager and try `process.env`, which the box doesn't have.
- `SLACK_CHANNEL_ID: 'C0A28QULBK2'` — #int-gameday-ops, non-secret.

### First push

From Charlie's laptop (or wherever the repo lives):

```bash
export EC2_HOST=ec2-user@<the-box>
bash scripts/deploy-backend.sh
```

What that does: rsync `server/` + `roster.json` + `template.json` to `/opt/quintar/game-day-ops/`, runs `npm ci --omit=dev` inside `server/`, `pm2 reload quintar-ops`, and curls `/health` for a sanity check.

If this is the very first start (no PM2 process named `quintar-ops` yet), do this once instead of `reload`:

```bash
ssh $EC2_HOST 'pm2 start /opt/<pm2-config-dir>/ecosystem.config.js --only quintar-ops && pm2 save'
```

### Verify

```bash
ssh $EC2_HOST 'curl -sf http://localhost:3005/health'
# → {"status":"ok","db":"ok","uptime":N}
```

PM2 logs: `ssh $EC2_HOST 'pm2 logs quintar-ops --lines 50'`

Expected log lines on a clean boot:
- `quintar-ops server listening on :3005`
- `SQLite ready`
- `roster enriched: 14 entries` (proves Slack token reached the server via Secrets Manager)

If `roster enrichment failed` shows up: Secrets Manager isn't reachable, IAM is wrong, or the token is wrong. Tail the error.

---

## Step 3 — CloudFront + S3  *(IT)*

Per `IT_SETUP_V2.md` §14, but tightened:

### S3 bucket

- Name: `quintar-ops-frontend-dev` (or whatever IT prefers — note the exact name; it goes into `S3_BUCKET` env var for the deploy script).
- Region: us-east-1.
- Public access: blocked. CloudFront accesses via OAC (Origin Access Control), not direct.
- Versioning: optional.

### ACM cert

- Domain: `playground.quintar.ai`
- Region: **us-east-1** (required for CloudFront).

### CloudFront distribution

- Default origin → the S3 bucket (OAC).
- Second origin → EC2 box on **port 3005**, plain HTTP. Protocol: HTTP only. Origin shield: off for dev.
- Default cache behavior → S3 origin, GET/HEAD only, default cache policy.
- Cache behavior for path pattern `/api/*` → EC2 origin, **all methods**, **caching disabled**, forward **all headers**, **all query strings**, **all cookies**. Origin request policy: `Managed-AllViewer` is fine.
- Default root object: `index.html` (the build emits `landing.html` and a copy as `index.html` so root hits land on the picker).
- TLS: attach the ACM cert. Viewer protocol policy: Redirect HTTP to HTTPS.

### DNS

- Add a CNAME / A-ALIAS: `playground.quintar.ai` → CloudFront distribution domain.
- Note the **distribution ID** (`E1ABC...`) — Charlie needs it for the deploy script.

---

## Step 4 — Frontend deploy  *(Charlie, locally, with values from IT)*

```bash
# 1. Build the bundle (defaults API base to https://playground.quintar.ai)
npm run build:frontend
# → produces dist/

# 2. Plug in the real AppSync values IT gave you.
#    Edit dist/amplify_outputs.js so window.APPSYNC_CONFIG has the rotated
#    endpoint, region, and apiKey. The deploy script refuses to ship if it
#    still sees the placeholder strings.

# 3. Sync to S3 + invalidate CloudFront.
export S3_BUCKET=quintar-ops-frontend-dev
export CF_DISTRIBUTION_ID=E1ABC234DEF567
npm run deploy:frontend
```

`deploy-frontend.sh` does a `--delete` sync, sets `Cache-Control: max-age=300`, and creates a `/*` invalidation. Propagation is usually under a minute.

---

## Step 5 — Smoke test  *(do this together with IT)*

In order, on `https://playground.quintar.ai`:

1. **Landing loads.** Open browser dev tools → no 404s on `state.js`, `roster.json`, `template.json`, `amplify_outputs.js`.
2. **Health through CloudFront.** `curl https://playground.quintar.ai/api/health` → 200 with `{status:"ok",db:"ok",...}`.
3. **Roster enriched.** `curl https://playground.quintar.ai/api/roster` → 14 entries with `slackHandle` populated.
4. **Create an event.** Use the "Create Event" modal on landing → it should navigate to `event-view.html?gameId=...` and a pinned message should appear in `#int-gameday-ops`.
5. **Cross-tab realtime.** Open the event URL in a second browser → activate a step in tab 1 → tab 2 reflects the change without refresh (proves AppSync end-to-end).
6. **DM lands.** Activating a step DMs the owner. Verify in Slack DMs.
7. **End event.** Hit End Event → pinned message replaces with `🟢 streaming live` + a new channel-timeline post.
8. **Reload survives.** Reload event-view → all step states + the elapsed timer are still correct (proves SQLite persistence).
9. **CloudWatch.** Confirm logs appearing in `/quintar/game-day-ops/dev`.

If something fails, leave the worktree as-is and grab `pm2 logs quintar-ops --lines 100`.

---

## Step 6 — Tighten before sharing the URL

The server already reads `CORS_ALLOWED_ORIGIN`. Once the smoke test passes:

- Confirm `ecosystem.config.js` has `CORS_ALLOWED_ORIGIN: 'https://playground.quintar.ai'` (it does in this repo).
- Run `npm run deploy:backend` once more to pick up the merged env on the PM2 entry, then `pm2 reload quintar-ops`. After this the API rejects browser requests from any other origin.

No production firewall needed beyond the CloudFront-only ingress to port 3005.

---

## Rollback

Frontend:
- S3 versioning, if enabled, lets IT pin an earlier object set; otherwise re-run `npm run deploy:frontend` against a previous git commit.

Backend:
- `ssh $EC2_HOST 'pm2 stop quintar-ops'` parks the app cleanly. The DB file is intact.
- `git checkout <prev-sha> -- server/ roster.json template.json && bash scripts/deploy-backend.sh` to roll back code.

Database:
- The DB is at `/opt/quintar/game-day-ops/data/ops.db` — a single file. To wipe: `pm2 stop quintar-ops`, delete `ops.db*` (with the WAL sidecar files), `pm2 start`. The schema is recreated on first request.

---

## Open questions for IT

These can't be resolved without IT in the room — bring them to the meeting:

- [ ] S3 bucket name — needed for `S3_BUCKET` env var.
- [ ] CloudFront distribution ID — needed for `CF_DISTRIBUTION_ID`.
- [ ] EC2 hostname + SSH key arrangement — needed for `EC2_HOST` and for Charlie to actually run `deploy-backend.sh`. Alternative: IT runs it from a jump host.
- [ ] Where the existing `ecosystem.config.js` lives on EC2 — so IT knows where to merge the `quintar-ops` entry.
- [ ] Jenkins pipeline shape — are we wiring `deploy-backend.sh` / `deploy-frontend.sh` into a Jenkins job now or shipping by hand for the MVP?
- [ ] CloudWatch agent — is it already running on the box and shipping `/root/.pm2/logs/quintar-ops-*.log`, or does IT need to add a config stanza?
- [ ] DNS — is `playground.quintar.ai` on Route 53 or hosted elsewhere?

---

## File index

- [`build-frontend.mjs`](build-frontend.mjs) — emits `dist/`
- [`ecosystem.config.js`](ecosystem.config.js) — PM2 app entry to merge on EC2
- [`scripts/deploy-frontend.sh`](scripts/deploy-frontend.sh) — S3 sync + CF invalidation
- [`scripts/deploy-backend.sh`](scripts/deploy-backend.sh) — rsync + PM2 reload
- [`scripts/secret-template.json`](scripts/secret-template.json) — Secrets Manager paste shape
- [`IT_SETUP_V2.md`](IT_SETUP_V2.md), [`IT_SETUP_V2.1.md`](IT_SETUP_V2.1.md), [`IT_SETUP_V2_PATCH.md`](IT_SETUP_V2_PATCH.md) — architecture spec (locked)
- [`SLACK_SETUP.md`](SLACK_SETUP.md) — Slack app provisioning notes (already done)

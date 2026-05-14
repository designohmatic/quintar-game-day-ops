# Quintar Game Day Ops — IT Setup Guide (Dev)

> **Audience:** the IT engineer provisioning EC2 + S3 + CloudFront + Jenkins pipeline for this app.
> **Author:** Charles Johnson, Quintar Design.
> **Status:** all §13 decisions made — ready to build.
> **Repo:** `github.com/designohmatic/quintar-game-day-ops`

---

## 1. Project context

Quintar Game Day Ops is a real-time checklist app used by the Quintar operations team during live spatial-video streaming events. It coordinates ~40 setup steps across 5 phases (Survey, Parallel Processing, Convergence, Overlays, Monitoring) with multiple owners per step, live state shared across distributed crew members on phones and laptops.

The existing prototype (`quintar-ops.html`) is single-user with in-memory state, hosted on GitHub Pages. This migration converts it to a multi-user Node.js application with shared state, Slack notifications, and multi-session support (multiple games run simultaneously, same staff across both).

**Frontend visual layer does not change.** All current interaction patterns (long-press flyout, auto-advance, step timers, undo cascade, Stream Live banner, time/CSV reports) are preserved. What changes is the data layer — replacing in-memory JS with an API + WebSocket.

---

## 2. Architecture overview

```
                    ┌──────────────────────────────────────────────┐
                    │  CloudFront  (playground.quintar.ai, HTTPS)  │
                    │                                              │
   User browser ───►│  /               ──► S3 bucket (frontend)   │
   (laptop / iOS)   │  /api/*          ──► EC2:3005               │
                    └──────────────────────────────────────────────┘
                          │                               │ (Amplify SDK, direct)
                 HTTP, port 3005                          ▼
                          ▼               ┌──────────────────────────────┐
              ┌───────────────────────┐   │  AWS AppSync Event API       │
              │  EC2 — Node.js        │   │  (managed WebSocket pub/sub) │
              │  Express (REST only)  │   │  Channel: /default/updates   │
              │  PM2 process manager  │   │  Auth: API key               │
              └──────────┬────────────┘   └──────────────────────────────┘
                         │──► Slack webhook
                         ▼
              ┌───────────────────────┐
              │  SQLite (ops.db)      │
              │  local file on EC2    │
              └───────────────────────┘

   Secrets: AWS Secrets Manager
   Logs:    CloudWatch Logs
```

**No nginx, no ALB.** CloudFront terminates TLS and routes requests:

- Static frontend files (`/`) → S3 bucket
- REST API (`/api/*`) → EC2 port 3005

Real-time updates use AWS AppSync Event API — the browser connects directly to AppSync over WebSocket (HTTPS, managed by AWS). No WebSocket traffic passes through CloudFront or EC2.

The Node.js server runs plain HTTP internally and handles REST only.

---

## 3. Server runtime requirements

| Item                 | Requirement                                                     |
| -------------------- | --------------------------------------------------------------- |
| **Runtime**          | Node.js 20 LTS                                                  |
| **Process model**    | Single persistent process managed by PM2                        |
| **Memory**           | 512 MB minimum (existing EC2 is fine)                           |
| **CPU**              | Existing EC2 instance — no change needed                        |
| **Disk**             | ~100 MB for app + SQLite DB                                     |
| **Outbound network** | Must reach `slack.com` (port 443) for Slack Web API             |
| **Restart on crash** | PM2 auto-restart enabled                                        |
| **Single instance**  | Yes for v1. Horizontal scaling requires ALB (see §15)           |

---

## 4. Real-time updates — AppSync Event API

Real-time state sync uses **AWS AppSync Event API** (managed WebSocket pub/sub). The frontend connects directly to AppSync — no WebSocket traffic touches CloudFront or EC2.

**AppSync endpoint** (from `amplify_outputs.json`):

```
https://tudaujx3y5cmlk6xm4rskgt374.appsync-api.us-east-1.amazonaws.com/event
```

**Channel:** `/default/updates`  
**Auth:** API key (`apiKey` field in `amplify_outputs.json`)

### Frontend integration

Install the Amplify SDK in the frontend build:

```bash
npm install aws-amplify
```

AppSync config is read from environment variables (set in the frontend `.env` file — see §8):

```js
import { Amplify } from 'aws-amplify';
import { events } from 'aws-amplify/data';

Amplify.configure({
  API: {
    Events: {
      endpoint: process.env.APPSYNC_ENDPOINT,
      region: process.env.APPSYNC_REGION,
      defaultAuthMode: 'apiKey',
      apiKey: process.env.APPSYNC_API_KEY,
    },
  },
});
```

**Subscribe** when a game checklist loads — filter by `gameId` so each client only reacts to its own game:

```js
const channel = await events.connect('/default/updates');
channel.subscribe({
  next: ({ data }) => {
    if (data.gameId !== currentGameId) return; // ignore other games
    applyStepUpdate(data); // update local checklist state
  },
  error: (err) => console.error('AppSync error', err),
});
```

Disconnect when the user navigates away or the page unloads:

```js
channel.close();
```

**Publish** after a successful REST API call:

```js
await events.post('/default/updates', {
  gameId,   // string — unique game event ID
  stepId,   // string — e.g. "step-12"
  status,   // 'pending' | 'active' | 'complete' | 'flagged' | 'blocked'
  actor,    // display name or session ID of the user making the change
});
```

### Event payload schema

| Field    | Type   | Description                                  |
| -------- | ------ | -------------------------------------------- |
| `gameId` | string | Unique game event ID (used to filter events) |
| `stepId` | string | Step identifier (e.g. `"step-12"`)           |
| `status` | string | New step status                              |
| `actor`  | string | Who made the change                          |

### Flow

1. User changes a step → frontend calls `POST /api/games/:id/steps/:stepId`
2. REST API persists the change in SQLite, returns `200`
3. Frontend publishes the change to AppSync channel `/default/updates`
4. All other clients subscribed to that channel receive the event
5. Each client checks `data.gameId` and ignores events for other games

---

## 5. Domain + TLS

| Subdomain               | Points to               | Purpose                      |
| ----------------------- | ----------------------- | ---------------------------- |
| `playground.quintar.ai` | CloudFront distribution | Frontend + Backend (unified) |

Single domain for everything. No separate API subdomain. Backend requests go to `https://playground.quintar.ai/api/...` — CloudFront proxies them to EC2. Real-time updates connect directly to AppSync (separate managed endpoint).

**ACM certificate:** issue for `playground.quintar.ai` in `us-east-1` (required for CloudFront). TLS terminates at CloudFront. EC2 runs plain HTTP on port 3005.

**Charlie's question for IT:** is `playground.quintar.ai` on Route 53 or hosted elsewhere? Affects how the DNS CNAME/alias is added.

---

## 6. Database — SQLite

SQLite runs inside the Node.js process via the `better-sqlite3` package. No separate DB service, no port, no managed instance.

**File path:** `/opt/quintar/game-day-ops/data/ops.db` (created automatically on first run)

**Tables:**

```sql
PRAGMA journal_mode = WAL;

-- One row per game event
games (id, name, created_at, started_at, completed_at)

-- Per-step runtime state
step_states (game_id, step_id, status, activated_at, completed_at, actor)

-- User notes attached to flagged/blocked steps
step_notes (game_id, step_id, type, text)

-- Flag/blocked issue timing
issue_events (id, game_id, step_id, type, started_at, resolved_at)

-- Tracks which steps were auto-activated by completing another (used for undo)
activation_chain (game_id, trigger_step_id, activated_step_id)
```

**Backup:** optional cron to S3:

```bash
0 2 * * * aws s3 cp /opt/quintar/game-day-ops/data/ops.db \
  s3://quintar-backup-bucket/ops-$(date +\%F).db
```

---

## 7. Secrets management

**Backend:** AWS Secrets Manager. The Node.js server reads secrets at startup using the EC2 instance's IAM role — no credentials hardcoded anywhere.

**Secret name:** `quintar-ops/dev`

**Required keys (JSON object in the secret):**

| Key                    | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `SESSION_SECRET`       | JWT signing for user sessions                                              |
| `SLACK_BOT_TOKEN`      | Slack Web API auth — DMs + channel posts + message updates. Format: `xoxb-…` |
| `SLACK_SIGNING_SECRET` | Verifies inbound Slack interactive callbacks (future buttons). Hex string. |

`SLACK_BOT_TOKEN` replaces the webhook approach. The bot calls `https://slack.com/api/*` to post one pinned status message per game event (updated in place via `chat.update`), send DMs to step owners when their step activates or gets flagged, and thread escalation replies under the pinned message.

**Charlie has already provisioned the Slack app** (`Quintar Set Day Ops`) and captured both tokens. Handoff via 1Password — do not request them over Slack or email.

**IAM policy on EC2 instance role:**

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:*:secret:quintar-ops/*"
}
```

---

## 8. Environment variables

### Backend (EC2 — PM2 `ecosystem.config.js`)

Non-secret config is set in PM2's `ecosystem.config.js`. Secrets come from AWS Secrets Manager at startup.

| Var                   | Value (dev)                     | Notes                                |
| --------------------- | ------------------------------- | ------------------------------------ |
| `NODE_ENV`            | `dev`                           |                                      |
| `PORT`                | `3005`                          | What Express listens on              |
| `LOG_LEVEL`           | `debug`                         | `debug` / `info` / `warn` / `error`  |
| `CORS_ALLOWED_ORIGIN` | `https://playground.quintar.ai` | CloudFront origin                    |
| `DB_PATH`             | `./data/ops.db`                 | SQLite file path                     |
| `AWS_REGION`          | `us-east-1`                     | For Secrets Manager SDK calls        |
| `AWS_SECRETS_NAME`    | `quintar-ops/dev`               | Secret name in Secrets Manager       |
| `SLACK_CHANNEL_ID`    | `C01XXXX`                       | The `#game-day-ops` Slack channel ID |

### Frontend (build-time `.env` file)

AppSync config is baked into the frontend bundle at build time. Store these in a `.env` file at the frontend project root (not committed; injected by CI or set manually before building):

| Var                | Value (dev)                                                                               | Notes                  |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------- |
| `APPSYNC_ENDPOINT` | `https://tudaujx3y5cmlk6xm4rskgt374.appsync-api.us-east-1.amazonaws.com/event`           | AppSync Events API URL |
| `APPSYNC_REGION`   | `us-east-1`                                                                               |                        |
| `APPSYNC_API_KEY`  | *(value from `amplify_outputs.json` — store as a secret in CI or share via secure method)* |                        |

---

## 9. CORS

All origins are allowed for v1 dev. Tighten to `CORS_ALLOWED_ORIGIN` before moving to production.

```js
app.use(cors());
```

---

## 10. Healthcheck endpoint

```
GET /health
→ 200 { "status": "ok", "db": "ok", "uptime": <seconds> }
→ 503 { "status": "error", "db": "error" }  if SQLite ping fails
```

Can be used as the CloudFront origin health check path.

---

## 11. Logging

Node.js logs to stdout. PM2 captures stdout/stderr to:

- `/root/.pm2/logs/quintar-ops-out.log`
- `/root/.pm2/logs/quintar-ops-error.log`

The CloudWatch agent ships these files to:

- **Log group:** `/quintar/game-day-ops/dev`
- **Retention:** 7 days

---

## 12. Deploy scripts

### Frontend (S3 + CloudFront)

```bash
#!/bin/bash
# deploy-frontend.sh
aws s3 sync ./public/ s3://quintar-ops-frontend-dev/ \
  --delete \
  --cache-control "max-age=300"

aws cloudfront create-invalidation \
  --distribution-id $CF_DISTRIBUTION_ID \
  --paths "/*"
```

### Backend (EC2)

```bash
#!/bin/bash
# deploy-backend.sh
EC2_HOST="ec2-user@<ec2-public-ip>"
APP_DIR="/opt/quintar/game-day-ops"

rsync -avz --exclude='data/' --exclude='node_modules/' \
  ./server ./package.json ./package-lock.json \
  $EC2_HOST:$APP_DIR/

ssh $EC2_HOST "cd $APP_DIR && npm ci --omit=dev && pm2 reload quintar-ops"
```

---

## 13. PM2 configuration

The existing PM2 `ecosystem.config.js` on EC2 gains one new entry. The existing app is untouched.

```js
module.exports = {
  apps: [
    // ... your existing app entry stays here, unchanged ...
    {
      name: "quintar-ops",
      script: "server/index.js",
      cwd: "/opt/quintar/game-day-ops",
      instances: 1,
      autorestart: true,
      env_dev: {
        NODE_ENV: "dev",
        PORT: 3005,
        CORS_ALLOWED_ORIGIN: "https://playground.quintar.ai",
        DB_PATH: "./data/ops.db",
        AWS_REGION: "us-east-1",
        AWS_SECRETS_NAME: "quintar-ops/dev",
        SLACK_CHANNEL_ID: "C01XXXX",
        LOG_LEVEL: "debug",
      },
    },
  ],
};
```

```bash
pm2 start ecosystem.config.js --env dev --only quintar-ops
pm2 save    # persist across reboots
```

---

## 14. Initial deploy checklist

### DNS + TLS

- [ ] Issue ACM cert for `playground.quintar.ai` in `us-east-1`
- [ ] Add DNS record: `playground.quintar.ai` → CloudFront distribution domain

### CloudFront

- [ ] Create distribution with two origins: S3 bucket + EC2:3005
- [ ] Add cache behavior: `/api/*` → EC2 origin (caching disabled, all headers/query strings forwarded)
- [ ] Default behavior → S3 origin
- [ ] Add custom error response: 404 → `ops.html`, HTTP 200 (for client-side routing on `/game/:id`)
- [ ] Attach ACM cert

### EC2

- [ ] Security group: open port 3005 to CloudFront origin-facing prefix list (or `0.0.0.0/0`)
- [ ] Create secret `quintar-ops/dev` in Secrets Manager with `SESSION_SECRET` + `SLACK_WEBHOOK_URL`
- [ ] Attach IAM policy (Secrets Manager read) to EC2 instance role
- [ ] Clone repo to `/opt/quintar/game-day-ops`, run `npm ci`
- [ ] Add `quintar-ops` entry to existing `ecosystem.config.js`
- [ ] `pm2 start ecosystem.config.js --env dev --only quintar-ops && pm2 save`
- [ ] Verify: `curl http://localhost:3005/health` → 200 (from EC2 itself)

### Frontend

- [ ] Create S3 bucket `quintar-ops-frontend-dev`
- [ ] Populate frontend `.env` with `APPSYNC_ENDPOINT`, `APPSYNC_REGION`, `APPSYNC_API_KEY`
- [ ] Run `npm run build` (bakes env vars into the bundle)
- [ ] Run `deploy-frontend.sh`
- [ ] Verify: `https://playground.quintar.ai` → game picker loads

### Smoke test

- [ ] Create an event from the game picker, verify it persists on refresh
- [ ] Open two browser tabs on same game URL, verify state changes sync in real time
- [ ] Check CloudWatch log group `/quintar/game-day-ops/dev` → logs appearing

---

## 15. Future / out of scope for v1

| Feature                         | When needed                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Auth (Cognito / OAuth)**      | Phase 2 — role-based access (Operator / Participant)                                                          |
| **Horizontal scaling**          | Second EC2 needs an ALB. Real-time sync is already handled by AppSync (managed) — no Redis adapter needed.    |
| **ALB**                         | When moving to multiple EC2 instances                                                                         |
| **Postgres**                    | If reporting queries become complex                                                                           |
| **Multi-region**                | Disaster recovery requirement                                                                                 |
| **Staging / prod environments** | After dev is validated                                                                                        |
| **Audit log retention policy**  | ActivityLog kept indefinitely for v1; archive to S3 after N months if cost becomes a concern                  |

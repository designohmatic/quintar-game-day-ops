# Quintar Game Day Ops — IT Setup Guide

> **Audience:** the IT engineer provisioning EC2 + DB + Jenkins pipeline for this app.
> **Author:** Charles Johnson, Quintar Design.
> **Status:** awaiting IT decisions on items marked **[NEEDS DECISION]** in §13.
> **Repo:** `github.com/designohmatic/quintar-game-day-ops` (currently GitHub Pages; moving to AWS)

---

## 1. Project context

Quintar Game Day Ops is a real-time checklist app used by the Quintar operations team during live spatial-video streaming events. It coordinates ~40 setup steps across 5 phases (Survey, Parallel Processing, Convergence, Overlays, Monitoring) with multiple owners per step, live state shared across distributed crew members on phones and laptops.

The existing prototype (`quintar-ops.html`) is single-user with `localStorage` state, hosted on GitHub Pages. This migration converts it to a multi-user Node.js application with shared state, Slack notifications, and multi-session support (multiple games run simultaneously, same staff across both).

**Frontend visual layer does not change.** All current interaction patterns (long-press flyout, auto-advance, step timers, undo cascade, Stream Live banner, time/CSV reports) are preserved. What changes is the data layer underneath — replacing `localStorage` with an API + WebSocket.

---

## 2. Architecture overview

```
                              ┌─────────────────┐
   User browser ──── HTTPS ──►│  CloudFront     │──► S3 bucket (static frontend)
   (laptop / iOS)             │  (frontend CDN) │    HTML / CSS / JS / roster.json
                              └─────────────────┘
       │
       │ HTTPS (REST)  +  WSS (Socket.IO)
       ▼
   ┌─────────────────┐
   │  ALB (api.*)    │  TLS termination, WebSocket upgrade, sticky sessions
   └────────┬────────┘
            │
            ▼
   ┌─────────────────────────────────────┐
   │  EC2 instance — Node.js Express +   │
   │  Socket.IO server (persistent)      │──► Slack Web API (chat.postMessage,
   │  PM2 / systemd for process mgmt     │      chat.update, conversations.open)
   └────────┬────────────────────────────┘
            │
            ▼
   ┌─────────────────────────────────────┐
   │  DB (DynamoDB or RDS Postgres)      │  Events, Steps, Participants, ActivityLog
   └─────────────────────────────────────┘

   Secrets: AWS Secrets Manager (or SSM Parameter Store)
   Logs:    CloudWatch Logs
```

---

## 3. Server runtime requirements

| Item | Requirement |
|---|---|
| **Runtime** | Node.js **20 LTS** (or 22 LTS — both fine) |
| **Process model** | Single persistent process. PM2 or systemd preferred over Docker for v1 simplicity, but Docker is fine if it matches your existing patterns |
| **Memory** | 1 GB minimum, 2 GB comfortable (Socket.IO holds connections in memory; ~5 KB per connected client) |
| **CPU** | t3.small or t3.medium is plenty for low double-digit concurrent users |
| **Disk** | 8 GB enough — no large local data |
| **Outbound network** | Must reach `slack.com` (port 443) for the Slack API |
| **Restart on crash** | Yes — PM2 `--watch false` with auto-restart, or systemd `Restart=on-failure` |
| **Single instance OK?** | Yes for v1. Horizontal scaling later requires a Redis adapter for Socket.IO; document this as a future consideration |

---

## 4. WebSocket / load balancer requirements

The realtime layer uses Socket.IO over WebSockets. If you put an ALB in front of the EC2 instance:

- [ ] **Listener:** HTTPS 443 → target group → EC2 port (default `3000`, configurable via env var)
- [ ] **WebSocket support:** enabled (ALB supports this natively, but listener rules must not strip the `Upgrade` header)
- [ ] **Stickiness:** **required.** Enable `lb_cookie` stickiness on the target group, duration 1 hour. Without this, Socket.IO falls back to long-polling and reconnections land on the wrong server (will become a real issue once we scale beyond one instance, but enable now)
- [ ] **Idle timeout:** **at least 60 seconds**, ideally 120s. Default 60s is borderline — Socket.IO heartbeats every 25s by default
- [ ] **Healthcheck path:** `/health` (see §10)
- [ ] **HTTP → HTTPS redirect:** standard

**If going direct EC2 with a public IP** (no ALB): you'll need nginx in front for TLS termination via Let's Encrypt, plus `proxy_set_header Upgrade $http_upgrade` and `proxy_set_header Connection "upgrade"` for WebSockets. ALB is cleaner.

---

## 5. Domain + TLS

**Proposed naming:**

| Subdomain | Points to | Purpose |
|---|---|---|
| `ops.quintar.ai` | CloudFront (S3 origin) | Frontend |
| `api.quintar.ai` | ALB (EC2 origin) | Backend HTTP + WebSocket |

Open to other naming. Whatever's chosen, both need ACM certificates (issued in `us-east-1` for CloudFront, in the deploy region for ALB).

**Charlie's question for IT:** is `quintar.ai` Route 53 hosted, or hosted elsewhere? Affects how DNS records get added.

---

## 6. DB options

We have two real options. Both work. Pick based on what fits Quintar's existing AWS patterns.

### Option A — DynamoDB (single-table design)

**Pros:** managed, no maintenance, scales to zero cost when idle, fits well with serverless if you ever go that direction.
**Cons:** access patterns must be predicted up front; queries that weren't designed for can be painful.

Single-table sketch:

| PK | SK | Attributes |
|---|---|---|
| `EVENT#<gameId>` | `META` | name, sport, venue, status, createdAt, startedAt, completedAt, pinnedSlackMessageTs |
| `EVENT#<gameId>` | `STEP#<stepId>` | seq, phase, track, title, status, owners[], activatedAt, completedAt, note |
| `EVENT#<gameId>` | `PARTICIPANT#<userId>` | name, slackUserId, role, joinedAt |
| `EVENT#<gameId>` | `LOG#<ts>` | userId, action, payload |
| `USER#<userId>` | `META` | name, slackUserId |

Required GSIs:
- **GSI1:** `status` partition → quick "active events list" query for landing page
- **GSI2:** `owner` partition → "Your Attention" widget query across all events

### Option B — RDS Postgres

**Pros:** flexible queries, easy to evolve schema, familiar to most engineers.
**Cons:** monthly cost ($30+/mo for db.t3.micro), maintenance, scales less elegantly.

Tables:

```sql
events           (game_id PK, name, sport, venue, customer_team, status,
                  template_id, pinned_slack_message_ts, created_by, created_at,
                  started_at, completed_at)
steps            (step_id PK, game_id FK, seq, phase, track, title, status,
                  activated_at, completed_at, note)
step_owners      (step_id FK, user_id FK, is_default)   -- many-to-many
participants     (game_id FK, user_id FK, joined_at, role)
activity_log     (id PK, game_id FK, ts, user_id, action, payload JSONB)
users            (user_id PK, name, slack_user_id)
```

Indexes: `events(status)`, `steps(game_id, seq)`, `step_owners(user_id, status_lookup)`, `activity_log(game_id, ts)`.

### Recommendation

**DynamoDB** if Quintar already runs on it / no engineers want to manage Postgres.
**Postgres** if you want maximum flexibility for future reporting + the Quintar team is comfortable with SQL.

The schemas above are equivalent — Charlie can model either. **[NEEDS DECISION]** in §13.

---

## 7. Secrets management

**Recommended:** **AWS Secrets Manager** (or SSM Parameter Store, SecureString type — slightly cheaper, less ergonomic). The Node app will read secrets at startup via the AWS SDK using the EC2 instance's IAM role.

**Required secrets:**

| Name | Purpose | Format |
|---|---|---|
| `SLACK_BOT_TOKEN` | Slack Web API auth — DMs + channel posts | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | Verify inbound Slack interactive callbacks (future) | hex string |
| `DB_CONNECTION` | DynamoDB region + IAM, or Postgres connection string | varies |
| `SESSION_SECRET` | Cookie signing for Phase 2 auth | 64+ random chars |

**IAM role** on the EC2 instance needs `secretsmanager:GetSecretValue` for these secret ARNs only — least privilege.

Charlie will provision the Slack app and hand the tokens over to IT for upload to Secrets Manager. **He will not paste them into Slack/email/PRs.** See `SLACK_SETUP.md` for the procurement workflow.

---

## 8. Environment variables

Non-secret config goes in env vars. The deploy pipeline can set these from Jenkins parameters or a checked-in `ecosystem.config.js`.

| Var | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | What Express listens on |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `CORS_ALLOWED_ORIGIN` | `https://ops.quintar.ai` | Backend whitelists this for HTTP + WS |
| `SLACK_CHANNEL_ID` | `C01XXXX` | The `#game-day-ops` channel ID |
| `DB_REGION` | `us-west-2` | For DynamoDB |
| `DB_TABLE_NAME` | `quintar-ops` | If DynamoDB |
| `AWS_SECRETS_PREFIX` | `quintar-ops/prod/` | Path prefix for secret lookup |

The values above are the production defaults. Dev will use a `.env` file (gitignored).

---

## 9. CORS configuration

The frontend at `ops.quintar.ai` (S3/CloudFront) calls the backend at `api.quintar.ai` (ALB/EC2) — cross-origin. The Node server must whitelist the frontend origin:

```js
// Already wired in the Node skeleton:
app.use(cors({
  origin: process.env.CORS_ALLOWED_ORIGIN,
  credentials: true   // for Phase 2 auth cookies
}));
```

**WebSocket CORS** is configured separately on the Socket.IO instance — same origin whitelist needed.

If you put CloudFront in front of the API (not strictly required, but you might for caching `/health` or for a unified domain): CloudFront does **not** forward `Origin` headers by default. Forward it explicitly, or CORS will fail mysteriously.

---

## 10. Healthcheck endpoint

For ALB target group health checks:

| Path | `/health` |
|---|---|
| Method | GET |
| Expected response | `200 OK`, body `{"status":"ok","version":"<git sha>","db":"ok","uptime":<seconds>}` |
| Interval | 30s |
| Healthy threshold | 2 |
| Unhealthy threshold | 3 |

The handler does a fast DB ping. If the DB ping fails, returns `503` with `db:"error"` so the ALB pulls the instance out of rotation.

---

## 11. Logging

The Node server uses `pino` for structured JSON logs to stdout. PM2 / systemd captures stdout and ships it.

- **CloudWatch log group:** `/quintar/game-day-ops/<env>` (e.g. `/quintar/game-day-ops/prod`)
- **Retention:** 30 days for prod, 7 days for dev
- **Log levels:** `info` and above in production. `error` events should trigger CloudWatch alarms (TBD)

Slack-specific log markers we'll emit so they're easy to grep:
- `slack.dm.sent` — owner DM dispatched
- `slack.status.updated` — pinned status message edited
- `slack.error` — any 4xx/5xx from the Slack API (retry logic logs this)

---

## 12. Jenkins pipeline expectations

**Inputs:** GitHub repo `designohmatic/quintar-game-day-ops`, branch (default `main`).

**Frontend pipeline** (S3 deploy):
```
1. Checkout repo
2. cd frontend/ ; (no build step required — static HTML/CSS/JS)
3. aws s3 sync ./ s3://quintar-ops-frontend-<env>/ --delete --cache-control "max-age=300"
4. aws cloudfront create-invalidation --distribution-id <ID> --paths "/*"
```

**Backend pipeline** (EC2 deploy):
```
1. Checkout repo
2. cd server/
3. npm ci --production
4. npm run build       (if we add TypeScript / a build step — TBD)
5. Package: zip -r build.zip . -x "node_modules/.cache/*"
6. aws s3 cp build.zip s3://quintar-ops-artifacts/<sha>.zip
7. SSH to EC2 / use SSM Run Command:
   - download build.zip, unzip to /opt/quintar/releases/<sha>/
   - symlink /opt/quintar/current -> /opt/quintar/releases/<sha>/
   - pm2 reload ecosystem.config.js --env production
8. Wait for /health to return 200
9. Notify deploy channel in Slack
```

Charlie will commit an `ecosystem.config.js` (PM2 config) at the repo root once the server code lands. If you prefer systemd, let me know and I'll provide a unit file instead.

**Rollback** is `pm2 reload` against the previous release symlink. Keep the last 5 releases on disk.

---

## 13. [NEEDS DECISION] — open questions for IT

Please fill in answers below or in a reply email. These block the start of Phase B (backend skeleton).

| # | Question | Your answer |
|---|---|---|
| 1 | **DB choice:** DynamoDB or RDS Postgres? | |
| 2 | **DB region** (assume `us-west-2` unless you say otherwise)? | |
| 3 | **Domain hosting:** is `quintar.ai` on Route 53? If not, who owns DNS? | |
| 4 | **Proposed subdomains** `ops.quintar.ai` + `api.quintar.ai` — OK or different names? | |
| 5 | **TLS cert provider:** ACM (preferred) or existing wildcard? | |
| 6 | **ALB vs direct EC2 with nginx** — which is your preference? | |
| 7 | **Secrets backend:** Secrets Manager or SSM Parameter Store? | |
| 8 | **Process manager:** PM2 or systemd? | |
| 9 | **Docker:** do you want Node running in a container, or bare? | |
| 10 | **Jenkins artifact format:** zip / tarball / Docker image? | |
| 11 | **EC2 instance type:** any constraint (t3.small / t3.medium fine)? | |
| 12 | **Multiple environments:** dev + prod, or just prod for v1? | |
| 13 | **Existing logging/monitoring stack** beyond CloudWatch? Datadog / New Relic? | |

---

## 14. Initial deploy checklist

Once IT has the infra ready, first deploy follows this order:

- [ ] EC2 instance provisioned with IAM role (Secrets Manager read + S3 artifact read + CloudWatch Logs write)
- [ ] ALB target group created, WebSocket + stickiness + healthcheck configured
- [ ] ACM cert issued for `api.quintar.ai`, attached to ALB
- [ ] Route 53 A-record (alias) `api.quintar.ai` → ALB
- [ ] DB provisioned (table created or schema migrated)
- [ ] Secrets uploaded to Secrets Manager (Charlie provides Slack token; IT generates `SESSION_SECRET`)
- [ ] S3 bucket `quintar-ops-frontend-prod` + CloudFront distribution + ACM cert for `ops.quintar.ai`
- [ ] Route 53 A-record alias `ops.quintar.ai` → CloudFront
- [ ] Jenkins job created for frontend pipeline; first deploy run; verify `https://ops.quintar.ai` loads
- [ ] Jenkins job created for backend pipeline; first deploy run; verify `https://api.quintar.ai/health` returns 200
- [ ] Smoke test: create an event from the frontend, verify it persists, verify a second browser tab sees state changes
- [ ] Slack smoke test: verify a pinned message posts to `#game-day-ops` and a test DM lands

---

## 15. Future / out of scope for v1

Not blocking but worth knowing about:

- **Cognito SSO** — Phase 2 auth, role-based (Operator / Participant). Adds a JWT-on-WS dance.
- **Horizontal scaling** — second EC2 needs Redis adapter for Socket.IO room broadcast. Add an ElastiCache Redis when concurrent users >50.
- **Backup strategy** — DynamoDB has point-in-time recovery (free, just enable); Postgres needs RDS automated backups (default).
- **Disaster recovery** — single-region for v1. Multi-AZ DB if budget allows.
- **Audit log retention** — ActivityLog kept forever per memory decision; if cost becomes an issue, archive to S3 after N months.

---

## 16. Contact

- **Charles Johnson** (design + frontend) — Charlie@quintar.ai
- **GitHub:** `designohmatic/quintar-game-day-ops`
- **Current prototype:** https://designohmatic.github.io/quintar-game-day-ops/

Questions on this doc? Reply in the deploy thread or hit Charlie directly.

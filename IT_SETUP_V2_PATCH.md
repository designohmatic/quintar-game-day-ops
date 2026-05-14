# IT_SETUP_V2 — Slack section patch

> One small correction to the V2 doc. Everything else looks great — let's roll with your simplifications.
>
> The Slack app I provisioned is a **Bot Token** app, not an Incoming Webhook. This is intentional — webhooks can only spray a single channel with sequential posts (which is what we want to avoid). Bot Token gives us:
> - **One pinned status message per event**, updated in place via `chat.update` (no channel spam)
> - **Direct messages to step owners** when their step activates / gets flagged
> - **Threaded escalation replies** under the pinned message
>
> Below is the corrected §7 — same idea, different secret names.

---

## 7. Secrets management (corrected)

**Backend:** AWS Secrets Manager. The Node.js server reads secrets at startup using the EC2 instance's IAM role — no credentials hardcoded anywhere.

**Secret name:** `quintar-ops/dev`

**Required keys (JSON object in the secret):**

| Key                    | Purpose                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `SESSION_SECRET`       | JWT signing for user sessions                                                    |
| `SLACK_BOT_TOKEN`      | Slack Web API auth — DMs + channel posts + message updates. Format: `xoxb-…`     |
| `SLACK_SIGNING_SECRET` | Verifies inbound Slack interactive callbacks (future buttons). Hex string.       |

`SLACK_BOT_TOKEN` replaces `SLACK_WEBHOOK_URL` from the previous draft. The bot calls `https://slack.com/api/*` (not a webhook URL); the IAM policy and outbound network requirement are otherwise unchanged.

**IAM policy on EC2 instance role:** unchanged from V2 — same `secretsmanager:GetSecretValue` permission scoped to `quintar-ops/*`.

**Outbound network requirement (§3):** server must reach `slack.com:443` (not `hooks.slack.com:443`). Same outbound rule, slightly different host.

**Charlie has already provisioned the Slack app** (`Quintar Set Day Ops`) and captured both tokens. Will hand them over via 1Password or another secure channel — please don't ask for them in Slack or email body.

---

That's the only change. Everything else in V2 (CloudFront single domain, AppSync, SQLite, PM2 entry, deploy scripts) stays as you have it.

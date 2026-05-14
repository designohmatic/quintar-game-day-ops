# Slack Setup — Quintar Game Day Ops

> **For Charles.** This is your worklist for provisioning the Slack bot, capturing tokens, and collecting team user IDs. Once these steps are done, IT can upload the tokens to AWS Secrets Manager and we can wire the messaging layer.

---

## What the bot will do (so the workspace admin knows what they're approving)

The bot is **send-only** for v1. It does not read messages, does not store data, does not need event subscriptions. Three message types:

1. **One pinned status message per active event** in `#game-day-ops`. Edited in place via `chat.update` as steps progress. Channel does not get polluted with sequential notifications.
2. **Direct messages to step owners** when their step activates, gets flagged, or gets blocked. Includes a link back to the event.
3. **Threaded escalation replies** under the pinned status message when flags/blocks include notes.

When the stream goes live, the pinned message is replaced with a final summary + link to the time report.

---

## Step-by-step: provision the Slack app

### A. Create the app

- [ ] Go to **https://api.slack.com/apps**
- [ ] Click **Create New App** → **From scratch**
- [ ] **App Name:** `Quintar Game Day Ops` (or your preference — this is the display name users see)
- [ ] **Workspace:** select Quintar's Slack workspace
- [ ] Click **Create App**

### B. Set the bot user identity

- [ ] In the left nav, click **App Home**
- [ ] Scroll to **Your App's Presence in Slack**
- [ ] Set **Display Name (Bot Name):** `Game Day Ops` (or your preference)
- [ ] Set **Default Username:** `quintar-game-day-ops`
- [ ] Toggle **Always Show My Bot as Online** → ON (cosmetic, but matches expectation)

### C. Add Bot Token scopes

- [ ] In left nav: **OAuth & Permissions**
- [ ] Scroll down to **Scopes** → **Bot Token Scopes** → **Add an OAuth Scope**
- [ ] Add each of these, one at a time:

| Scope | Why we need it |
|---|---|
| `chat:write` | Post messages to channels the bot is in |
| `chat:write.public` | Post to public channels without joining first (lets the bot post to `#game-day-ops` without an explicit `/invite`) |
| `im:write` | Open DM conversations with users for owner notifications |
| `users:read` | Look up user info by Slack ID (used to display names in logs) |
| `users:read.email` | Optional — only needed if we ever map roster entries by email instead of ID. Skip for now if your workspace admin pushes back |
| `channels:read` | List channels (useful for picking the target channel from a dropdown in admin UI, future) |

**Do not add user-token scopes.** Bot scopes only. (User-token scopes would let the bot act *as a user*, which we never want.)

### D. Install the app to the workspace

- [ ] Scroll up on the **OAuth & Permissions** page
- [ ] Click **Install to Workspace**
- [ ] Slack shows the permissions screen — workspace admin clicks **Allow**
  - **Note:** if you're not the workspace admin, this generates an admin approval request. The admin approves it from their side. Standard flow for non-admin app installation.

### E. Capture the tokens

After install completes:

- [ ] On **OAuth & Permissions**, copy the **Bot User OAuth Token** — starts with `xoxb-…`. **This is the secret.** Treat it like a password.
- [ ] Go to **Basic Information** (left nav)
- [ ] Under **App Credentials**, copy:
  - **Signing Secret** — hex string. Needed later when we add interactive buttons.
  - **Client ID** + **Client Secret** — only needed if we ever do per-user OAuth, not for v1.

**Where to store the tokens (until IT uploads to Secrets Manager):**

| Storage | OK? |
|---|---|
| 1Password / Bitwarden vault | Yes |
| Encrypted notes app | Yes |
| Local `.env` file on your dev machine (gitignored) | Yes for dev only |
| Slack DM to yourself | **No** — tokens in Slack history = compromised |
| Email | **No** |
| Committed to the repo | **Absolutely not** |
| Pasted in a meeting transcript / Notion page | **No** |

**Hand-off to IT:** when IT is ready for them, send via a secure channel (1Password share, encrypted email, or in-person). Do not paste in chat or email body.

### F. Add the bot to the target channel

- [ ] In Slack, create or pick the channel for live event status: `#game-day-ops` (recommended)
- [ ] In that channel, type: `/invite @quintar-game-day-ops` (or whatever you named the bot)
- [ ] Verify the bot appears in the channel member list
- [ ] **Copy the channel ID:** click the channel name at the top → scroll to the bottom of the dialog → there's a Channel ID like `C01ABC23DEF` next to a "Copy" button. This goes in env var `SLACK_CHANNEL_ID`.

---

## Collect team Slack User IDs

The bot DMs owners by their Slack **user ID** (a string like `U01ABC23DEF`), not by name or handle. We need to populate `roster.json` with these IDs.

### How to get a user ID

For each person:

1. In Slack, click their name anywhere (channel message, member list, etc.)
2. Their profile slide-out opens
3. Click the **⋮ More** button (next to the message/call buttons)
4. Click **Copy member ID**

Or, on desktop, with the profile open, you can sometimes see the ID at the bottom under "Member since". Easier: just use the **Copy member ID** menu option.

### Roster to collect

Fill in the table. Save it as `roster.json` in the project repo when complete.

| Display name | Slack handle | Slack User ID |
|---|---|---|
| Charles Johnson | @charlie | |
| Ted | @ted | |
| Kyle | @kyle | |
| Yogesh | @yogesh | |
| Vahagn | @vahagn | |
| Lakshay | @lakshay | |
| Rick | @rick | |
| Buddy | @buddy | |
| Durga Raj | @durga | |
| Wayne | @wayne | |
| Goutham | @goutham | |
| Rajesh | @rajesh | |
| Mikey | @mikey | |
| Atharva | @atharva | |

**Special entries** (no user ID needed — handled as group / placeholder):

| Display name | Type |
|---|---|
| Operations Team | Group — maps to `#ops` channel or similar; no DM target |
| TBD | Placeholder — no DM sent until assigned |

When complete, the file will look like:

```json
[
  { "name": "Charles Johnson", "slackHandle": "@charlie",  "slackUserId": "U01ABC23DEF" },
  { "name": "Ted",             "slackHandle": "@ted",      "slackUserId": "U01DEF45GHI" },
  ...
  { "name": "Operations Team", "isGroup": true,            "channelId": "C01OPSCHAN" },
  { "name": "TBD",             "isPlaceholder": true,      "slackUserId": null }
]
```

---

## Quick test (optional, before backend exists)

Once you have the bot token, you can verify it works with one `curl`:

```bash
export SLACK_BOT_TOKEN="xoxb-your-token-here"

curl -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "channel": "C01ABC23DEF",
    "text": "Quintar Game Day Ops bot is online. This is a test from the setup script."
  }'
```

If it works, the message appears in `#game-day-ops` and you'll see `"ok": true` in the response.

If you get `not_in_channel`, the bot needs to be invited (`/invite @quintar-game-day-ops`).
If you get `invalid_auth`, the token is wrong.
If you get `missing_scope`, you forgot to add a Bot Token Scope and reinstall.

---

## Hand-off summary

When the above is done, here's what gets shared with IT (via secure channel):

| Item | Where it lands |
|---|---|
| `SLACK_BOT_TOKEN` (`xoxb-…`) | AWS Secrets Manager, key `quintar-ops/prod/SLACK_BOT_TOKEN` |
| `SLACK_SIGNING_SECRET` | AWS Secrets Manager, key `quintar-ops/prod/SLACK_SIGNING_SECRET` |
| `SLACK_CHANNEL_ID` (`C01…`) | Env var on EC2 (non-secret, just config) |
| `roster.json` | Committed to repo at `frontend/roster.json` |

---

## Future Slack features (not in v1 — informational)

- **Interactive buttons** in DMs — "Mark Complete" / "Open Checklist" buttons. Requires the Signing Secret + a public-facing webhook endpoint (e.g. `api.quintar.ai/slack/interactivity`). Adds Slack scope `interactivity.write`.
- **Slash commands** — `/quintar-ops status` to query the current event from any channel. Requires another endpoint + scope.
- **Home tab** — the bot gets its own "Home" tab in Slack showing the live checklist for the current event. Adds `app_home_opened` event subscription.

None of these break the v1 design — they layer cleanly on top.

---

## Contact

Charles Johnson — Charlie@quintar.ai
Project repo — `github.com/designohmatic/quintar-game-day-ops`

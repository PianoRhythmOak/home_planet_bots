# Testing locally against Home Planet

Yes — the bot runs fine on your PC and connects to the real server. Discord bots open an
**outbound** websocket to Discord, so there's no port forwarding, no public IP, no tunnel. Your
laptop behind a router works exactly like a hosted box does.

The catch is that you're testing in a live community, so this setup keeps the blast radius small:
a second bot application, a hidden category, throwaway roles, and a separate database.

---

## One-time setup

### 1. Make a second bot application

**Do not run your local copy on the production token.** Both processes would connect, both would
receive every interaction, and both would act — two threads per click, two log entries, two role
grants. It looks exactly like a bug in the code.

So: Developer Portal → **New Application** → name it something like `Home Planet Verify (dev)` →
**Bot** → **Reset Token**. Enable **Server Members Intent** and **Message Content Intent** on it,
same as the real one. Invite it to Home Planet with the same permissions.

Put the token in `.env`:

```
DISCORD_TOKEN=the-production-token
DEV_DISCORD_TOKEN=the-dev-bot-token
```

`npm run dev` uses `DEV_DISCORD_TOKEN`. `npm start` uses `DISCORD_TOKEN`. If you skip this, the bot
warns you loudly at startup rather than quietly double-acting.

### 2. Build the test area

```bash
npm run setup:test -- --admin YOUR_USER_ID
```

That creates, inside Home Planet:

- a category **🔧 testing**, hidden from `@everyone`
- **#test-verification** and **#test-verify-logs** inside it
- roles **test-verified**, **test-unverified**, **test-staff** (no permissions, purely markers)

and writes `config.dev.json` pointing at all of them, with a separate database
(`data/bot.dev.db`), a 15-second delete delay and a 1-hour expiry so you're not waiting around.

It's safe to re-run — existing channels and roles are reused, permissions are merged rather than
replaced, and nothing is ever deleted. Add `--prefix qa` if you want different names.

Then give yourself the **test-staff** role so you can press Approve and Deny.

### 3. Run it

```bash
npm run dev
```

You'll see a DEV MODE banner listing exactly which channel and roles it's pointing at. Read it —
that banner is the difference between testing and accidentally verifying real members.

In **#test-verification**: `/verifycheck` first, then `/verifypanel`.

---

## How the two modes differ

| | `npm run dev` | `npm start` |
|---|---|---|
| Token | `DEV_DISCORD_TOKEN` | `DISCORD_TOKEN` |
| Config | `config.json` + `config.dev.json` on top | `config.json` only |
| Database | `data/bot.dev.db` | `data/bot.db` |
| `kickOnDeny` | forced off | as configured |
| Reload on save | yes | no |

Dev mode never touches the production database, even if `config.dev.json` is missing or forgets to
say so. And a test denial can't kick a real member — that setting is force-disabled and the bot
tells you it did so.

`npm run dev:prod-config` exists for the rare case where you want hot reload against the real
config. It does what it says; be careful.

---

## What to actually test

The happy path is the easy part. These are the cases worth walking through:

1. **Approve** — from an alt account (or ask another admin). Check: role granted, log entry with
   transcript in #test-verify-logs, thread gone after 15s.
2. **Deny** — the reason box appears, the reason lands in the log, the member never sees it.
3. **Close** — no roles touched, still logged.
4. **Double-click Approve** — press it twice fast, or have two staff press at once. The second
   press should say "already handled". Nothing should double up.
5. **Click the panel button twice** — second click should link to the existing thread, not open a
   second one.
6. **Click it while already verified** — should get "you're already verified".
7. **Non-staff presses Approve** — take off your test-staff role first. Should be refused.
8. **Restart mid-decision** — approve someone, then Ctrl+C before the 15s delete. Restart. The
   janitor should finish the deletion within 2 minutes.
9. **Leave mid-verification** — open a thread on an alt, then have the alt leave the server. Should
   log "abandoned" and clean up.
10. **Expiry** — set `staleThreadHours` to something tiny in `config.dev.json`, open a thread, wait.

To reset between runs: stop the bot, delete `data/bot.dev.db`, delete any leftover test threads.

---

## Gotchas

**Slash commands not appearing.** They register to `guildId` on startup, which is instant — but
your dev bot registers its own copy, so you'll see two of each command in the picker (one per bot).
Discord shows the bot's avatar next to each; pick the dev one. This is normal and goes away when
you stop the dev bot.

**"Interaction failed" on a button after a restart.** Buttons posted by the *dev* bot only work
while the dev bot is running, and vice versa. Panels aren't interchangeable between the two
applications — post a fresh panel in the test channel with the dev bot.

**The dev bot can't see the test channels.** The setup script grants access to whichever bot it
logged in as. If you ran it before setting `DEV_DISCORD_TOKEN`, re-run it now that it's set.

**Editing `config.json` or `config.dev.json` while running.** tsx watches `src/`, not JSON. Restart
after a config change.

**Testing the kick path.** `kickOnDeny` is force-disabled in dev, deliberately. If you genuinely
need to verify kicking works, do it in a throwaway server rather than Home Planet.

**Rate limits.** Rapid-fire testing (creating and deleting many threads in a minute) will hit
Discord's rate limiter. discord.js queues rather than failing, so things just get slow — that's the
library waiting, not the bot hanging.

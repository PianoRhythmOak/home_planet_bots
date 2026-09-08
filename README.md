# Home Planet Bots

TypeScript + discord.js base for Home Planet's bots, with verification as the first feature.

<https://github.com/PianoRhythmOak/home_planet_bots>

The point of the structure: bot #2 should be feature code and nothing else. Config loading, SQLite,
migrations, logging, slash-command registration, interaction routing, error handling and graceful
shutdown are all done once in `src/lib/` and shared.

---

## Quick start

```bash
npm install
cp .env.example .env        # put your bot token in DISCORD_TOKEN
#   fill in the IDs in config.json
npm run dev                 # hot reload while you work
```

Then in Discord: `/verifycheck` to confirm the setup, `/verifypanel` to post the panel.

| Script | What it does |
|---|---|
| `npm run dev` | Hot reload (tsx watch) **in dev mode** — uses `config.dev.json` and `DEV_DISCORD_TOKEN`. |
| `npm run setup:test` | Builds a hidden test category, channels and roles in your server, and writes `config.dev.json`. |
| `npm run build` | Compiles `src/` → `dist/`. |
| `npm start` | Runs the compiled build against production config. |
| `npm test` | Runs the automated unit and SQLite integration tests once. |
| `npm run test:watch` | Re-runs automated tests as files change. |
| `npm run typecheck` | Types only, no output. Good for a pre-commit hook. |
| `npm run dev:prod-config` | Hot reload against the *real* config. Rarely what you want. |

**Testing against the live server is covered in [TESTING.md](TESTING.md)** — read it before the
first `npm run dev`, since running your local copy on the production token makes the hosted bot and
your laptop both answer every interaction.

---

## Layout

```
src/
  index.ts                    entry point — three lines
  lib/                        the reusable base (feature-agnostic)
    bot.ts                    client, interaction routing, command registration, lifecycle
    config.ts                 defaults <- config.json <- .env, with validation
    db.ts                     SQLite connection + per-feature migrations
    logger.ts                 levelled logger
    types.ts                  Feature / Command / ComponentHandler / EventHandler contracts
  features/
    index.ts                  the registry — one array, add your feature here
    verification/
      index.ts                the Feature definition (wiring)
      commands.ts             /verifypanel /verifyopen /verifycheck /verifytest
      components.ts           button + modal handlers
      service.ts              the actual behaviour
      store.ts                ticket persistence
      janitor.ts              background cleanup
```

### Adding a feature

Create `src/features/welcome/index.ts`:

```ts
import { Events } from 'discord.js';
import { defineEvent, type Feature } from '../../lib/types.js';

export const welcomeFeature: Feature = {
  name: 'welcome',
  commands: [/* { data: builder.toJSON(), execute } */],
  components: [/* { customId: 'welcome:dismiss', execute } */],
  events: [
    defineEvent({
      event: Events.GuildMemberAdd,
      async execute(ctx, member) {
        ctx.log.info(`${member.user.tag} joined`);
      },
    }),
  ],
  setup(ctx) {/* migrations, timers */},
  teardown(ctx) {/* clear timers */},
};
```

Add it to the array in `src/features/index.ts`. Done — commands get registered, buttons get routed,
errors get caught and reported, and shutdown calls your teardown.

**`ctx`** (`BotContext`) is passed to everything: `{ client, config, db, log }`. Features shouldn't
reach for globals; take what you need from `ctx`.

**Component routing** matches `customId` exactly, or as a prefix when the incoming id looks like
`yourId:extra:bits` — those extra segments arrive as the `params` argument. So a button built with
`setCustomId('poll:vote:42')` routes to the handler registered as `poll:vote` with
`params = ['42']`. Handy for anything per-message or per-user.

**Migrations** are per feature. In `setup`, call
`migrate(ctx.db, 'yourFeature', ['CREATE TABLE ...'])` — append to the array to evolve the schema,
never edit or reorder what already shipped.

---

## Discord setup

1. <https://discord.com/developers/applications> → **New Application** → **Bot** → **Reset Token**,
   copy it into `.env`. Never paste a token in a channel; reset it if it leaks.
2. Same page, **Privileged Gateway Intents** — turn ON:
   - ✅ **Server Members Intent** (roles, and detecting when someone leaves)
   - ✅ **Message Content Intent** (readable transcripts)
3. **OAuth2 → URL Generator**: scopes `bot` **and** `applications.commands`. Permissions:

   View Channels · Send Messages · Send Messages in Threads · **Create Private Threads** ·
   **Manage Threads** · Embed Links · Attach Files · Read Message History · **Manage Roles** ·
   Kick Members *(only if you enable `kickOnDeny`)*

4. Invite it, then in **Server Settings → Roles** drag the bot's role **above** the Verified and
   Unverified roles. Discord won't let a bot touch a role above its own. `/verifycheck` catches this.

### Channels

- **#verification** — a normal text channel. Announcement and forum channels can't have private
  threads.
- **#verify-logs** — staff only.

Turn on Developer Mode (User Settings → Advanced) to right-click → **Copy ID**.

### The private-thread gotcha

A private thread is visible only to people **added to it**, plus anyone with **Manage Threads** in
that channel. Pinging a *role* does not add anyone. Pick one:

- Give staff roles **Manage Threads** on #verification, and set `addStaffToThread` to `false`.
  Cleanest — every thread shows up in their sidebar.
- Or leave `addStaffToThread` at `true` and the bot adds each staff member individually. No extra
  permissions needed, but everyone gets a notification per thread. `maxStaffAdded` caps it.

`/verifycheck` tells you which case each staff role is in.

---

## Config

Layering: **defaults → `config.json` → `config.dev.json` (dev only) → `.env` / environment.**

`config.json` holds everything; `.env` overrides it and is the right place for the token.
**All IDs are strings** — Discord snowflakes are bigger than JSON can safely hold as numbers, and
unquoting them corrupts them. The bot validates this at startup and tells you which key is wrong.

| Key | Meaning |
|---|---|
| `guildId` | Home Planet's server ID. Set it — commands register instantly instead of taking an hour. |
| `databasePath` | SQLite file. Default `./data/bot.db`. |
| `verification.channelId` | #verification |
| `verification.logChannelId` | #verify-logs |
| `verification.staffRoleIds` | Who can press Approve/Deny. Empty = falls back to Manage Server. |
| `verification.verifiedRoleId` | Granted on approve. `""` = don't touch roles. |
| `verification.unverifiedRoleId` | Removed on approve. `""` = skip. |
| `verification.assignUnverifiedOnJoin` | Grant that role when someone joins (default `true`). Turn it off if Discord onboarding or another bot already does it. |
| `verification.welcomeDmOnJoin` | DM new joiners a nudge toward the panel (default `false`). |
| `verification.deleteDelaySeconds` | How long the thread lingers after a decision (default 60). |
| `verification.staleThreadHours` | Auto-close threads staff never answered (default 24, `0` = never). |
| `verification.kickOnDeny` | Kick the member when denied. |
| `verification.addStaffToThread` | See the gotcha above. |
| `verification.transcriptIncludeAttachments` | **Read the privacy note below before enabling.** |

Everything else in `verification` is wording — panel text, button label, thread intro, approval and
denial messages. `{user}` in `threadIntro` becomes an @mention; `welcomeDmMessage` also takes
`{server}` and `{channel}`.

---

## Deploying

**On [bot-hosting.net](https://bot-hosting.net/a) (or any Pterodactyl panel) — follow [DEPLOY.md](DEPLOY.md).** It covers the
two things that trip up a first deploy: the panel never compiles TypeScript, and better-sqlite3
needs a Node version it has a prebuilt Linux binary for.

**Plain Node** (any VPS, Pterodactyl panel, your own box):

```bash
npm ci && npm run build && npm start
```

Keep it alive with pm2, a systemd unit, or whatever your panel provides. `data/` must persist
between restarts — that's where open tickets are tracked.

**Docker:**

```bash
docker build -t homeplanet-bots .
docker run -d --name homeplanet-bots \
  --env-file .env \
  -v $(pwd)/config.json:/app/config.json:ro \
  -v homeplanet-data:/app/data \
  --restart unless-stopped \
  homeplanet-bots
```

The image deliberately doesn't bake in `config.json` or `.env`, so a built image never carries your
token. The named volume keeps the SQLite file across redeploys.

---

## How verification behaves

**Member clicks the button**

- Already verified → quiet "you're already verified".
- Already has a thread → link to it, no second thread.
- Otherwise a private thread `verify-username` opens with their account age and join date shown
  (useful for spotting fresh alts).

**Approve** → verified role added, unverified removed, log + transcript to the staff channel, thread
deletes after the delay.

**Deny** → optional reason box (staff-only; the member never sees it), optional kick, same logging
and deletion.

**Close** → for trolls and bots. Logged, thread deleted, no roles touched.

**Nobody answers** → auto-closed after `staleThreadHours` and logged as expired.

**Member leaves mid-verification** → noticed, logged, cleaned up.

**A new member joins** → unverified role granted (see `assignUnverifiedOnJoin`), optional welcome DM.
Nothing else happens until they press the panel button themselves.

**Two staff hit Approve at once** → only the first counts; the second gets "already handled". The
claim is a single synchronous SQL `UPDATE ... WHERE status='open'`, so there's no window between
check and write for a second click to slip through.

**The bot restarts mid-anything** → SQLite remembers. A sweep runs every 2 minutes and finishes
whatever was pending.

---

## Testing the flow without a spare account

Staff are verified by definition, so the panel button just tells you you're already verified.
`/verifytest` (staff only) gets around that. It has three modes:

| Mode | What it does |
|---|---|
| `dry-run` | Traces the whole flow — join, panel, thread, decision, log, cleanup — and reports where a real member would get stuck. **Changes nothing.** Start here. |
| `join` | Runs the join handler against you for real: grants you the unverified role and sends the welcome DM if it's on. Take the role back off yourself afterwards. |
| `ticket` | Opens a real verification thread for you, skipping the already-verified check. |

A `ticket` drill is the real code path — real thread, real roles, real log entry, real transcript,
real deletion — with three deliberate differences, all of them visible in the thread:

- the thread is named `TEST-verify-*` and the intro says it's a drill,
- staff are shown in the ping but **not actually notified**,
- **Deny will not kick you**, even with `kickOnDeny` on.

That last one is why the flag lives in the database rather than being read off the thread name — a
restart between opening and denying must not quietly re-arm the kick against a moderator.

`/verifycheck` and `/verifytest dry-run` overlap on permissions but answer different questions:
`verifycheck` is "is this configured right", `dry-run` is "if someone joined right now, what
would happen to them".

---

## Privacy note — please read this one

`transcriptIncludeAttachments` is **off** by default on purpose. Off, a transcript records
`(attachment omitted: photo.png, 482913 bytes)` rather than a link.

If staff ever ask someone for a photo of an ID, turning it on means links to those images sit in
your log channel permanently, openable by every staff member including future ones. That's a real
liability for a 21+ server. Leave it off unless you have a specific reason.

Lower-risk age checks that work well in a thread: a quick voice or video check, a handwritten note
with their username and today's date, or an ID with everything except the birth year covered,
reviewed live and never saved. Whatever you choose, say so up front — that's what `panelDescription`
and `threadIntro` are for.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Slash commands don't appear | Set `guildId` and restart. Global registration can take an hour. |
| "Discord refused to register slash commands" in the log | Bot was invited without the `applications.commands` scope. Re-invite it. |
| "I don't have permission to create private threads" | Bot needs **Create Private Threads** in that channel — check channel overrides, not just server-wide perms. |
| Staff get pinged but can't open the thread | The private-thread gotcha above. |
| Threads never delete | Missing **Manage Threads**. The bot parks a thread it can't delete after logging it, rather than retrying forever. |
| Approve works but no role appears | Bot's role is below the verified role. Drag it up. |
| `Used disallowed intents` on startup | Turn on Server Members + Message Content in the Developer Portal. |
| `better-sqlite3` fails to install | Needs a matching prebuilt binary or a compiler. `npm rebuild better-sqlite3`, or use the Dockerfile, which installs build tools. |
| Config problems at startup | The bot prints exactly which key is wrong and why. Check the console first. |

Set `LOG_LEVEL=debug` in `.env` for verbose output while debugging.

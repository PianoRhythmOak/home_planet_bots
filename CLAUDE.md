# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev         # tsx watch src/index.ts — hot reload
npm run build       # tsc → dist/
npm start           # node dist/index.js (production)
npm run typecheck   # tsc --noEmit — the only automated check in the repo
npm run clean       # remove dist/
```

There is no test suite, linter, or formatter configured. `npm run typecheck` is the gate before committing.
TypeScript is `strict` with `noUncheckedIndexedAccess`, ESM (`"type": "module"`, `module: NodeNext`) — **relative imports must carry the `.js` extension**, even from `.ts` sources.

Set `LOG_LEVEL=debug` in `.env` for verbose logs.

## Architecture

Two layers, deliberately separated: `src/lib/` is a feature-agnostic Discord bot runtime; `src/features/` is behaviour. The goal is that a second bot feature is feature code and nothing else — command registration, interaction routing, error handling, migrations, and shutdown are all done once in `lib/`.

**`lib/bot.ts` (`Bot` class)** owns the whole lifecycle. It builds the client, collects each feature's commands/components/events into `Collection`s (throwing on duplicate command names or customIds), and on `ClientReady` runs every `feature.setup()` **before** publishing slash commands — a REST call under a 429 can take seconds, and a button clicked in that window would hit uninitialised feature state. `safeDispatch` is the single place interaction errors land; without it a throw shows the user "This interaction failed" with nothing logged. SIGINT/SIGTERM call every `teardown()`, then destroy the client and close the DB.

**Adding a feature**: write `src/features/<name>/index.ts` exporting a `Feature` (see `lib/types.ts`), add it to the array in `src/features/index.ts`. Nothing else. Features receive `BotContext` (`{ client, config, db, log }`) as an argument and should never reach for module globals.

**Component routing** is longest-prefix on `customId`. A button with `setCustomId('verify:approve:123')` routes to the handler registered as `verify:approve`, with `['123']` arriving as `params`. Use this to encode per-message/per-user state in the id.

**`lib/config.ts`**: defaults ← `config.json` ← env vars (env wins, so the token stays out of JSON). `config.json` and `.env` are both gitignored; `.env.example` is the template. **All Discord IDs are strings** — snowflakes exceed `Number.MAX_SAFE_INTEGER` and unquoting them corrupts them silently. `validate()` regex-checks every ID at startup and exits only if the token is missing; other problems log and continue. Keys starting with `_` in `config.json` are skipped so `_comment` entries work.

**`lib/db.ts`**: better-sqlite3, **synchronous on purpose**. The synchrony is load-bearing, not laziness — it gives atomic claims with no `await` gap. Migrations are forward-only and tracked **per feature** in a `schema_versions` table (not SQLite's `user_version`, which is database-global and would make a second feature inherit the first's version and skip its own table creation). Call `migrate(db, 'yourFeature', [...])` from `setup`; append to the array, never edit or reorder a shipped migration.

## The verification feature

`service.ts` holds all behaviour; `commands.ts` and `components.ts` are thin wrappers over it. `store.ts` persists one row per open thread so a restart loses nothing. `janitor.ts` sweeps every 2 minutes to finish interrupted deletions and expire threads staff never answered.

Several non-obvious invariants are documented in-code and must be preserved when editing:

- **Claim-then-act.** `store.claim()` is a single synchronous `UPDATE ... WHERE status='open'`; it returns false if someone else got there first. That is the only thing preventing two staff hitting Approve simultaneously from granting roles twice and logging twice. Never insert an `await` between reading status and claiming.
- **Defer before claim.** `finalizeTicket` acks the interaction *before* claiming — if the ack 10062s, a already-claimed ticket would be stuck `closing` with no role, no log, and no way to retry.
- **`claim()` writes a generous 10-minute fallback `delete_at`, not the real one.** The real delete time is written by `finish()` after the transcript is built; writing it early would let the janitor delete the thread mid-transcript.
- **`lookupThread` returns three states** — `found` / `gone` / `unknown`. Never collapse `unknown` into `gone`: a 500 or rate-limit is not proof of deletion, and treating it as such drops the DB row while the thread lives on. Archived threads are evicted from cache, so a cache miss must always be confirmed against the API.
- **Member cache must be warmed.** `role.members` reads cache only and never fetches; without `warmMemberCache`, offline staff are silently omitted from threads after a restart.
- **`Partials.GuildMember` is required** in the client options or discord.js drops `guildMemberRemove` entirely for uncached members.
- **Undeletable threads get parked**, not retried — missing Manage Threads calls `store.fail()` rather than looping every 2 minutes forever.
- Timestamps go in via `toISOString()` throughout, because the janitor's due-query relies on lexicographic comparison of ISO-8601 UTC strings.

## Privacy

`transcriptIncludeAttachments` defaults to **off** deliberately. This is a 21+ server; turning it on means links to any ID photos staff requested sit permanently in the log channel, readable by every current and future staff member. Don't flip the default or suggest enabling it casually — see the README's privacy note.

## Deployment

Plain Node (`npm ci && npm run build && npm start`) or the included Dockerfile. The image deliberately bakes in neither `config.json` nor `.env`, so a built image never carries the token — both are mounted at run time. `data/` must persist across restarts; it holds the open-ticket state.

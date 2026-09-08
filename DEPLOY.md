# Deploying to bot-hosting.net

bot-hosting.net runs a Pterodactyl panel. Three things about it drive everything below:

1. **It runs `node <entry file>`. It never runs `tsc` for you.** TypeScript has to be compiled
   somewhere — on your machine before upload, or on the container at boot.
2. **It runs `npm install` itself**, but the container has no C compiler. `better-sqlite3` is a
   native module, so it must find a *prebuilt* Linux binary — which means the panel's Node version
   has to be one that a prebuilt exists for. See
   [Node version](#node-version-this-is-the-one-that-bites): the single most likely thing to break
   your first deploy.
3. **`dist/`, `config.json` and `.env` are all gitignored**, so none of them arrive via GitHub. This
   is the thing that makes the GitHub route different from the zip route, and it's handled below.

---

## Route A — GitHub (what this repo is set up for)

The panel clones your repo into `/home/container`. Since `dist/` isn't committed, **the container
builds on boot**.

### 1. Link the repo

GitHub tab → connect the repository → pick the branch you deploy from (`main`).

Pushing a broken commit takes the bot down on its next restart, so let CI be the gate:
`.github/workflows/ci.yml` already runs `npm run typecheck` and `npm test` on every push. Don't
deploy a red commit.

### 2. Startup tab

| Setting | Value |
|---|---|
| Runtime | Node.js |
| Version | **22** (or 20) — see below |
| Entry file (`STARTUP_FILE`) | `dist/index.js` |

**Entry file must be `dist/index.js`, not `index.js`.** There is no `index.js` at the container
root — the entry point is compiled output. Getting this wrong fails every boot with
`Cannot find module '/home/container/index.js'`.

Start command:

```sh
cd /home/container && npm install --no-fund --no-audit && npm run build && exec node ${STARTUP_FILE}
```

Note there is **no `--omit=dev` on this route** — `npm run build` needs `typescript`, which is a
devDependency. That costs ~26 MB of disk and a few seconds of `tsc` on each restart. That is the
price of not committing build output; if you'd rather not pay it, use [Route B](#route-b--zip-upload).

Keep the `exec`. It makes Node PID 1, so the panel's **Stop** delivers `SIGTERM` directly to it —
that's what runs each feature's `teardown()` and closes SQLite cleanly.

Changing Runtime or Version rebuilds the container (files are preserved); changing the entry file
only restarts. After **Save & Apply**, check the *Active Config* panel actually reflects the new
values — the form shows your edit before it has been applied.

### 3. Supply the config the repo doesn't carry

`config.json` and `.env` are gitignored on purpose — the token must never reach GitHub. So the
container needs them from somewhere else:

**The token → Env tab.** `config.ts` layers `defaults <- config.json <- env`, with env winning, so
`DISCORD_TOKEN` set there overrides everything and the token never lands on disk. Delete the `token`
and `_token` keys from the `config.json` you upload.

**Everything else → upload `config.json` once** via File Manager → **New File**, at the top level
beside `package.json`. It's untracked, so `git pull` leaves it alone and you only do this once.

You *could* instead set the IDs as env vars — `GUILD_ID`, `VERIFICATION_CHANNEL_ID`,
`LOG_CHANNEL_ID`, `VERIFIED_ROLE_ID`, `UNVERIFIED_ROLE_ID`, `STAFF_ROLE_IDS` (comma-separated) are
all read — but only those. The panel text, `statusText`, `deleteDelaySeconds`, `staleThreadHours`
and the rest have no env equivalent and would silently fall back to the defaults in `config.ts`,
losing your customised panel and thread copy. Upload the file.

Resulting layout:

```
/home/container/
  src/  dist/  test/  scripts/     <- from git; dist/ built at boot
  node_modules/                    <- installed at boot
  data/                            <- created on first run, holds bot.db
  package.json  package-lock.json
  config.json                      <- you upload this, untracked
```

---

## Route B — zip upload

Build here, upload compiled output, no toolchain on the container.

```bash
npm run typecheck && npm test    # don't ship red
npm run package
```

That writes `deploy/home-planet-bots.zip` (~56 KB) with `dist/`, `package.json` and
`package-lock.json`. File Manager → **Upload** → right-click → **Unarchive**.

`node_modules` is left out deliberately: your local `better-sqlite3` holds a Windows `.node` binary
that is useless on their Linux box and would shadow the correct one the panel installs.

Same Startup settings as Route A, except the start command can skip the build and the dev
dependencies:

```sh
cd /home/container && if [ -f package.json ]; then npm install --omit=dev --no-fund --no-audit; fi && exec node ${STARTUP_FILE}
```

Config works the same way — Env tab for the token, `config.json` uploaded once. Or
`npm run package -- --with-secrets` to include `.env` and `config.json` in the bundle; the zip then
holds your bot token, so delete it from Downloads afterwards.

---

## Node version — this is the one that bites

`better-sqlite3@11` publishes prebuilt Linux binaries for Node **18, 20, 22 and 23 only**
(ABI 108/115/127/131). There is no Node 24 build. On Node 24 the panel's `npm install` falls back to
compiling from source, finds no `python3`/`g++`, and the deploy dies with something like:

```
gyp ERR! find Python
```

or, if install "succeeded" oddly, at boot:

```
Error: Could not locate the bindings file
```

**Fix: set the panel's Node version to 22.** `package.json` declares `"node": ">=20.10.0 <24"` so
`npm install` warns you rather than failing silently.

If you ever want Node 24, bump `better-sqlite3` to `^12` (which ships ABI 137 prebuilds) and rerun
`npm test` before shipping.

---

## Verifying it came up

Console tab, on a healthy start:

```
[config] Loaded config.json
[db]     Database ready at /home/container/data/bot.db
[verification] Running 1 migration(s) for "verification" (at version 0)
[bot]    Logged in as <name>#0000
[bot]    Registered N command(s)
```

Then in Discord run **`/verifycheck`** — it validates the channel and role IDs against the live
guild, which is the fastest way to catch a mistyped or missing snowflake. Only once that's clean,
post the panel with `/verifypanel`.

Set `LOG_LEVEL=debug` in the Env tab if you need more.

### An empty ID is not an error

`validate()` only complains about an ID that is present *and* malformed. A setting left as `""` is
skipped silently — the bot boots looking perfectly healthy, and then approvals grant no role because
`verifiedRoleId` was never filled in. `/verifycheck` is what catches this; the console won't.

---

## `data/` must survive

`data/bot.db` is the open-ticket state. Restarts and `git pull` keep it — it's untracked, and pulls
don't touch untracked files.

What does destroy it: **"Reinstall Server"**, which wipes the container and with it every in-flight
verification thread. Download `data/` first if you ever use it.

A restart mid-ticket is otherwise safe: the janitor sweeps every 2 minutes and finishes whatever was
interrupted.

## Redeploying

**Route A:** push to the deploy branch (green CI), then Pull in the GitHub tab and **Restart**. The
boot rebuild picks up the new code.

**Route B:** `npm run package`, upload, unarchive, overwrite, **Restart**.

Neither touches `config.json` or `data/`.

## Stopping cleanly

Use the panel's **Stop**, not Kill. Stop sends `SIGTERM`, which runs every feature's `teardown()`
and closes SQLite properly. Kill is a `SIGKILL`; WAL mode means you won't lose the database, but an
in-flight transcript can be cut short.

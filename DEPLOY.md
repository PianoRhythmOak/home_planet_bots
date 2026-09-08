# Deploying to bot-hosting.net

bot-hosting.net runs a Pterodactyl panel. Three things about it drive everything below:

1. **It runs `node <entry file>`. It never runs `tsc` for you.** TypeScript has to be compiled
   somewhere — on your machine before upload, or on the container at boot.
2. **It runs `npm install` itself**, but the container has no C compiler. `better-sqlite3` is a
   native module, so it needs a *prebuilt* Linux binary — which means both the Node version and
   npm's install-script policy have to cooperate. See
   [Could not locate the bindings file](#error-could-not-locate-the-bindings-file): between them,
   the most likely thing to break your first deploy.
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
cd /home/container && npm install --no-fund --no-audit && if ! node -e "require('better-sqlite3')" 2>/dev/null; then npm rebuild better-sqlite3 --no-fund; fi && npm run build && exec node ${STARTUP_FILE}
```

Note there is **no `--omit=dev` on this route** — `npm run build` needs `typescript`, which is a
devDependency. That costs ~26 MB of disk and a few seconds of `tsc` on each restart. That is the
price of not committing build output; if you'd rather not pay it, use [Route B](#route-b--zip-upload).

The `if ! node -e "require('better-sqlite3')"` guard is load-bearing on a host that blocks
install scripts — see [the bindings error](#error-could-not-locate-the-bindings-file). It costs one
process spawn on a healthy boot and repairs the tree on a broken one.

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
cd /home/container && npm install --omit=dev --no-fund --no-audit && if ! node -e "require('better-sqlite3')" 2>/dev/null; then npm rebuild better-sqlite3 --no-fund; fi && exec node ${STARTUP_FILE}
```

Config works the same way — Env tab for the token, `config.json` uploaded once. Or
`npm run package -- --with-secrets` to include `.env` and `config.json` in the bundle; the zip then
holds your bot token, so delete it from Downloads afterwards.

---

## `Error: Could not locate the bindings file`

`better-sqlite3` installed, but its compiled `.node` binary is missing. Two different causes —
check the `npm install` output before assuming which:

### Cause 1: npm blocked the install script (most likely)

```
npm warn install-scripts 2 packages had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   better-sqlite3@11.10.0 (install: node-gyp rebuild)
```

npm 12 blocks dependency install scripts by default. For `better-sqlite3` that script *is* the
download step —

```json
"install": "prebuild-install || node-gyp rebuild --release"
```

— so blocking it means `prebuild-install` never runs and no binary is ever fetched. Nothing to do
with the compiler, and it happens even on a perfectly good Node version.

Fixed by the `allowScripts` field in `package.json`:

```json
"allowScripts": {
  "better-sqlite3": true,
  "esbuild": true
}
```

Entries are name-only rather than pinned (`better-sqlite3@11.10.0`) so a patch bump doesn't
silently re-break the deploy.

**Adding the field is not enough on its own.** npm sees the package as already installed and reports
`up to date` without re-running anything, so a container that already failed this way stays broken.
That's what the `npm rebuild better-sqlite3` guard in the start command is for — it re-runs the
install script on a tree that's already there. Failing that, delete `node_modules` in the File
Manager and restart.

### Cause 2: the Node version has no prebuild

`better-sqlite3@11` publishes prebuilt Linux binaries for Node **18, 20, 22 and 23 only**
(ABI 108/115/127/131). There is no Node 24 build, so on Node 24 the install script falls back to
compiling from source, finds no `python3`/`g++`, and dies with `gyp ERR! find Python`.

The bottom line of the error tells you which case you're in — it names the ABI it looked for:

```
→ .../better-sqlite3/lib/binding/node-v127-linux-x64/better_sqlite3.node
```

`node-v127` is Node 22, which *does* have a prebuild — so that message means Cause 1, not a version
problem. `node-v137` would mean Node 24 and Cause 2.

**Fix for Cause 2: set the panel's Node version to 22.** `package.json` declares
`"node": ">=20.10.0 <24"` so npm warns rather than failing silently. If you ever want Node 24, bump
`better-sqlite3` to `^12` (which ships ABI 137 prebuilds) and rerun `npm test` before shipping.

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

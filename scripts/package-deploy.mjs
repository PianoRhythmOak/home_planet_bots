/**
 * Builds the upload bundle for a Pterodactyl-style panel (bot-hosting.net).
 *
 * The panel runs `node <entry file>` — it never runs `tsc` — so the compiled
 * `dist/` has to go up with the bundle. It DOES run `npm install` when it sees
 * a package.json, which is why node_modules is deliberately left out: the
 * native better-sqlite3 binary in a local Windows/macOS tree is useless on
 * their Linux box and would shadow the correct one.
 *
 *   node scripts/package-deploy.mjs                 code only
 *   node scripts/package-deploy.mjs --with-secrets  also .env + config.json
 *
 * Secrets are opt-in: the default bundle is safe to leave sitting in Downloads.
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deploy');
const STAGE = join(OUT, 'bundle');
const ZIP = join(OUT, 'home-planet-bots.zip');

const withSecrets = process.argv.includes('--with-secrets');

// Always shipped. package-lock.json matters most: it pins better-sqlite3 to a
// version whose prebuilt Linux binary matches the panel's Node, so the panel's
// npm install never has to compile from source (it has no compiler).
const REQUIRED = ['dist', 'package.json', 'package-lock.json'];
const SECRETS = ['.env', 'config.json'];

const missing = REQUIRED.filter((f) => !existsSync(join(ROOT, f)));
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}\nRun \`npm run build\` first.`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const copied = [];
for (const name of REQUIRED) {
  cpSync(join(ROOT, name), join(STAGE, name), { recursive: true });
  copied.push(name);
}

if (withSecrets) {
  for (const name of SECRETS) {
    if (existsSync(join(ROOT, name))) {
      cpSync(join(ROOT, name), join(STAGE, name));
      copied.push(name);
    } else {
      console.warn(`! ${name} not found locally — skipped`);
    }
  }
}

const count = zipDirectory(STAGE, ZIP);

rmSync(STAGE, { recursive: true, force: true });

const mb = (statSync(ZIP).size / 1024 / 1024).toFixed(2);
console.log(`\n  ${ZIP}  (${mb} MB)`);
console.log(`  ${count} files — ${copied.join(', ')}`);
if (!withSecrets) {
  console.log('\n  No .env / config.json in this bundle — upload them by hand,');
  console.log('  or re-run with --with-secrets. See DEPLOY.md.');
}

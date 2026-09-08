/**
 * Minimal ZIP writer (deflate), because the platform tools aren't usable here:
 * Windows PowerShell's Compress-Archive nests everything under the staging
 * folder AND writes `\` path separators, which Pterodactyl's unarchiver treats
 * as literal characters — you end up with one file called `bundle\dist\index.js`
 * instead of a tree. GNU tar can't write zip at all. So: 80 lines, no deps,
 * forward slashes, identical output on every platform.
 */

import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date/time, which is all the ZIP header has room for. */
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function walk(dir, base, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(full);
  }
  return out;
}

/** Zips the CONTENTS of `dir` (no wrapping folder) to `zipPath`. */
export function zipDirectory(dir, zipPath) {
  const files = walk(dir, dir);
  const local = [];
  const central = [];
  let offset = 0;

  for (const full of files) {
    // ZIP entries are forward-slash by spec; on Windows `relative` hands back
    // the platform separator, and shipping that is exactly the bug this writer
    // exists to avoid.
    const name = relative(dir, full).split(sep).join('/');
    const raw = readFileSync(full);
    const deflated = deflateRawSync(raw);
    // Storing is smaller than deflating for already-compressed or tiny files.
    const store = deflated.length >= raw.length;
    const body = store ? raw : deflated;
    const method = store ? 0 : 8;
    const { time, day } = dosStamp(statSync(full).mtime);
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(day, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(day, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38); // unix mode: regular file, rw-r--r--
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  writeFileSync(zipPath, Buffer.concat([...local, centralBuf, eocd]));
  return files.length;
}

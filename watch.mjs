import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';

const directory = new URL('./state/', import.meta.url);
const statePath = new URL('baseline.json', directory);

async function fetchPublic(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response;
}

function inventory(raw) {
  if (raw.length < 28 || raw.toString('ascii', 0, 4) !== 'RMAN' || raw[4] !== 2) {
    throw new Error('Unsupported RMAN header');
  }
  const offset = raw.readUInt32LE(8);
  const end = offset + raw.readUInt32LE(12);
  if (offset < 28 || end > raw.length) throw new Error('Invalid RMAN body');
  const body = raw.subarray(offset, end);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const frames = [];
  for (let start = body.indexOf(magic); start >= 0;) {
    const next = body.indexOf(magic, start + magic.length);
    frames.push(zstdDecompressSync(body.subarray(start, next < 0 ? body.length : next),
      { maxOutputLength: 32 * 1024 * 1024 }));
    start = next;
  }
  const buf = Buffer.concat(frames);
  const u32 = (pos) => buf.readUInt32LE(pos);
  const u64 = (pos) => pos ? buf.readBigUInt64LE(pos) : 0n;
  function field(table, index) {
    const vtable = table - buf.readInt32LE(table);
    const slot = 4 + index * 2;
    const offset = slot < buf.readUInt16LE(vtable) ? buf.readUInt16LE(vtable + slot) : 0;
    return offset ? table + offset : 0;
  }
  function vector(table, index) {
    const pos = field(table, index);
    if (!pos) return [0, 0];
    const target = pos + buf.readInt32LE(pos);
    return [target + 4, u32(target)];
  }
  function name(table, index) {
    const [start, length] = vector(table, index);
    return buf.toString('utf8', start, start + length);
  }
  function entries(table, index) {
    const [start, count] = vector(table, index);
    if (start + count * 4 > buf.length) throw new Error('Invalid RMAN vector');
    return Array.from({ length: count }, (_, i) => {
      const pos = start + i * 4;
      return pos + buf.readInt32LE(pos);
    });
  }
  const root = u32(0);
  const dirs = new Map(entries(root, 3).map((table) => [
    u64(field(table, 0)), { name: name(table, 2), parent: u64(field(table, 1)) },
  ]));
  const files = Object.create(null);
  for (const table of entries(root, 2)) {
    const parts = [name(table, 3)];
    let id = u64(field(table, 1));
    for (let depth = 0; id !== 0n; depth++) {
      const dir = dirs.get(id);
      if (!dir || depth > 128) throw new Error('Invalid RMAN directory');
      if (dir.name) parts.unshift(dir.name);
      id = dir.parent;
    }
    const [start, count] = vector(table, 5);
    if (!parts.at(-1) || start + count * 8 > buf.length) throw new Error('Invalid RMAN file');
    const digest = createHash('sha256').update(buf.subarray(start, start + count * 8)).digest('hex');
    const path = parts.join('/');
    const fingerprint = `${u32(field(table, 2))}:${digest}`;
    (files[path] ??= []).push(fingerprint);
  }
  for (const fingerprints of Object.values(files)) fingerprints.sort();
  if (!Object.keys(files).length) throw new Error('Empty RMAN inventory');
  return files;
}

const config = await (await fetchPublic('https://clientconfig.rpg.riotgames.com/api/v1/config/public?namespace=keystone.products.valorant.patchlines')).json();
const live = config['keystone.products.valorant.patchlines.live'];
const patchUrl = live?.platforms?.win?.configurations.find((entry) => entry.id === 'ap')?.patch_url;
const manifestId = /^https:\/\/valorant\.secure\.dyn\.riotcdn\.net\/channels\/public\/releases\/([0-9A-F]{16})\.manifest$/i.exec(patchUrl)?.[1];
if (!manifestId) throw new Error('AP Windows manifest URL missing or unexpected');
const observedAt = new Date().toISOString();
let previous;
try {
  previous = JSON.parse(await readFile(statePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous?.manifestId === manifestId) {
  console.log(JSON.stringify({ status: 'unchanged', manifestId, observedAt }));
} else {
  const raw = Buffer.from(await (await fetchPublic(patchUrl)).arrayBuffer());
  const files = inventory(raw);
  const current = { manifestId, observedAt, files };
  const summary = { status: 'baseline', manifestId, observedAt, files: Object.keys(files).length };
  await mkdir(directory, { recursive: true });
  if (previous) {
    const added = Object.keys(files).filter((path) => !Object.hasOwn(previous.files, path));
    const removed = Object.keys(previous.files).filter((path) => !Object.hasOwn(files, path));
    const changed = Object.keys(files).filter((path) =>
      Object.hasOwn(previous.files, path) && JSON.stringify(files[path]) !== JSON.stringify(previous.files[path]));
    const mapCandidates = [...added, ...changed].filter((path) => /(?:^|\/)(?:maps?|levels?)(?:\/|$)/i.test(path));
    const report = { ...summary, status: 'changed', previousManifestId: previous.manifestId, patchUrl, added, removed, changed, mapCandidates };
    await writeFile(new URL(`diff-${previous.manifestId}-${manifestId}.json`, directory), JSON.stringify(report, null, 2));
    Object.assign(summary, { status: 'changed', added: added.length, removed: removed.length, changed: changed.length, mapCandidates: mapCandidates.slice(0, 8), patchUrl });
  }
  const temporary = new URL(`baseline-${process.pid}.tmp`, directory);
  await writeFile(temporary, JSON.stringify(current));
  await rename(temporary, statePath);
  console.log(JSON.stringify(summary));
}




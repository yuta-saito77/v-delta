import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const stateDir = 'state';
await mkdir(stateDir, { recursive: true });
const statePath = join(stateDir, 'news.json');
let state = { notes: '13.10', pending: [] };
try {
  state = JSON.parse(await readFile(statePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function save() {
  await writeFile(statePath + '.tmp', JSON.stringify(state, null, 2));
  await rename(statePath + '.tmp', statePath);
}
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.text();
}
const origin = 'https://playvalorant.com';
const locales = ['ja-jp', 'en-us'];
const newer = (a, b) => {
  const [am, ap] = a.split('.').map(Number);
  const [bm, bp] = b.split('.').map(Number);
  return am > bm || (am === bm && ap > bp);
};
function newsLinks(html, locale) {
  const pattern = new RegExp(`/${locale}/news/game-updates/valorant-patch-notes-(\\d{2})(?:-)?(\\d{2})(?=[/"?#]|$)`, 'gi');
  return Array.from(html.matchAll(pattern), ([path, major, minor]) =>
    ({ version: `${major}.${minor}`, url: origin + path, locale }));
}
function clean(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();
}
const sourceChecks = await Promise.allSettled([
  Promise.resolve().then(() => {
    const result = JSON.parse(execFileSync(process.execPath, ['watch.mjs'], { encoding: 'utf8', timeout: 65000 }));
    if (result.status !== 'changed') return;
    const counts = `追加 ${result.added} / 削除 ${result.removed} / 変更 ${result.changed}`;
    const candidates = result.mapCandidates.length
      ? `\n未確認のマップ関連候補（ファイル名で判定）\n${result.mapCandidates.join('\n').slice(0, 650)}` : '';
    state.pending.push({
      discord: `【新ビルド検知】AP・PC版\n${result.previousManifestId} → ${result.manifestId}\n${counts}${candidates}`,
      x: `【V-Delta｜新ビルド検知】VALORANT AP・PC版の配信情報が更新されました。\n${counts}\n変更内容・プレイ開始時刻は未確認です。`,
    });
  }),
  (async () => {
    const pages = await Promise.allSettled(locales.map(async (locale) =>
      newsLinks(await get(`${origin}/${locale}/news/tags/patch-notes/`), locale)));
    const links = pages.flatMap((page) => page.status === 'fulfilled' ? page.value.slice(0, 1) : []);
    if (!links.length) throw new Error('No patch note links found');
    const latest = links.reduce((a, b) => newer(b.version, a.version) ? b : a);
    if (!newer(latest.version, state.notes)) return;
    const article = await get(latest.url);
    const description = clean(article.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] ?? '');
    const japanese = latest.locale === 'ja-jp';
    const header = `【公式パッチノート公開】VALORANT ${latest.version}${japanese ? '' : '（英語版）'}`;
    const excerpt = description ? `\n公式ページの概要：${description.slice(0, 480)}` : '';
    state.pending.push({ discord: `${header}${excerpt}\n${latest.url}`, x: `${header}\n${latest.url}` });
    state.notes = latest.version;
  })(),
]);
await save();

const webhook = process.env.DISCORD_WEBHOOK_URL;
while (state.pending.length) {
  if (!webhook || !/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(webhook)) {
    throw new Error('Set the DISCORD_WEBHOOK_URL Actions secret');
  }
  const { discord, x } = state.pending[0];
  let response;
  try {
    response = await fetch(webhook + '?wait=true&with_components=true', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'V-Delta',
        content: discord,
        allowed_mentions: { parse: [] },
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Xで下書きを開く', url: 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(x) }] }],
      }),
    });
  } catch {
    throw new Error('Discord delivery failed');
  }
  if (!response.ok) throw new Error(`Discord delivery failed (HTTP ${response.status})`);
  state.pending.shift();
  await save();
}
for (const result of sourceChecks) {
  if (result.status === 'rejected') {
    console.error(result.reason.message);
    process.exitCode = 1;
  }
}

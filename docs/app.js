const repo = 'yuta-saito77/v-delta';
const raw = 'https://raw.githubusercontent.com/' + repo + '/main/state/';
const byId = (id) => document.getElementById(id);
const fmt = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tokyo' });
const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? fmt.format(new Date(value)) + ' JST' : '—';
const states = { success: '成功', failure: '失敗', in_progress: '実行中', queued: '待機中', cancelled: 'キャンセル' };

async function get(url) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}
function compose() {
  byId('compose').href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(byId('draft').value);
}
async function refresh() {
  const refreshButton = byId('refresh');
  refreshButton.disabled = true;
  const [check, build, news] = await Promise.allSettled([
    get('https://api.github.com/repos/' + repo + '/actions/workflows/watch.yml/runs?per_page=8'),
    get(raw + 'baseline.json'),
    get(raw + 'news.json'),
  ]);
  if (check.status === 'fulfilled') {
    const runs = check.value.workflow_runs ?? [];
    const latest = runs[0];
    if (latest) {
      byId('last-run').textContent = date(latest.run_started_at || latest.created_at);
      byId('run-status').textContent = states[latest.conclusion || latest.status] || latest.status;
    }
    byId('runs').replaceChildren(...runs.map((run) => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      const status = document.createElement('span');
      link.href = 'https://github.com/' + repo + '/actions/runs/' + run.id;
      link.textContent = date(run.run_started_at || run.created_at);
      status.textContent = states[run.conclusion || run.status] || run.status;
      row.append(link, status);
      return row;
    }));
  }
  if (build.status === 'fulfilled') {
    byId('build').textContent = build.value.manifestId || '—';
    byId('build-date').textContent = '検知 ' + date(build.value.observedAt);
  }
  if (news.status === 'fulfilled' && /^\d+\.\d+$/.test(news.value.notes)) {
    byId('patch').textContent = news.value.notes;
    if (!byId('draft').value) {
      byId('draft').value = '【V-Delta｜公式パッチノート】VALORANT ' + news.value.notes + '\n' + byId('official').href;
      compose();
    }
  }
  const incomplete = [check, build, news].some(({ status }) => status === 'rejected');
  byId('feedback').textContent = incomplete ? '一部の情報を取得できませんでした。時間をおいて再読み込みしてください。' : '';
  refreshButton.disabled = false;
}
byId('refresh').addEventListener('click', refresh);
byId('draft').addEventListener('input', compose);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
refresh();

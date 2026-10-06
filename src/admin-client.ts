// This is served only from the authenticated admin area.  It deliberately uses
// textContent and DOM APIs rather than interpolating audit data into HTML.
export const adminClient = `(() => {
  const table = document.querySelector('[data-session-list]');
  if (!table) return;
  const status = document.querySelector('[data-refresh-status]');
  const empty = document.querySelector('[data-empty-session-message]');
  const query = new URLSearchParams(location.search);
  const endpoint = '/admin/sessions.json?' + query.toString();
  let stopped = false;
  let refreshing = false;
  const showStatus = (message) => { if (status) status.textContent = message; };
  const cell = (row, value, className) => {
    const element = document.createElement('td');
    if (className) element.className = className;
    element.textContent = value;
    row.append(element);
  };
  const update = async () => {
    if (stopped || refreshing || document.hidden) return;
    refreshing = true;
    try {
      const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.status === 401 || response.redirected || !response.ok) {
        stopped = true;
        showStatus('ログインの有効期限が切れました。再ログインしてください。');
        return;
      }
      const payload = await response.json();
      const body = table.querySelector('tbody');
      if (!body || !Array.isArray(payload.sessions)) return;
      const focused = document.activeElement instanceof HTMLAnchorElement ? document.activeElement.dataset.sessionId : undefined;
      body.replaceChildren(...payload.sessions.map((session) => {
        const row = document.createElement('tr');
        cell(row, session.createdAtLabel);
        cell(row, session.latestCommandAtLabel);
        const linkCell = document.createElement('td');
        const link = document.createElement('a');
        link.href = '/admin/sessions?session=' + encodeURIComponent(session.id);
        link.dataset.sessionId = session.id;
        link.textContent = '詳細を開く';
        linkCell.append(link);
        row.append(linkCell);
        cell(row, session.stateLabel, 'badge');
        return row;
      }));
      if (empty) empty.hidden = payload.sessions.length > 0;
      if (focused) Array.from(body.querySelectorAll('a[data-session-id]')).find((link) => link.dataset.sessionId === focused)?.focus();
      showStatus('最終更新: ' + new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) + ' JST');
    } catch {
      showStatus('自動更新に失敗しました。接続を確認してください。');
    } finally {
      refreshing = false;
    }
  };
  void update();
  setInterval(() => void update(), 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void update(); });
})();`;

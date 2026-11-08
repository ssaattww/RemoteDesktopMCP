import type { TodoHistoryPage } from "./todo-history.js";

export function initializeTodoHistory(format: (page: TodoHistoryPage, index: number) => string): void {
  const panel = document.getElementById("todo-history");
  if (!panel) return;
  const previous = panel.querySelector<HTMLButtonElement>("[data-history-prev]");
  const next = panel.querySelector<HTMLButtonElement>("[data-history-next]");
  const refresh = panel.querySelector<HTMLButtonElement>("[data-history-refresh]");
  const body = panel.querySelector<HTMLElement>("[data-history-body]");
  const notice = panel.querySelector<HTMLElement>("[data-history-notice]");
  let page: TodoHistoryPage;
  try { page = JSON.parse(panel.dataset.history ?? ""); } catch { return; }
  let index = page.revisions.length - 1;
  let left = false; let pending = false;
  window.addEventListener("pagehide", () => { left = true; });
  const render = () => {
    if (body) body.textContent = format(page, index);
    if (previous) previous.disabled = index <= 0;
    if (next) next.disabled = index < 0 || index >= page.revisions.length - 1;
  };
  previous?.addEventListener("click", () => { if (index > 0) { index--; render(); } });
  next?.addEventListener("click", () => { if (index < page.revisions.length - 1) { index++; render(); } });
  refresh?.addEventListener("click", async () => {
    if (pending || left) return;
    pending = true; refresh.disabled = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(panel.dataset.sessionId ?? "")}/todo/history`, { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("history unavailable");
      const result = await response.json() as TodoHistoryPage;
      if (left) return;
      const version = page.revisions[index]?.version;
      const retained = result.revisions.findIndex((entry) => entry.version === version);
      page = result; index = retained >= 0 ? retained : page.revisions.length - 1;
      if (notice) notice.textContent = version !== undefined && retained < 0 ? "選択していた版は取得範囲外です。最新の記録を表示します。" : "履歴を更新しました。";
      render();
    } catch { if (!left && notice) notice.textContent = "履歴を取得できませんでした。表示中の記録を保持しています。"; }
    finally { pending = false; refresh.disabled = false; }
  });
  render();
}

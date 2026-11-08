import { z } from "zod";
import type { TodoItem } from "./shared-todo.js";

const valuesSchema = z.object({ text: z.string().max(1000), status: z.enum(["not_started", "in_progress", "completed"]), parent_id: z.string().nullable(), order: z.number().int().nonnegative() });
const itemSchema = valuesSchema.extend({ id: z.string(), createdBy: z.string(), createdAt: z.string(), updatedAt: z.string(), child_total: z.number(), child_completed: z.number(), descendant_incomplete: z.number() });
const commonSchema = z.object({ history_schema: z.literal(1), user: z.string(), sessionId: z.string(), actor: z.string(), source: z.enum(["mcp", "user_console"]), at: z.string() });
export const todoRevisionSchema = commonSchema.extend({ event: z.literal("todo.updated"), version: z.number().int().positive(), previous_version: z.number().int().nonnegative(), snapshot: z.array(itemSchema).max(200), changes: z.array(z.object({ item_id: z.string(), before: valuesSchema.nullable(), after: valuesSchema.nullable() })).max(400) });
export const todoAttemptSchema = commonSchema.extend({ event: z.literal("todo.update_attempt"), expected_version: z.number(), outcome: z.enum(["conflict", "rejected", "failed"]), reason: z.enum(["version_conflict", "invalid_changes", "validation_rejected", "update_failed"]) });
export type TodoRevision = z.infer<typeof todoRevisionSchema>;
export type TodoAttempt = z.infer<typeof todoAttemptSchema>;
export type TodoHistoryPage = {
  session_id: string;
  current_version: number | null;
  revisions: TodoRevision[];
  attempts: TodoAttempt[];
  window: { limit: number; index_limit: number; index_truncated: boolean; response_truncated: boolean; pre_feature_history: "unavailable"; complete: false; first_recorded_version: number | null; latest_recorded_version: number | null; version_gaps: boolean; current_version_unrecorded: boolean };
};

export function todoItemChanges(before: readonly TodoItem[], after: readonly TodoItem[]): TodoRevision["changes"] {
  const values = (item: TodoItem | undefined) => item ? { text: item.text, status: item.status, parent_id: item.parent_id ?? null, order: item.order } : null;
  const old = new Map(before.map((item) => [item.id, item])); const current = new Map(after.map((item) => [item.id, item]));
  return [...new Set([...old.keys(), ...current.keys()])].flatMap((item_id) => {
    const previous = values(old.get(item_id)); const next = values(current.get(item_id));
    return JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ item_id, before: previous, after: next }];
  });
}

// Self-contained so SSR and the serialized browser program use the same text.
export function formatTodoHistory(page: TodoHistoryPage, index: number): string {
  const window = page.window;
  const scope = `取得範囲: 監査の最新${window.index_limit}件から本人の最新${window.limit}件。導入前・保存失敗・取得範囲外の履歴は含まれない可能性があります。全期間の完全な履歴ではありません。`;
  const bounds = `記録の版: ${window.first_recorded_version ?? "なし"} ～ ${window.latest_recorded_version ?? "なし"} / 現在の版: ${page.current_version ?? "終了済み・不明"}`;
  const warnings = [window.index_truncated ? "監査索引の古い記録は取得範囲外です。" : "", window.response_truncated ? "古い履歴は取得上限の範囲外です。" : "", window.version_gaps ? "記録された版に欠落があります。" : "", window.current_version_unrecorded ? "現在の版に対応する履歴が確認できません。" : ""].filter(Boolean).join("\n");
  const revision = page.revisions[index];
  const status = { not_started: "未着手", in_progress: "進行中", completed: "完了" };
  const values = (item: TodoRevision["changes"][number]["before"]) => item ? `本文: ${item.text}\n状態: ${status[item.status]} / 親: ${item.parent_id ?? "最上位"} / 兄弟順序: ${item.order + 1}` : "項目なし";
  const selected = revision ? `選択した版: ${revision.version}${revision.version === page.current_version ? "（現在の版）" : ""}\n日時: ${revision.at}\n更新者: ${revision.actor}\n更新元: ${revision.source === "mcp" ? "MCP" : "利用者画面"}\n\n項目:\n${revision.snapshot.map((item) => `項目 ${item.id}\n${values(item)}`).join("\n\n") || "項目なし"}\n\n変更前 → 変更後:\n${revision.changes.map((change) => `項目 ${change.item_id}\n変更前:\n${values(change.before)}\n変更後:\n${values(change.after)}`).join("\n\n") || "値の変更なし"}` : "取得範囲内に適用済みの履歴がありません。";
  const attempts = `未適用の試行（適用版とは別）:\n${page.attempts.length ? page.attempts.map((attempt) => `${attempt.at} / ${attempt.actor} / ${attempt.source} / ${attempt.outcome} / ${attempt.reason} / 要求版 ${attempt.expected_version}`).join("\n") : "取得範囲内になし"}`;
  return [scope, bounds, warnings, selected, attempts].filter(Boolean).join("\n\n");
}

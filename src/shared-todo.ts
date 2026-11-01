import { z } from "zod";

export type TodoItem = {
  id: string;
  text: string;
  status: "not_started" | "in_progress" | "completed";
  parent_id?: string | null;
  order: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
type OrderedTodoItem = TodoItem & { parent_id: string | null };
export type TodoSnapshotItem = OrderedTodoItem & { child_total: number; child_completed: number; descendant_incomplete: number };

const statusSchema = z.enum(["not_started", "in_progress", "completed"]);
const parentSchema = z.string().min(1).nullable();
export const todoChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), text: z.string().trim().min(1).max(1000), status: statusSchema.optional(), parent_id: parentSchema.optional() }),
  z.object({ op: z.literal("edit"), id: z.string().min(1), text: z.string().trim().min(1).max(1000) }),
  z.object({ op: z.literal("status"), id: z.string().min(1), status: statusSchema }),
  z.object({ op: z.literal("delete"), id: z.string().min(1) }),
  z.object({ op: z.literal("move"), id: z.string().min(1), order: z.number().int().nonnegative() }),
  z.object({ op: z.literal("reparent"), id: z.string().min(1), parent_id: parentSchema }),
]);
export const todoChangesSchema = z.array(todoChangeSchema).min(1).max(200);
type TodoChange = z.infer<typeof todoChangeSchema>;

const todoValidationErrors = new WeakSet<object>();

// 外部入力や内部情報を含まない、利用者へ返せる操作上の制約だけを区別する。
export class TodoValidationError extends Error {
  readonly code: string;
  constructor(message: string) { super(message); this.code = message.split(":", 1)[0]!; todoValidationErrors.add(this); }
}

// 例外の継承関係をたどらず、監査を妨げる外部の取得処理を呼び出さない。
export function isTodoValidationError(error: unknown): error is TodoValidationError {
  return typeof error === "object" && error !== null && todoValidationErrors.has(error);
}

// 保存済みの平坦な項目も受け入れ、同一セッションの木を親先行・兄弟連番に揃える。
function orderTodoItems(input: readonly TodoItem[]): OrderedTodoItem[] {
  const items = input.map((item) => ({ ...item, parent_id: item.parent_id ?? null }));
  const byId = new Map(items.map((item) => [item.id, item]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (item: OrderedTodoItem): number => {
    const known = depths.get(item.id);
    if (known !== undefined) return known;
    if (visiting.has(item.id)) throw new TodoValidationError("TODO_PARENT_CYCLE: 自分自身または子孫を親にできません。");
    visiting.add(item.id);
    let depth = 1;
    if (item.parent_id !== null) {
      const parent = byId.get(item.parent_id);
      if (!parent) throw new TodoValidationError("TODO_PARENT_UNAVAILABLE: 同じセッションの親を指定してください。");
      depth = depthOf(parent) + 1;
    }
    if (depth > 8) throw new TodoValidationError("TODO_DEPTH_LIMIT: 作業の階層は最上位を含めて8段までです。");
    visiting.delete(item.id);
    depths.set(item.id, depth);
    return depth;
  };
  for (const item of items) depthOf(item);
  const groups = new Map<string | null, OrderedTodoItem[]>();
  for (const item of items) {
    const siblings = groups.get(item.parent_id) ?? [];
    siblings.push(item);
    groups.set(item.parent_id, siblings);
  }
  for (const siblings of groups.values()) siblings.sort((left, right) => left.order - right.order).forEach((item, index) => { item.order = index; });
  const ordered: OrderedTodoItem[] = [];
  const append = (parent: string | null) => {
    for (const item of groups.get(parent) ?? []) { ordered.push(item); append(item.id); }
  };
  append(null);
  return ordered;
}

// 直属の子の達成率と、配下全体の未完了件数を独立して集計する。
export function snapshotTodoItems(input: readonly TodoItem[]): TodoSnapshotItem[] {
  const items = orderTodoItems(input).map((item) => ({ ...item, child_total: 0, child_completed: 0, descendant_incomplete: 0 }));
  const byId = new Map(items.map((item) => [item.id, item]));
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.parent_id === null) continue;
    const parent = byId.get(item.parent_id)!;
    parent.child_total += 1;
    if (item.status === "completed") parent.child_completed += 1;
    parent.descendant_incomplete += item.descendant_incomplete + (item.status === "completed" ? 0 : 1);
  }
  return items;
}

// 元の状態を変更しない作業用配列で全操作を検証し、成功した場合だけ呼び出し元が保存する。
export function applyTodoChanges(input: readonly TodoItem[], changes: readonly TodoChange[], context: { user: string; timestamp: string; makeId: () => string }): TodoItem[] {
  let items = orderTodoItems(input);
  for (const change of changes) {
    if (change.op === "add") {
      if (items.length >= 200) throw new TodoValidationError("TODO_ITEM_LIMIT: 作業は親子を合わせて200件までです。");
      const parent_id = change.parent_id ?? null;
      items.push({ id: context.makeId(), text: change.text, status: change.status ?? "not_started", parent_id, order: items.filter((item) => item.parent_id === parent_id).length, createdBy: context.user, createdAt: context.timestamp, updatedAt: context.timestamp });
    } else {
      const index = items.findIndex((item) => item.id === change.id);
      if (index < 0) throw new TodoValidationError("TODO_ITEM_UNAVAILABLE: 作業が見つかりません。");
      const item = items[index]!;
      if (change.op === "delete") {
        if (items.some((child) => child.parent_id === item.id)) throw new TodoValidationError("TODO_HAS_CHILDREN: 子を移動または削除してから、この作業を削除してください。");
        items.splice(index, 1);
      } else if (change.op === "edit") {
        item.text = change.text;
        item.updatedAt = context.timestamp;
      } else if (change.op === "status") {
        item.status = change.status;
        item.updatedAt = context.timestamp;
      } else if (change.op === "reparent") {
        if (item.parent_id !== change.parent_id) {
          item.parent_id = change.parent_id;
          item.order = items.filter((sibling) => sibling.id !== item.id && sibling.parent_id === item.parent_id).length;
          item.updatedAt = context.timestamp;
        }
      } else {
        const siblings = items.filter((sibling) => sibling.parent_id === item.parent_id);
        siblings.splice(siblings.findIndex((sibling) => sibling.id === item.id), 1);
        siblings.splice(Math.min(change.order, siblings.length), 0, item);
        siblings.forEach((sibling, order) => { sibling.order = order; });
      }
    }
    // 親変更の影響を受ける子孫も含め、操作ごとに循環と深さを検証する。
    items = orderTodoItems(items);
  }
  return items;
}

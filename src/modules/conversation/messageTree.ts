import type { Message } from "@prisma/client";
import { prisma } from "../../lib/prisma";

export interface MessageTree {
  byId: Map<string, Message>;
  childrenOf: Map<string | null, Message[]>;
}

export type PathMessage = Message & { siblingIds: string[] };

export async function loadTree(conversationId: string): Promise<MessageTree> {
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const byId = new Map(messages.map((m) => [m.id, m]));
  const childrenOf = new Map<string | null, Message[]>();
  for (const m of messages) {
    const key = m.parentId && byId.has(m.parentId) ? m.parentId : null;
    const list = childrenOf.get(key);
    if (list) list.push(m);
    else childrenOf.set(key, [m]);
  }
  return { byId, childrenOf };
}

export function pathTo(tree: MessageTree, leafId: string | null | undefined): PathMessage[] {
  const path: PathMessage[] = [];
  const seen = new Set<string>();
  let current = leafId ? tree.byId.get(leafId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentKey = current.parentId && tree.byId.has(current.parentId) ? current.parentId : null;
    const siblingIds = (tree.childrenOf.get(parentKey) ?? []).map((m) => m.id);
    path.push({ ...current, siblingIds });
    current = current.parentId ? tree.byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function latestLeafUnder(tree: MessageTree, messageId: string): string {
  let best = tree.byId.get(messageId)!;
  const stack = [best];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const children = tree.childrenOf.get(node.id) ?? [];
    if (children.length === 0 && node.createdAt >= best.createdAt) best = node;
    stack.push(...children);
  }
  return best.id;
}

export function hasChildren(tree: MessageTree, messageId: string | null | undefined): boolean {
  return Boolean(messageId && (tree.childrenOf.get(messageId)?.length ?? 0) > 0);
}

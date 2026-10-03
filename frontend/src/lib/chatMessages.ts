/**
 * Pure helpers for the chat message list. An answer can reach the browser twice — in the REST
 * response of the request that asked for it, and as a `chat:message` socket event — and either
 * can arrive first, or (if the socket has not joined the workspace room yet) never. The list
 * must therefore be idempotent by message id.
 */
export interface HasId {
  id: string;
}

/** Append `msg` unless a message with the same id is already present. */
export function mergeMessage<T extends HasId>(list: T[], msg: T): T[] {
  return list.some((m) => m.id === msg.id) ? list : [...list, msg];
}

/**
 * Replace the optimistic copy of a sent message (`localId`) with the persisted one. If the
 * persisted message already arrived through the socket, the optimistic copy is simply dropped.
 */
export function replaceOptimistic<T extends HasId>(list: T[], localId: string, persisted: T): T[] {
  if (list.some((m) => m.id === persisted.id)) return list.filter((m) => m.id !== localId);
  const idx = list.findIndex((m) => m.id === localId);
  if (idx === -1) return [...list, persisted];
  return [...list.slice(0, idx), persisted, ...list.slice(idx + 1)];
}

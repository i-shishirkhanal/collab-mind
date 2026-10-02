import { create } from "zustand";
import type { Call, Conversation, DirectMessage, ReadState } from "@/types/messaging";

interface MessagingState {
  conversations: Conversation[];
  conversationsLoaded: boolean;
  /** Messages keyed by conversation id, oldest first. */
  messages: Record<string, DirectMessage[]>;
  hasMore: Record<string, boolean>;
  /** conversationId -> userId -> last_read_at */
  reads: Record<string, Record<string, string>>;
  /** conversationId -> userId -> display name of people currently typing */
  typing: Record<string, Record<string, string>>;
  onlineUserIds: string[];
  /** Calls currently ringing/active, keyed by conversation id (drives the "Join" banner). */
  liveCalls: Record<string, Call>;
  /** Call the user is being invited to. */
  incomingCall: Call | null;
  /** Call the user is currently in (or joining). */
  activeCall: { call: Call; token: string; url: string } | null;

  setConversations: (c: Conversation[]) => void;
  upsertConversation: (c: Conversation) => void;
  removeConversation: (id: string) => void;
  bumpWithMessage: (m: DirectMessage, myUserId: string | undefined, isOpen: boolean) => void;
  clearUnread: (id: string) => void;

  setMessages: (id: string, msgs: DirectMessage[], hasMore: boolean, reads?: ReadState[]) => void;
  prependMessages: (id: string, msgs: DirectMessage[], hasMore: boolean) => void;
  addMessage: (m: DirectMessage) => void;
  replaceMessage: (conversationId: string, tempId: string, m: DirectMessage) => void;
  markMessageFailed: (conversationId: string, tempId: string) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  markDeleted: (conversationId: string, messageId: string) => void;
  setRead: (conversationId: string, userId: string, at: string) => void;

  setTyping: (conversationId: string, userId: string, name: string, isTyping: boolean) => void;
  setOnline: (ids: string[]) => void;
  setPresence: (userId: string, online: boolean) => void;

  trackCall: (c: Call) => void;
  untrackCall: (callId: string) => void;
  setIncomingCall: (c: Call | null) => void;
  setActiveCall: (c: MessagingState["activeCall"]) => void;
  reset: () => void;
}

const initial = {
  conversations: [] as Conversation[],
  conversationsLoaded: false,
  messages: {} as Record<string, DirectMessage[]>,
  hasMore: {} as Record<string, boolean>,
  reads: {} as Record<string, Record<string, string>>,
  typing: {} as Record<string, Record<string, string>>,
  onlineUserIds: [] as string[],
  liveCalls: {} as Record<string, Call>,
  incomingCall: null as Call | null,
  activeCall: null as MessagingState["activeCall"],
};

const byRecency = (a: Conversation, b: Conversation) =>
  new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();

export const useMessagingStore = create<MessagingState>((set) => ({
  ...initial,

  setConversations: (conversations) => set({ conversations: [...conversations].sort(byRecency), conversationsLoaded: true }),
  upsertConversation: (c) =>
    set((s) => {
      const exists = s.conversations.some((x) => x.id === c.id);
      const next = exists
        ? s.conversations.map((x) => (x.id === c.id ? { ...x, ...c, unread_count: x.unread_count } : x))
        : [c, ...s.conversations];
      return { conversations: next.sort(byRecency) };
    }),
  removeConversation: (id) => set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) })),

  bumpWithMessage: (m, myUserId, isOpen) =>
    set((s) => ({
      conversations: s.conversations
        .map((c) =>
          c.id !== m.conversation_id
            ? c
            : {
                ...c,
                last_message_at: m.created_at,
                last_message: {
                  id: m.id, kind: m.kind, body: m.body, sender_id: m.sender_id,
                  attachment_name: m.attachment?.name ?? null, created_at: m.created_at, deleted: false,
                },
                unread_count:
                  m.sender_id === myUserId || isOpen ? c.unread_count ?? 0 : (c.unread_count ?? 0) + 1,
              },
        )
        .sort(byRecency),
    })),
  clearUnread: (id) =>
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)) })),

  setMessages: (id, msgs, hasMore, reads) =>
    set((s) => ({
      messages: { ...s.messages, [id]: msgs },
      hasMore: { ...s.hasMore, [id]: hasMore },
      reads: reads
        ? { ...s.reads, [id]: Object.fromEntries(reads.map((r) => [r.user_id, r.last_read_at])) }
        : s.reads,
    })),
  prependMessages: (id, msgs, hasMore) =>
    set((s) => {
      const have = new Set((s.messages[id] || []).map((m) => m.id));
      return {
        messages: { ...s.messages, [id]: [...msgs.filter((m) => !have.has(m.id)), ...(s.messages[id] || [])] },
        hasMore: { ...s.hasMore, [id]: hasMore },
      };
    }),
  addMessage: (m) =>
    set((s) => {
      const list = s.messages[m.conversation_id] || [];
      if (list.some((x) => x.id === m.id)) return s; // de-dupe (REST response vs socket echo)
      return { messages: { ...s.messages, [m.conversation_id]: [...list, m] } };
    }),
  replaceMessage: (conversationId, tempId, m) =>
    set((s) => {
      const list = s.messages[conversationId] || [];
      const withoutDup = list.filter((x) => x.id !== m.id); // socket echo may have landed first
      const idx = withoutDup.findIndex((x) => x.id === tempId);
      const next = idx === -1 ? [...withoutDup, m] : withoutDup.map((x) => (x.id === tempId ? m : x));
      return { messages: { ...s.messages, [conversationId]: next } };
    }),
  markMessageFailed: (conversationId, tempId) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: (s.messages[conversationId] || []).map((m) =>
          m.id === tempId ? { ...m, pending: false, failed: true } : m,
        ),
      },
    })),
  removeMessage: (conversationId, messageId) =>
    set((s) => ({
      messages: { ...s.messages, [conversationId]: (s.messages[conversationId] || []).filter((m) => m.id !== messageId) },
    })),
  markDeleted: (conversationId, messageId) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: (s.messages[conversationId] || []).map((m) =>
          m.id === messageId ? { ...m, deleted: true, body: "", attachment: null } : m,
        ),
      },
    })),
  setRead: (conversationId, userId, at) =>
    set((s) => ({
      reads: { ...s.reads, [conversationId]: { ...(s.reads[conversationId] || {}), [userId]: at } },
    })),

  setTyping: (conversationId, userId, name, isTyping) =>
    set((s) => {
      const forConv = { ...(s.typing[conversationId] || {}) };
      if (isTyping) forConv[userId] = name;
      else delete forConv[userId];
      return { typing: { ...s.typing, [conversationId]: forConv } };
    }),
  setOnline: (ids) => set({ onlineUserIds: ids }),
  setPresence: (userId, online) =>
    set((s) => ({
      onlineUserIds: online
        ? s.onlineUserIds.includes(userId) ? s.onlineUserIds : [...s.onlineUserIds, userId]
        : s.onlineUserIds.filter((id) => id !== userId),
    })),

  trackCall: (c) =>
    set((s) => {
      const live = { ...s.liveCalls };
      if (c.status === "ringing" || c.status === "active") live[c.conversation_id] = c;
      else delete live[c.conversation_id];
      return { liveCalls: live };
    }),
  untrackCall: (callId) =>
    set((s) => ({
      liveCalls: Object.fromEntries(Object.entries(s.liveCalls).filter(([, c]) => c.id !== callId)),
    })),
  setIncomingCall: (incomingCall) => set({ incomingCall }),
  setActiveCall: (activeCall) => set({ activeCall }),
  reset: () => set({ ...initial }),
}));

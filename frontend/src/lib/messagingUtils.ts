// Pure helpers for the messaging UI (no imports, so they are trivially unit-testable).

interface MemberLike { user_id: string; name: string; avatar_url?: string | null }
interface ConversationLike {
  type: "direct" | "group";
  name: string | null;
  avatar_url?: string | null;
  members: MemberLike[];
}

/** Title/avatar shown for a thread: the other person for direct chats, the group name otherwise. */
export function conversationDisplay(conv: ConversationLike, myUserId?: string) {
  if (conv.type === "group") {
    return { title: conv.name || "Group", avatar: conv.avatar_url ?? null, otherUserId: null as string | null };
  }
  const other = conv.members.find((m) => m.user_id !== myUserId) ?? conv.members[0];
  return { title: other?.name || "Unknown user", avatar: other?.avatar_url ?? null, otherUserId: other?.user_id ?? null };
}

interface PreviewMessage {
  kind: "text" | "file" | "system";
  body: string;
  attachment_name: string | null;
  sender_id: string | null;
  deleted: boolean;
}

export function lastMessagePreview(m: PreviewMessage | null | undefined, myUserId?: string) {
  if (!m) return "No messages yet";
  if (m.deleted) return "Message deleted";
  const prefix = m.sender_id && m.sender_id === myUserId ? "You: " : "";
  if (m.kind === "file") return `${prefix}📎 ${m.attachment_name || "File"}`;
  return `${m.kind === "system" ? "" : prefix}${m.body}`;
}

/** "14:05" today, "Mon" within the week, otherwise "12 Mar". */
export function formatShortTime(iso: string, now: Date = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Members (other than the sender) who have read a message, derived from each
 * member's read pointer: read means `last_read_at >= message.created_at`.
 */
export function readersOf(
  message: { sender_id: string | null; created_at: string },
  reads: Record<string, string> | undefined,
  memberIds: string[],
) {
  if (!reads) return [];
  const sent = new Date(message.created_at).getTime();
  return memberIds.filter(
    (id) => id !== message.sender_id && reads[id] && new Date(reads[id]).getTime() >= sent,
  );
}

type CallLike = {
  status: string;
  direction: "incoming" | "outgoing";
  my_status: string;
  duration_seconds: number | null;
};

/** Human label for a row of call history. */
export function describeCall(c: CallLike) {
  if (c.status === "ended" && c.duration_seconds != null) {
    return `${c.direction === "outgoing" ? "Outgoing" : "Incoming"} · ${formatDuration(c.duration_seconds)}`;
  }
  if (c.status === "ringing" || c.status === "active") return "In progress";
  if (c.status === "declined") return c.direction === "outgoing" ? "Declined" : "You declined";
  if (c.status === "missed") return c.direction === "outgoing" ? "No answer" : "Missed";
  return c.direction === "outgoing" ? "Outgoing" : "Incoming";
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

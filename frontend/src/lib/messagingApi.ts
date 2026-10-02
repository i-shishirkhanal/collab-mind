import { apiCall } from "@/lib/api";
import type {
  Call, CallCredentials, CallHistoryItem, ChatUser, Conversation, DirectMessage, ReadState,
} from "@/types/messaging";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const json = (body: unknown) => ({ body: JSON.stringify(body) });

// ── Conversations ─────────────────────────────────────────────────────────────
export const listConversations = (): Promise<{ conversations: Conversation[] }> =>
  apiCall("/api/conversations");

export const getConversation = (id: string): Promise<Conversation> =>
  apiCall(`/api/conversations/${id}`);

export const createDirectConversation = (userId: string): Promise<Conversation> =>
  apiCall("/api/conversations", { method: "POST", ...json({ type: "direct", userId }) });

export const createGroupConversation = (name: string, memberIds: string[]): Promise<Conversation> =>
  apiCall("/api/conversations", { method: "POST", ...json({ type: "group", name, memberIds }) });

export const updateGroup = (id: string, data: { name?: string }): Promise<Conversation> =>
  apiCall(`/api/conversations/${id}`, { method: "PATCH", ...json(data) });

export const addGroupMembers = (id: string, userIds: string[]): Promise<Conversation> =>
  apiCall(`/api/conversations/${id}/members`, { method: "POST", ...json({ userIds }) });

export const removeGroupMember = (id: string, userId: string) =>
  apiCall(`/api/conversations/${id}/members/${userId}`, { method: "DELETE" });

export const setGroupMemberRole = (id: string, userId: string, role: "admin" | "member"): Promise<Conversation> =>
  apiCall(`/api/conversations/${id}/members/${userId}`, { method: "PATCH", ...json({ role }) });

export const searchUsers = (q: string): Promise<{ users: ChatUser[] }> =>
  apiCall(`/api/users/search?q=${encodeURIComponent(q)}`);

// ── Messages ──────────────────────────────────────────────────────────────────
export const getMessages = (
  id: string,
  before?: string,
): Promise<{ messages: DirectMessage[]; has_more: boolean; read_state: ReadState[] }> =>
  apiCall(`/api/conversations/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`);

export const sendDirectMessage = (id: string, body: string, replyToId?: string): Promise<DirectMessage> =>
  apiCall(`/api/conversations/${id}/messages`, { method: "POST", ...json({ body, replyToId }) });

export const markConversationRead = (id: string) =>
  apiCall(`/api/conversations/${id}/read`, { method: "POST" });

export const deleteDirectMessage = (id: string, messageId: string) =>
  apiCall(`/api/conversations/${id}/messages/${messageId}`, { method: "DELETE" });

export const getAttachmentUrl = (id: string, messageId: string): Promise<{ url: string }> =>
  apiCall(`/api/conversations/${id}/messages/${messageId}/attachment`);

/** Multipart upload; `apiCall` forces a JSON content type so this mirrors uploadSourceFile in api.ts. */
export async function sendAttachment(id: string, file: File, caption = ""): Promise<DirectMessage> {
  const token =
    (typeof window !== "undefined" && localStorage.getItem("supabase_auth_token")) || "demo-guest-token";
  const form = new FormData();
  form.append("file", file);
  if (caption) form.append("body", caption);

  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/conversations/${id}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    throw new Error("CONNECTION_FAILED");
  }
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to upload file");
  return data;
}

// ── Calls ─────────────────────────────────────────────────────────────────────
export const startCall = (conversationId: string, kind: "audio" | "video"): Promise<CallCredentials> =>
  apiCall(`/api/conversations/${conversationId}/calls`, { method: "POST", ...json({ kind }) });

export const getConversationCalls = (
  conversationId: string,
): Promise<{ active: Call | null; history: CallHistoryItem[] }> =>
  apiCall(`/api/conversations/${conversationId}/calls`);

export const joinCall = (callId: string): Promise<CallCredentials> =>
  apiCall(`/api/calls/${callId}/join`, { method: "POST" });

export const declineCall = (callId: string) => apiCall(`/api/calls/${callId}/decline`, { method: "POST" });
export const leaveCall = (callId: string) => apiCall(`/api/calls/${callId}/leave`, { method: "POST" });
export const endCall = (callId: string) => apiCall(`/api/calls/${callId}/end`, { method: "POST" });

export const getCallHistory = (before?: string): Promise<{ calls: CallHistoryItem[] }> =>
  apiCall(`/api/calls/history${before ? `?before=${encodeURIComponent(before)}` : ""}`);

export const getPendingCalls = (): Promise<{ calls: Call[] }> => apiCall("/api/calls/pending");

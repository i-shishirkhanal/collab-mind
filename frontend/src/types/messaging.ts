export interface ChatUser {
  id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
}

export interface ConversationMember {
  user_id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
  role: "admin" | "member";
  joined_at: string;
  last_read_at: string;
}

export interface LastMessage {
  id: string;
  kind: "text" | "file" | "system";
  body: string;
  sender_id: string | null;
  attachment_name: string | null;
  created_at: string;
  deleted: boolean;
}

export interface Conversation {
  id: string;
  type: "direct" | "group";
  name: string | null;
  avatar_url?: string | null;
  created_by: string | null;
  created_at: string;
  last_message_at: string;
  unread_count?: number;
  members: ConversationMember[];
  last_message?: LastMessage | null;
}

export interface DirectMessage {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  sender_name: string | null;
  sender_avatar?: string | null;
  kind: "text" | "file" | "system";
  body: string;
  attachment: { name: string; type: string; size: number } | null;
  reply_to: { id: string; sender_name: string | null; body: string } | null;
  created_at: string;
  deleted: boolean;
  /** Client-only: optimistic message awaiting server confirmation. */
  pending?: boolean;
  failed?: boolean;
}

export interface ReadState {
  user_id: string;
  last_read_at: string;
}

export type CallKind = "audio" | "video";
export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";

export interface CallParticipant {
  user_id: string;
  name: string;
  avatar_url?: string | null;
  status: "invited" | "joined" | "declined" | "left" | "missed";
}

export interface Call {
  id: string;
  conversation_id: string;
  conversation_type: "direct" | "group";
  conversation_name: string | null;
  started_by: string | null;
  started_by_name: string | null;
  kind: CallKind;
  status: CallStatus;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  participants: CallParticipant[];
}

export interface CallHistoryItem {
  id: string;
  conversation_id: string;
  conversation_type: "direct" | "group";
  conversation_name: string | null;
  started_by: string | null;
  started_by_name: string | null;
  kind: CallKind;
  status: CallStatus;
  my_status: string;
  direction: "incoming" | "outgoing";
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  participants: { user_id: string; name: string }[];
}

export interface CallCredentials {
  call: Call;
  token: string;
  url: string;
}

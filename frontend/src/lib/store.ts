import { create } from 'zustand';
import { Workspace, WorkspaceMember, Source, ChatMessage, Citation } from '@/types';
import { mergeMessage, replaceOptimistic } from '@/lib/chatMessages';

// ========================
// Chat Store
// ========================
interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  activeCitation: Citation | null;
  addMessage: (message: ChatMessage) => void;
  replaceMessage: (localId: string, persisted: ChatMessage) => void;
  setLoading: (loading: boolean) => void;
  setActiveCitation: (citation: Citation | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isLoading: false,
  activeCitation: null,
  // Idempotent by id: the same message can arrive via the REST response and via the socket.
  addMessage: (message) => set((state) => ({ messages: mergeMessage(state.messages, message) })),
  replaceMessage: (localId, persisted) => set((state) => ({ messages: replaceOptimistic(state.messages, localId, persisted) })),
  setLoading: (loading) => set({ isLoading: loading }),
  setActiveCitation: (citation) => set({ activeCitation: citation }),
  setMessages: (messages) => set({ messages }),
}));

// ========================
// Presence Store
// ========================
interface TypingUser {
  userId: string;
  name: string;
}

interface PresenceState {
  onlineMembers: string[]; // List of user IDs
  typingUsers: TypingUser[];
  setOnline: (userId: string) => void;
  setOffline: (userId: string) => void;
  setTyping: (user: TypingUser) => void;
  clearTyping: (userId: string) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  onlineMembers: [],
  typingUsers: [],
  setOnline: (userId) => set((state) => ({
    onlineMembers: state.onlineMembers.includes(userId) ? state.onlineMembers : [...state.onlineMembers, userId]
  })),
  setOffline: (userId) => set((state) => ({
    onlineMembers: state.onlineMembers.filter(id => id !== userId)
  })),
  setTyping: (user) => set((state) => ({
    typingUsers: state.typingUsers.some(u => u.userId === user.userId)
      ? state.typingUsers
      : [...state.typingUsers, user]
  })),
  clearTyping: (userId) => set((state) => ({
    typingUsers: state.typingUsers.filter(u => u.userId !== userId)
  })),
}));

// ========================
// Workspace Store
// ========================
interface WorkspaceState {
  workspace: Workspace | null;
  members: WorkspaceMember[];
  sources: Source[];
  setWorkspace: (workspace: Workspace | null) => void;
  setMembers: (members: WorkspaceMember[]) => void;
  setSources: (sources: Source[]) => void;
  updateSourceStatus: (sourceId: string, status: Source['status']) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspace: null,
  members: [],
  sources: [],
  setWorkspace: (workspace) => set({ workspace }),
  setMembers: (members) => set({ members }),
  setSources: (sources) => set({ sources }),
  updateSourceStatus: (sourceId, status) => set((state) => ({
    sources: state.sources.map(s => s.id === sourceId ? { ...s, status } : s)
  })),
}));

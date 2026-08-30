import { create } from 'zustand';
import { Workspace, WorkspaceMember, Source, ChatMessage, Citation } from '@/types';

// ========================
// Chat Store
// ========================
interface ChatState {
  messages: ChatMessage[];
  citations: { [id: string]: Citation[] };
  isLoading: boolean;
  activeCitation: Citation | null;
  addMessage: (message: ChatMessage) => void;
  setLoading: (loading: boolean) => void;
  setActiveCitation: (citation: Citation | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  citations: {},
  isLoading: false,
  activeCitation: null,
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  setLoading: (loading) => set({ isLoading: loading }),
  setActiveCitation: (citation) => set({ activeCitation: citation }),
  setMessages: (messages) => set({ messages }),
}));

// ========================
// Presence Store
// ========================
interface PresenceState {
  onlineMembers: string[]; // List of user IDs
  setOnline: (userId: string) => void;
  setOffline: (userId: string) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  onlineMembers: [],
  setOnline: (userId) => set((state) => ({
    onlineMembers: state.onlineMembers.includes(userId) ? state.onlineMembers : [...state.onlineMembers, userId]
  })),
  setOffline: (userId) => set((state) => ({
    onlineMembers: state.onlineMembers.filter(id => id !== userId)
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

import { create } from 'zustand';

export interface Citation {
  id: string;
  sourceId: string;
  sourceName: string;
  pageNumber?: number;
  excerpt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  citationIds?: string[];
  timestamp: string;
}

interface ChatState {
  messages: ChatMessage[];
  citations: Record<string, Citation>;
  isLoading: boolean;
  activeCitation: Citation | null;
  addMessage: (message: ChatMessage) => void;
  addCitations: (newCitations: Citation[]) => void;
  setIsLoading: (loading: boolean) => void;
  setActiveCitation: (citation: Citation | null) => void;
  clearChat: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  citations: {},
  isLoading: false,
  activeCitation: null,
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  addCitations: (newCitations) => set((state) => {
    const updated = { ...state.citations };
    newCitations.forEach(c => { updated[c.id] = c; });
    return { citations: updated };
  }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setActiveCitation: (citation) => set({ activeCitation: citation }),
  clearChat: () => set({ messages: [], citations: {}, isLoading: false, activeCitation: null }),
}));

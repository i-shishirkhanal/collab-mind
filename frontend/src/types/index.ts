export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  member_count: number;
  source_count: number;
}

export interface WorkspaceMember {
  id: string;
  user_id: string;
  workspace_id: string;
  role: 'owner' | 'admin' | 'member';
  name: string;
  email: string;
  online?: boolean;
}

export interface Source {
  id: string;
  name: string;
  type: string;
  status: 'processing' | 'ready' | 'failed';
  uploaded_by: string;
  created_at: string;
}

export interface Citation {
  source_name: string;
  page_number?: number;
  chunk_index?: number;
  excerpt?: string; // added to help rendering
}

export interface ChatMessage {
  id: string;
  workspace_id: string;
  user_id: string;
  content: string;
  role: 'user' | 'assistant';
  citations?: Citation[];
  metadata?: { citations?: Citation[] };
  created_at: string;
}

export interface AgentRun {
  id: string;
  agent_type: string;
  status: 'analyzing' | 'planning' | 'awaiting_approval' | 'generating' | 'done' | 'failed';
  plan?: string;
  materials?: any;
  created_at: string;
}

export interface Flashcard {
  front: string;
  back: string;
  source_ref?: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correct: string;
  explanation: string;
  source_ref?: string;
}

export interface StudySection {
  heading: string;
  content: string;
  key_terms: string[];
}

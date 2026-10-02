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

/** Processing progress/result written by the backend and AI service. */
export interface SourceMetadata {
  error?: string; // set when status is 'failed'; safe to show to users
  stage?: 'queued' | 'extracting' | 'chunking' | 'embedding' | 'storing' | 'ready' | 'failed';
  attempts?: number;
  chunk_count?: number;
  page_count?: number | null;
  size_bytes?: number;
}

export interface Source {
  id: string;
  name: string;
  type: string;
  status: 'processing' | 'ready' | 'failed';
  metadata?: SourceMetadata | null;
  created_by?: string;
  uploaded_by?: string;
  created_at: string;
}

export interface Citation {
  source_name: string;
  page_number?: number;
  location_label?: string; // "Page 3", "Slide 2", "Sheet: Yield", "Section: Methods"
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

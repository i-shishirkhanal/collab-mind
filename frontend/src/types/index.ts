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
  role?: 'owner' | 'admin' | 'member';
  created_at?: string;
  processing_count?: number;
  failed_count?: number;
  pending_approvals?: number;
  last_activity_at?: string | null;
}

export interface ActivityItem {
  kind: 'question' | 'source' | 'agent';
  workspace_id: string;
  workspace_name: string;
  actor_name: string | null;
  label: string;
  status: string | null;
  created_at: string;
}

export interface WorkspaceMember {
  id: string;
  user_id: string;
  workspace_id: string;
  role: 'owner' | 'admin' | 'member';
  name: string;
  email?: string; // only returned to owners and admins
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
  is_active?: boolean; // false = switched off for chat, Studio and agents
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
  // Phase 3: resolved against the retrieved chunk server-side
  index?: number; // the [n] marker used in the answer text
  source_id?: string;
  similarity?: number;
}

export interface ChatMessage {
  id: string;
  workspace_id: string;
  user_id: string;
  content: string;
  role: 'user' | 'assistant';
  citations?: Citation[];
  metadata?: ChatMessageMetadata;
  created_at: string;
}

// Stored with each assistant message by the backend (Phase 3). All fields optional:
// older messages only have `citations`.
export interface ChatMessageMetadata {
  citations?: Citation[];
  // grounded | uncited (answer cites no source) | no_answer | no_sources
  grounding?: 'grounded' | 'uncited' | 'no_answer' | 'no_sources' | 'general' | null;
  // 'general' = answered by the general model on request, not from the workspace sources
  mode?: 'sources' | 'general';
  warnings?: string[];
  task?: 'chat' | 'study' | 'research' | null;
  model?: { provider: string; tier: 'flash' | 'pro'; model_used: string; fallback_used: boolean } | null;
  usage?: { total_tokens?: number | null } | null;
}

export interface AgentRun {
  id: string;
  agent_type: string;
  status: 'analyzing' | 'planning' | 'awaiting_approval' | 'generating' | 'done' | 'failed';
  plan?: string;
  materials?: unknown;
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

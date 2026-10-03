// Base API Call Wrapper
import { getAccessToken, handleUnauthorized } from '@/lib/authToken';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

function extractError(parsed: unknown, fallback: string): string {
  if (typeof parsed === 'object' && parsed !== null) {
    const body = parsed as { error?: string; detail?: string; message?: string };
    return body.error || body.detail || body.message || fallback;
  }
  return typeof parsed === 'string' && parsed ? parsed : fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers read endpoint-specific fields
export async function apiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  if (!token) {
    handleUnauthorized();
    throw new Error('UNAUTHORIZED');
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...options.headers,
  };

  let response: Response;
  try {
    response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers,
    });
  } catch {
    throw new Error('CONNECTION_FAILED');
  }

  if (response.status === 401) {
    handleUnauthorized();
    throw new Error('UNAUTHORIZED');
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text && text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new Error(extractError(parsed, `API error: ${response.status} ${response.statusText}`));
  }

  return parsed ?? {};
}

// Workspace API
export const getWorkspaces = () => apiCall('/api/workspaces');
export const getRecentActivity = () => apiCall('/api/workspaces/activity/recent');
export const getWorkspaceById = (id: string) => apiCall(`/api/workspaces/${id}`);
export const getWorkspace = getWorkspaceById;
export const createWorkspace = (data: { name: string; description?: string } | string, description?: string) => {
  const body = typeof data === 'string' ? { name: data, description } : data;
  return apiCall('/api/workspaces', { method: 'POST', body: JSON.stringify(body) });
};

// Sources API
export const getSources = (workspaceId: string, type?: string) => 
  apiCall(`/api/workspaces/${workspaceId}/sources${type ? `?type=${type}` : ''}`);

export const uploadSourceFile = async (workspaceId: string, file: File) => {
  const token = await getAccessToken();
  if (!token) {
    handleUnauthorized();
    throw new Error('UNAUTHORIZED');
  }
  const formData = new FormData();
  formData.append('file', file);

  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/workspaces/${workspaceId}/sources/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData,
    });
  } catch {
    throw new Error('CONNECTION_FAILED');
  }

  if (response.status === 401) {
    handleUnauthorized();
    throw new Error('UNAUTHORIZED');
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text && text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new Error(extractError(parsed, 'Failed to upload source file'));
  }

  return parsed ?? {};
};

export const uploadFile = uploadSourceFile;

export const addUrlSource = (workspaceId: string, url: string) => 
  apiCall(`/api/workspaces/${workspaceId}/sources/url`, { method: 'POST', body: JSON.stringify({ url }) });

export const addUrl = addUrlSource;

export const retrySource = (workspaceId: string, sourceId: string) =>
  apiCall(`/api/workspaces/${workspaceId}/sources/${sourceId}/retry`, { method: 'POST' });

export const setSourceActive = (workspaceId: string, sourceId: string, isActive: boolean) =>
  apiCall(`/api/workspaces/${workspaceId}/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify({ is_active: isActive }) });

export const deleteSource = (workspaceId: string, sourceId: string) =>
  apiCall(`/api/workspaces/${workspaceId}/sources/${sourceId}`, { method: 'DELETE' });

export const summarizeSource = (workspaceId: string, sourceId: string) =>
  apiCall(`/api/workspaces/${workspaceId}/sources/${sourceId}/summarize`, { method: 'POST' });

// Members API
export const getWorkspaceMembers = (workspaceId: string) => 
  apiCall(`/api/workspaces/${workspaceId}/members`);
export const getMembers = getWorkspaceMembers;

export const addWorkspaceMember = (workspaceId: string, email: string, role: string = 'member') =>
  apiCall(`/api/workspaces/${workspaceId}/members`, { method: 'POST', body: JSON.stringify({ email, role }) });
export const inviteMember = addWorkspaceMember;

export const updateMemberRole = (workspaceId: string, userId: string, role: string) =>
  apiCall(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });

export const removeMember = (workspaceId: string, userId: string) =>
  apiCall(`/api/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });

// Chat API
export const CHAT_PAGE_SIZE = 50;
export const sendChatMessage = (
  workspaceId: string,
  message: string,
  conversation_history: unknown[] = [],
  mode?: 'general',
) =>
  apiCall(`/api/workspaces/${workspaceId}/chat`, {
    method: 'POST',
    body: JSON.stringify({ message, conversation_history, ...(mode ? { mode } : {}) }),
  });

export const sendChat = sendChatMessage;

export const getChatHistory = (workspaceId: string, before?: string) =>
  apiCall(`/api/workspaces/${workspaceId}/chat/history?limit=${CHAT_PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ''}`);

// Agent/Studio API
export const triggerStudyCoach = (workspaceId: string, goal: string) => 
  apiCall(`/api/workspaces/${workspaceId}/agents/study-coach`, { method: 'POST', body: JSON.stringify({ goal }) });
export const approveAgent = (workspaceId: string, runId: string) => 
  apiCall(`/api/workspaces/${workspaceId}/agents/${runId}/approve`, { method: 'POST' });
export const getAgentStatus = (workspaceId: string, runId: string) => 
  apiCall(`/api/workspaces/${workspaceId}/agents/${runId}/status`);

export const generateFlashcards = (workspaceId: string, topic: string, count: number) => 
  apiCall(`/api/workspaces/${workspaceId}/studio/flashcards`, { method: 'POST', body: JSON.stringify({ topic, count }) });
export const generateQuiz = (workspaceId: string, topic: string, difficulty: string, count: number) => 
  apiCall(`/api/workspaces/${workspaceId}/studio/quiz`, { method: 'POST', body: JSON.stringify({ topic, difficulty, count }) });
export const generateStudyGuide = (workspaceId: string, topic: string) => 
  apiCall(`/api/workspaces/${workspaceId}/studio/guide`, { method: 'POST', body: JSON.stringify({ topic }) });
export const generateReport = (workspaceId: string, title: string, outlinePoints: string[]) => 
  apiCall(`/api/workspaces/${workspaceId}/studio/report`, { method: 'POST', body: JSON.stringify({ title, outline_points: outlinePoints }) });

// Account API
export const changePassword = (currentPassword: string, newPassword: string) =>
  apiCall('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
export const logoutEverywhere = () => apiCall('/api/auth/logout-all', { method: 'POST' });
export const deleteAccount = (password: string) =>
  apiCall('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) });

// Invitations
export interface WorkspaceInvite {
  id: string;
  workspace_id: string;
  workspace_name: string;
  role: string;
  created_at: string;
  invited_by_name: string | null;
}
export interface PendingInvite { id: string; role: string; created_at: string; invited_name: string }

export const getMyInvites = (): Promise<WorkspaceInvite[]> => apiCall('/api/invites');
export const acceptInvite = (inviteId: string) => apiCall(`/api/invites/${inviteId}/accept`, { method: 'POST' });
export const declineInvite = (inviteId: string) => apiCall(`/api/invites/${inviteId}/decline`, { method: 'POST' });
export const getWorkspaceInvites = (workspaceId: string): Promise<PendingInvite[]> =>
  apiCall(`/api/workspaces/${workspaceId}/invites`);
export const cancelInvite = (workspaceId: string, inviteId: string) =>
  apiCall(`/api/workspaces/${workspaceId}/invites/${inviteId}`, { method: 'DELETE' });

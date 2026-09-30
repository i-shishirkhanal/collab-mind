// Base API Call Wrapper
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export async function apiCall(endpoint: string, options: RequestInit = {}) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('supabase_auth_token') || 'demo-guest-token' : 'demo-guest-token';
  
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...options.headers,
  };

  let response: Response;
  try {
    response = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers,
    });
  } catch (err: any) {
    throw new Error('CONNECTION_FAILED');
  }

  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }

  const text = await response.text();
  let parsed: any = null;
  if (text && text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = text;
    }
  }

  if (!response.ok) {
    const errorMsg = (typeof parsed === 'object' && parsed !== null)
      ? (parsed.error || parsed.detail || parsed.message || `API error: ${response.status} ${response.statusText}`)
      : (typeof parsed === 'string' && parsed ? parsed : `API error: ${response.status} ${response.statusText}`);
    throw new Error(errorMsg);
  }

  return parsed ?? {};
}

// Workspace API
export const getWorkspaces = () => apiCall('/api/workspaces');
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
  const token = typeof window !== 'undefined' ? localStorage.getItem('supabase_auth_token') || 'demo-guest-token' : 'demo-guest-token';
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
  } catch (err: any) {
    throw new Error('CONNECTION_FAILED');
  }

  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }

  const text = await response.text();
  let parsed: any = null;
  if (text && text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = text;
    }
  }

  if (!response.ok) {
    const errorMsg = (typeof parsed === 'object' && parsed !== null)
      ? (parsed.error || parsed.detail || parsed.message || 'Failed to upload source file')
      : (typeof parsed === 'string' && parsed ? parsed : 'Failed to upload source file');
    throw new Error(errorMsg);
  }

  return parsed ?? {};
};

export const uploadFile = uploadSourceFile;

export const addUrlSource = (workspaceId: string, url: string) => 
  apiCall(`/api/workspaces/${workspaceId}/sources/url`, { method: 'POST', body: JSON.stringify({ url }) });

export const addUrl = addUrlSource;

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
export const sendChatMessage = (workspaceId: string, message: string, conversation_history: any[] = []) => 
  apiCall(`/api/workspaces/${workspaceId}/chat`, { method: 'POST', body: JSON.stringify({ message, conversation_history }) });

export const sendChat = sendChatMessage;

export const getChatHistory = (workspaceId: string) => 
  apiCall(`/api/workspaces/${workspaceId}/chat/history`);

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

import { apiCall } from './api';
import { getAccessToken, handleUnauthorized } from './authToken';
import type { Citation } from '@/types';

export interface Podcast {
  id: string;
  params: { source_ids: string[]; topic: string; language: string; length: string };
  status: 'queued' | 'scripting' | 'synthesizing' | 'ready' | 'failed';
  error: string | null;
  created_at: string;
  transcript?: { speaker: 'host' | 'guest'; text: string; citations: number[] }[];
  citations?: Citation[];
  warnings?: string[];
}
export interface PodcastConfig { available: boolean; provider: string; languages: string[]; message: string | null }
const base = (workspace: string) => `/api/workspaces/${workspace}/studio/podcasts`;
export const podcastConfig = (workspace: string): Promise<PodcastConfig> => apiCall(`${base(workspace)}/config`);
export const listPodcasts = (workspace: string): Promise<{ podcasts: Podcast[] }> => apiCall(base(workspace));
export const getPodcast = (workspace: string, id: string): Promise<{ podcast: Podcast }> => apiCall(`${base(workspace)}/${id}`);
export const createPodcast = (workspace: string, params: Podcast['params']): Promise<{ id: string; status: string }> =>
  apiCall(base(workspace), { method: 'POST', body: JSON.stringify(params) });
export async function fetchPodcastAudio(workspace: string, id: string, signal?: AbortSignal): Promise<Blob> {
  const token = await getAccessToken();
  if (!token) { handleUnauthorized(); throw new Error('Please sign in again.'); }
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}${base(workspace)}/${id}/audio`, {
    headers: { Authorization: `Bearer ${token}` }, signal,
  });
  if (response.status === 401) handleUnauthorized();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : 'Could not load the podcast audio.');
  }
  return response.blob();
}

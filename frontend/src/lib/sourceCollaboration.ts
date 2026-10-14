import { apiCall } from './api';
import type { Citation } from '@/types';

export interface Passage { chunk_index: number; content: string; page_number: number | null; location_label: string | null }
export interface AnnotationComment {
  id: string; body: string; user_id: string | null; author_name: string | null; created_at: string;
  mentions: { user_id: string; name: string }[];
}
export interface Annotation {
  id: string; chunk_index: number; start_offset: number; end_offset: number; quote: string; snapshot: string;
  created_by: string | null; author_name: string | null; resolved: boolean; resolved_by_name: string | null;
  stale: boolean; comments: AnnotationComment[];
}
export interface Mention {
  comment_id: string; read_at: string | null; body: string; created_at: string; author_name: string | null;
  annotation_id: string; source_id: string; chunk_index: number; quote: string; source_name: string;
}
export interface Comparison {
  findings: { category: 'agreement' | 'contradiction' | 'gap'; topic: string; left: string; right: string;
    left_citations: number[]; right_citations: number[] }[];
  citations: Citation[];
  coverage: { source_id: string; source_name: string; reviewed_passages: number; total_passages: number; sampled: boolean }[];
  warnings: string[];
}
const base = (workspace: string, source: string) => `/api/workspaces/${workspace}/sources/${source}`;
export const getPassages = (ws: string, source: string, after = -1): Promise<{ passages: Passage[]; next: number | null }> =>
  apiCall(`${base(ws, source)}/passages?after=${after}`);
export const getAnnotations = (ws: string, source: string, after?: string): Promise<{ annotations: Annotation[]; next: string | null }> =>
  apiCall(`${base(ws, source)}/annotations${after ? `?after=${encodeURIComponent(after)}` : ''}`);
export const getAnnotation = (ws: string, source: string, annotation: string): Promise<{ annotation: Annotation }> =>
  apiCall(`${base(ws, source)}/annotations/${annotation}`);
export const createAnnotation = (ws: string, source: string, selection: { chunk_index: number; chunk_content: string; start_offset: number; end_offset: number }, body: string, mentions: string[]) =>
  apiCall(`${base(ws, source)}/annotations`, { method: 'POST', body: JSON.stringify({ ...selection, body, mentions }) });
export const replyToAnnotation = (ws: string, source: string, annotation: string, body: string, mentions: string[]) =>
  apiCall(`${base(ws, source)}/annotations/${annotation}/comments`, { method: 'POST', body: JSON.stringify({ body, mentions }) });
export const resolveAnnotation = (ws: string, source: string, annotation: string, resolved: boolean) =>
  apiCall(`${base(ws, source)}/annotations/${annotation}`, { method: 'PATCH', body: JSON.stringify({ resolved }) });
export const getMentions = (ws: string): Promise<{ mentions: Mention[] }> => apiCall(`/api/workspaces/${ws}/annotation-mentions`);
export const readMention = (ws: string, comment: string) => apiCall(`/api/workspaces/${ws}/annotation-mentions/${comment}`, { method: 'PATCH' });
export const compareSources = (ws: string, ids: string[], focus: string): Promise<Comparison> =>
  apiCall(`/api/workspaces/${ws}/sources/compare`, { method: 'POST', body: JSON.stringify({ source_ids: ids, focus }) });

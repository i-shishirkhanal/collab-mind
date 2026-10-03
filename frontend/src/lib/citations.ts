export interface CitationLike {
  index?: number;
}

/**
 * Resolve the `[n]` marker in an answer to its citation.
 *
 * `n` is the passage number the AI service assigned (citation.index). The service only returns
 * the passages the answer actually cites, in order of first use, so the array position is NOT
 * `n - 1` (e.g. an answer citing only [2] and then [1] yields citations [{index:2},{index:1}]).
 * Messages stored before `index` existed have no such field; for those, position is the only
 * information available and is used as a fallback.
 */
export function citationForMarker<T extends CitationLike>(citations: T[], n: number): T | null {
  const exact = citations.find((c) => c.index === n);
  if (exact) return exact;
  const legacy = citations.every((c) => c.index === undefined);
  return legacy ? citations[n - 1] ?? null : null;
}

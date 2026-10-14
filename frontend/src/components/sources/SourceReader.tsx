"use client";

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/lib/store';
import { createAnnotation, getAnnotation, getAnnotations, getPassages, replyToAnnotation, resolveAnnotation,
  type Annotation, type Passage } from '@/lib/sourceCollaboration';

type Selection = { chunk_index: number; chunk_content: string; start_offset: number; end_offset: number };
const inputClass = 'w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100';
const message = (err: unknown) => err instanceof Error ? err.message : 'Could not save your changes.';

function CommentComposer({ onSubmit, label = 'Post comment' }: {
  onSubmit: (body: string, mentions: string[]) => Promise<void>; label?: string;
}) {
  const members = useWorkspaceStore(s => s.members);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="space-y-2" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await onSubmit(body, mentions); setBody(''); setMentions([]); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }}>
    <textarea aria-label="Comment" required maxLength={4000} value={body} onChange={e => setBody(e.target.value)}
      className={inputClass} rows={3} placeholder="Add your comment…" disabled={busy} />
    <details className="text-xs text-slate-400">
      <summary className="cursor-pointer">@ Mention teammates ({mentions.length}/20)</summary>
      <div className="mt-2 max-h-32 overflow-y-auto space-y-2">
        {members.map(m => <label key={m.user_id} className="flex items-center gap-2">
          <input type="checkbox" checked={mentions.includes(m.user_id)} disabled={busy || (!mentions.includes(m.user_id) && mentions.length >= 20)}
            onChange={e => setMentions(ids => e.target.checked ? [...ids, m.user_id] : ids.filter(id => id !== m.user_id))} />
          {m.name}
        </label>)}
        {!members.length && <p>No teammates available.</p>}
      </div>
    </details>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <Button type="submit" disabled={busy || !body.trim()} size="sm">{busy ? 'Saving…' : label}</Button>
  </form>;
}

function HighlightedPassage({ passage, annotations, onOpen }: {
  passage: Passage; annotations: Annotation[]; onOpen: (id: string) => void;
}) {
  const highlights = annotations.filter(a => a.chunk_index === passage.chunk_index && a.snapshot === passage.content);
  const bounds = [...new Set([0, passage.content.length, ...highlights.flatMap(a => [a.start_offset, a.end_offset])])].sort((a, b) => a - b);
  return <p data-passage={passage.chunk_index} className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-300">
    {bounds.slice(0, -1).map((start, i) => {
      const end = bounds[i + 1];
      const covering = highlights.filter(a => a.start_offset <= start && a.end_offset >= end);
      const text = passage.content.slice(start, end);
      return covering.length ? <mark key={start} className="cursor-pointer rounded-sm bg-amber-400/25 text-amber-100"
        title={`${covering.length} discussion(s) — click to open`} onClick={() => onOpen(covering[0].id)}>{text}</mark> : <span key={start}>{text}</span>;
    })}
  </p>;
}

export function SourceReader({ workspaceId, sourceId, initialChunk = 0, initialAnnotation }: {
  workspaceId: string; sourceId: string; initialChunk?: number; initialAnnotation?: string;
}) {
  const { data: session } = useSession();
  const readerId = useId();
  const workspace = useWorkspaceStore(s => s.workspace);
  const [passages, setPassages] = useState<Passage[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [moreAnnotations, setMoreAnnotations] = useState(false);
  const annotationLimit = useRef(50);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [active, setActive] = useState<string | null>(initialAnnotation || null);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const reader = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(initialChunk - 1);

  const refreshAnnotations = useCallback(async () => {
    const all: Annotation[] = [];
    let after: string | undefined;
    let remaining: string | null;
    do {
      const page = await getAnnotations(workspaceId, sourceId, after);
      all.push(...page.annotations); remaining = page.next; after = page.next || undefined;
    } while (remaining && all.length < annotationLimit.current);
    if (initialAnnotation && !all.some(a => a.id === initialAnnotation)) {
      const result = await getAnnotation(workspaceId, sourceId, initialAnnotation);
      all.push(result.annotation);
    }
    setAnnotations(all); setMoreAnnotations(Boolean(remaining));
  }, [workspaceId, sourceId, initialAnnotation]);

  useEffect(() => {
    let live = true;
    getPassages(workspaceId, sourceId, cursor).then(data => {
      if (live) { setPassages(data.passages); setNext(data.next); setLoading(false); }
    }).catch(err => { if (live) { setError(message(err)); setLoading(false); } });
    return () => { live = false; };
  }, [workspaceId, sourceId, cursor]);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try { if (live) await refreshAnnotations(); }
      catch (err) { if (live) setError(message(err)); }
    };
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(interval); };
  }, [refreshAnnotations]);

  const chooseText = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    const container = node?.closest<HTMLElement>('[data-passage]');
    if (!container || !reader.current?.contains(container) || !container.contains(range.endContainer)) {
      setError('Select text within one passage.'); return;
    }
    const index = Number(container.dataset.passage);
    const passage = passages.find(p => p.chunk_index === index);
    if (!passage) return;
    const prefix = range.cloneRange(); prefix.selectNodeContents(container); prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const end = start + range.toString().length;
    if (end - start > 4000) { setError('Select up to 4000 characters.'); return; }
    if (!range.toString().trim()) return;
    setError(''); setSelection({ chunk_index: index, chunk_content: passage.content, start_offset: start, end_offset: end });
  };

  const openThread = (id: string) => {
    setActive(id); setShowResolved(true);
    requestAnimationFrame(() => document.getElementById(`discussion-${readerId}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const thread = initialAnnotation && !annotations.some(a => a.id === initialAnnotation);
  return <div className="space-y-4">
    <p className="text-xs text-slate-400">Extracted text · Select a passage to highlight it and start a shared discussion.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,1fr)]">
      <div ref={reader} onMouseUp={chooseText} onKeyUp={e => { if (e.key === 'Shift') chooseText(); }} className="min-w-0 space-y-4">
        {loading && <p role="status">Loading passages…</p>}
        {!loading && !passages.length && <p className="text-sm text-slate-400">No indexed passages available.</p>}
        {passages.map(p => <section key={p.chunk_index} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
          <h3 className="mb-2 text-xs font-semibold text-indigo-300">{p.location_label || (p.page_number ? `Page ${p.page_number}` : `Passage ${p.chunk_index + 1}`)}</h3>
          <HighlightedPassage passage={p} annotations={annotations} onOpen={openThread} />
        </section>)}
        <div className="flex gap-2">
          {cursor >= 0 && <Button variant="outline" onClick={() => { setLoading(true); setSelection(null); setCursor(-1); }}>Back to start</Button>}
          {next !== null && <Button variant="outline" onClick={() => { setLoading(true); setSelection(null); setCursor(next); }}>Next passages</Button>}
        </div>
      </div>
      <aside className="min-w-0 space-y-4">
        {selection && <section className="rounded-xl border border-amber-500/40 bg-slate-900 p-4 space-y-3">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-amber-200">New highlight</h3>
            <button className="text-xs text-slate-400" onClick={() => setSelection(null)}>Cancel</button></div>
          <blockquote className="border-l-2 border-amber-400 pl-3 text-sm text-slate-300 whitespace-pre-wrap break-words">{selection.chunk_content.slice(selection.start_offset, selection.end_offset)}</blockquote>
          <CommentComposer label="Start discussion" onSubmit={async (body, mentions) => {
            const result = await createAnnotation(workspaceId, sourceId, selection, body, mentions);
            setSelection(null); setActive(result.id); await refreshAnnotations();
          }} />
        </section>}
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Discussions</h3>
          <label className="text-xs text-slate-400 flex gap-2 items-center"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} />Show resolved</label></div>
        {annotations.filter(a => showResolved || !a.resolved || a.id === active).map(a => {
          const canResolve = a.created_by === session?.user?.id || workspace?.role === 'admin' || workspace?.role === 'owner';
          return <section id={`discussion-${readerId}-${a.id}`} key={a.id} className={`rounded-xl border p-4 space-y-3 ${a.id === active ? 'border-indigo-400 bg-indigo-950/20' : 'border-slate-800 bg-slate-900'}`}>
            <button className="text-left text-sm text-amber-200 whitespace-pre-wrap break-words" onClick={() => { setSelection(null); if (cursor !== a.chunk_index - 1) setLoading(true); setCursor(a.chunk_index - 1); openThread(a.id); }}>“{a.quote}”</button>
            <p className="text-xs text-slate-500">{a.author_name || 'Deleted user'} · Passage {a.chunk_index + 1}{a.resolved ? ` · Resolved by ${a.resolved_by_name || 'a former member'}` : ' · Open'}</p>
            {a.stale && <p className="text-xs text-amber-400">The source changed. This discussion preserves the original selected text.</p>}
            {a.comments.map(c => <article key={c.id} className="rounded-lg bg-slate-950/70 p-3 space-y-1">
              <p className="text-xs text-slate-500">{c.author_name || 'Deleted user'} · {new Date(c.created_at).toLocaleString()}</p>
              <p className="text-sm text-slate-300 whitespace-pre-wrap break-words">{c.body}</p>
              {!!c.mentions.length && <p className="text-xs text-indigo-300">{c.mentions.map(m => `@${m.name}`).join(' ')}</p>}
            </article>)}
            {a.id === active && !a.resolved && <CommentComposer onSubmit={async (body, mentions) => {
              await replyToAnnotation(workspaceId, sourceId, a.id, body, mentions); await refreshAnnotations();
            }} />}
            <div className="flex gap-3 items-center">
              {!a.resolved && <button className="text-xs text-indigo-300" onClick={() => setActive(a.id === active ? null : a.id)}>{a.id === active ? 'Hide reply' : 'Reply'}</button>}
              {canResolve && <button disabled={saving} className="text-xs text-slate-400 disabled:opacity-50" onClick={async () => {
                setSaving(true); setError('');
                try { await resolveAnnotation(workspaceId, sourceId, a.id, !a.resolved); await refreshAnnotations(); }
                catch (err) { setError(message(err)); } finally { setSaving(false); }
              }}>{a.resolved ? 'Reopen' : 'Resolve discussion'}</button>}
            </div>
          </section>;
        })}
        {!annotations.length && <p className="text-sm text-slate-500">No discussions yet. Select text to start one.</p>}
        {(moreAnnotations || thread) && <Button variant="outline" disabled={loadingMore} onClick={async () => {
          setLoadingMore(true); annotationLimit.current += 50;
          try { await refreshAnnotations(); } catch (err) { setError(message(err)); }
          finally { setLoadingMore(false); }
        }}>{loadingMore ? 'Loading…' : 'Load more discussions'}</Button>}
      </aside>
    </div>
  </div>;
}

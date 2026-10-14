"use client";

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SourceReader } from './SourceReader';
import { compareSources, getMentions, readMention, type Comparison, type Mention } from '@/lib/sourceCollaboration';
import type { Source } from '@/types';

const field = 'rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 w-full';
const errorMessage = (err: unknown) => err instanceof Error ? err.message : 'Could not load source collaboration.';

export function SourceCollaboration({ workspaceId, sources, initialSource = '' }: { workspaceId: string; sources: Source[]; initialSource?: string }) {
  const ready = sources.filter(s => s.status === 'ready');
  const [mode, setMode] = useState<'read' | 'compare'>('read');
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [focus, setFocus] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [target, setTarget] = useState<{ source: string; chunk: number; annotation?: string; version: number } | null>(null);
  const [readSource, setReadSource] = useState(initialSource);
  const resultVersion = useRef(0);
  const activeLeft = ready.some(s => s.id === left) ? left : ready[0]?.id || '';
  const activeRight = ready.some(s => s.id === right) && right !== activeLeft ? right : ready.find(s => s.id !== activeLeft)?.id || '';
  const activeRead = ready.some(s => s.id === readSource) ? readSource : ready[0]?.id || '';

  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const data = await getMentions(workspaceId); if (live) setMentions(data.mentions); }
      catch (err) { if (live) setError(errorMessage(err)); }
    };
    void load(); const interval = setInterval(load, 10000);
    return () => { live = false; clearInterval(interval); };
  }, [workspaceId]);

  const openPassage = (source: string, chunk = 0, annotation?: string) => {
    setTarget({ source, chunk, annotation, version: Date.now() });
    requestAnimationFrame(() => document.getElementById('source-passage-reader')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const citations = (refs: number[]) => <div className="mt-2 flex gap-2 flex-wrap">{refs.map(n => {
    const citation = comparison?.citations.find(c => c.index === n);
    return citation ? <button key={n} className="text-xs text-indigo-300 underline underline-offset-4"
      title={citation.excerpt} onClick={() => citation.source_id && openPassage(citation.source_id, citation.chunk_index || 0)}>
      [{n}] {citation.location_label || (citation.page_number ? `Page ${citation.page_number}` : `Passage ${(citation.chunk_index || 0) + 1}`)}
    </button> : null;
  })}</div>;

  return <section id="source-collaboration" className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-4 md:p-6">
    <div><h2 className="text-xl font-semibold text-slate-100">Read together. Compare ideas.</h2>
      <p className="mt-1 text-sm text-slate-400">Highlight source passages, discuss them with teammates, or compare evidence across two documents.</p></div>
    <details className="rounded-xl border border-slate-800 p-4">
      <summary className="cursor-pointer text-sm text-indigo-300">Your mentions · {mentions.filter(m => !m.read_at).length} unread</summary>
      <div className="mt-3 space-y-2 max-h-72 overflow-y-auto">
        {!mentions.length && <p className="text-sm text-slate-500">When teammates mention you in a discussion, it appears here.</p>}
        {mentions.map(m => <div key={m.comment_id} className={`rounded-lg p-3 ${m.read_at ? 'bg-slate-950/40' : 'bg-indigo-950/40'}`}>
          <p className="text-xs text-slate-400">{m.author_name || 'Deleted user'} mentioned you · {m.source_name}</p>
          <p className="text-sm text-slate-300 whitespace-pre-wrap break-words mt-1">{m.body}</p>
          <button className="text-xs text-indigo-300 mt-2" onClick={async () => {
            openPassage(m.source_id, m.chunk_index, m.annotation_id);
            try { await readMention(workspaceId, m.comment_id); setMentions(all => all.map(item => item.comment_id === m.comment_id ? { ...item, read_at: new Date().toISOString() } : item)); }
            catch (err) { setError(errorMessage(err)); }
          }}>Open discussion</button>
        </div>)}
      </div>
    </details>
    <div className="flex gap-2" role="group" aria-label="Source tools">
      <Button aria-pressed={mode === 'read'} variant={mode === 'read' ? 'default' : 'outline'} onClick={() => setMode('read')}>Read & annotate</Button>
      <Button aria-pressed={mode === 'compare'} variant={mode === 'compare' ? 'default' : 'outline'} onClick={() => setMode('compare')}>Compare sources</Button>
    </div>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {!ready.length && <p className="text-sm text-slate-400">Upload a source and let it finish processing to start.</p>}
    {ready.length > 0 && mode === 'read' && <>
      <label className="block text-sm text-slate-300">Choose a source
        <select className={`${field} mt-2`} value={activeRead} onChange={e => { setReadSource(e.target.value); setTarget(null); }}>
          {ready.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <SourceReader key={`${workspaceId}-${activeRead}`} workspaceId={workspaceId} sourceId={activeRead} />
    </>}
    {mode === 'compare' && <>
      {ready.length < 2 ? <p className="text-sm text-slate-400">You need two processed sources to compare.</p> : <>
        <form className="space-y-3" onSubmit={async e => {
          e.preventDefault(); setBusy(true); setError(''); setComparison(null); setTarget(null);
          const version = ++resultVersion.current;
          try {
            const result = await compareSources(workspaceId, [activeLeft, activeRight], focus);
            if (version === resultVersion.current) setComparison(result);
          } catch (err) { if (version === resultVersion.current) setError(errorMessage(err)); }
          finally { if (version === resultVersion.current) setBusy(false); }
        }}>
          <div className="grid md:grid-cols-2 gap-4">
            <label className="text-sm text-slate-400">Left document<select className={`${field} mt-2`} value={activeLeft} disabled={busy}
              onChange={e => { setLeft(e.target.value); setComparison(null); setTarget(null); }}>
              {ready.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
            <label className="text-sm text-slate-400">Right document<select className={`${field} mt-2`} value={activeRight} disabled={busy}
              onChange={e => { setRight(e.target.value); setComparison(null); setTarget(null); }}>
              {ready.filter(s => s.id !== activeLeft).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          </div>
          <label className="block text-sm text-slate-400">Focus (optional)<input className={`${field} mt-2`} value={focus} maxLength={500}
            disabled={busy} onChange={e => setFocus(e.target.value)} placeholder="e.g. Compare methods, findings, and limitations" /></label>
          <Button type="submit" disabled={busy || !activeRight}>{busy ? 'Comparing evidence…' : 'Compare with citations'}</Button>
        </form>
        {comparison && <div className="space-y-5" aria-live="polite">
          <div className="grid md:grid-cols-2 gap-4">{comparison.coverage.map(c => <div key={c.source_id} className="rounded-xl bg-slate-950 p-4">
            <p className="font-medium text-slate-200 break-words">{c.source_name}</p>
            <p className="text-xs text-slate-500 mt-1">Reviewed {c.reviewed_passages} of {c.total_passages} passages{c.sampled ? ' · Sampled content' : ''}</p>
            <button className="text-xs text-indigo-300 mt-2" onClick={() => openPassage(c.source_id)}>Read & annotate</button>
          </div>)}</div>
          <div className="space-y-1">{comparison.warnings.map((w, i) => <p key={i} className="text-xs text-amber-300/90">{w}</p>)}</div>
          {(['agreement', 'contradiction', 'gap'] as const).map(category => <section key={category} className="space-y-3">
            <h3 className="text-base font-semibold text-slate-100">{{ agreement: 'Agreements', contradiction: 'Contradictions', gap: 'Missing information' }[category]}</h3>
            {!comparison.findings.some(f => f.category === category) && <p className="text-sm text-slate-500">No supported {category === 'gap' ? 'gaps' : `${category}s`} found in the reviewed passages.</p>}
            {comparison.findings.filter(f => f.category === category).map((finding, i) => <article key={i} className="overflow-hidden rounded-xl border border-slate-800">
              <h4 className="bg-slate-800/60 px-4 py-3 text-sm font-semibold text-indigo-200">{finding.topic}</h4>
              <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-800">
                <div className="p-4"><p className="mb-2 text-xs text-slate-500">{comparison.coverage[0].source_name}</p><p className="text-sm text-slate-300 whitespace-pre-wrap">{finding.left}</p>{citations(finding.left_citations)}</div>
                <div className="p-4"><p className="mb-2 text-xs text-slate-500">{comparison.coverage[1].source_name}</p><p className="text-sm text-slate-300 whitespace-pre-wrap">{finding.right}</p>{citations(finding.right_citations)}</div>
              </div>
            </article>)}
          </section>)}
        </div>}
        <details className="rounded-xl border border-slate-800 p-4"><summary className="cursor-pointer text-sm text-slate-300">Read documents side by side</summary>
          <div className="mt-4 grid lg:grid-cols-2 gap-5">
            {[activeLeft, activeRight].map((source, i) => <div key={`${i}-${source}`} className="min-w-0">
              <h3 className="mb-3 font-semibold text-indigo-200">{ready.find(s => s.id === source)?.name}</h3>
              <SourceReader workspaceId={workspaceId} sourceId={source} />
            </div>)}
          </div>
        </details>
      </>}
    </>}
    {target && <section id="source-passage-reader" className="border-t border-slate-700 pt-5 space-y-4">
      <div className="flex justify-between items-center gap-3"><h3 className="text-lg text-slate-100">{sources.find(s => s.id === target.source)?.name || 'Source passage'}</h3>
        <Button size="sm" variant="outline" onClick={() => setTarget(null)}>Close reader</Button></div>
      <SourceReader key={`${target.source}-${target.version}`} workspaceId={workspaceId} sourceId={target.source}
        initialChunk={target.chunk} initialAnnotation={target.annotation} />
    </section>}
  </section>;
}

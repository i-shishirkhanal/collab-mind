"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Headphones, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CitationPanel } from '@/components/CitationPanel';
import { getSources } from '@/lib/api';
import { createPodcast, fetchPodcastAudio, getPodcast, listPodcasts, podcastConfig, type Podcast, type PodcastConfig } from '@/lib/podcasts';
import type { Source, Citation } from '@/types';

const field = 'w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100';
const active = (status: string) => ['queued', 'scripting', 'synthesizing'].includes(status);
const statusText = { queued: 'Queued', scripting: 'Writing the conversation', synthesizing: 'Creating the audio', ready: 'Ready to listen', failed: 'Generation failed' };
const errorMessage = (err: unknown) => err instanceof Error ? err.message : 'Something went wrong. Please try again.';

export function PodcastTool({ workspaceId }: { workspaceId: string }) {
  const [config, setConfig] = useState<PodcastConfig | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const [language, setLanguage] = useState('English');
  const [length, setLength] = useState('short');
  const [jobs, setJobs] = useState<Podcast[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Podcast | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');
  const [citation, setCitation] = useState<Citation | null>(null);
  const currentId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await listPodcasts(workspaceId);
    setJobs(data.podcasts);
    setJobId(current => current || data.podcasts[0]?.id || null);
    return data.podcasts;
  }, [workspaceId]);

  useEffect(() => {
    const timer = setInterval(() => { void refresh().catch(err => setError(errorMessage(err))); }, 8000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let live = true;
    Promise.all([podcastConfig(workspaceId), getSources(workspaceId), listPodcasts(workspaceId)]).then(([settings, sourceData, history]) => {
      if (!live) return;
      setConfig(settings);
      const all: Source[] = Array.isArray(sourceData) ? sourceData : sourceData.sources || [];
      setSources(all.filter(s => s.status === 'ready' && s.is_active !== false));
      setJobs(history.podcasts);
      setJobId(history.podcasts[0]?.id || null);
    }).catch(err => { if (live) setError(errorMessage(err)); }).finally(() => { if (live) setInitializing(false); });
    return () => { live = false; };
  }, [workspaceId]);

  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await getPodcast(workspaceId, jobId);
        if (!live) return;
        setJob(result.podcast);
        setJobs(all => all.map(j => j.id === jobId ? result.podcast : j));
        if (active(result.podcast.status)) timer = setTimeout(load, 3000);
      } catch (err) { if (live) { setError(errorMessage(err)); timer = setTimeout(load, 10000); } }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [workspaceId, jobId]);

  useEffect(() => {
    currentId.current = jobId;
    setAudioUrl(null);
    setLoadingAudio(false);
  }, [jobId]);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  const working = submitting || jobs.some(j => active(j.status));
  const chooseJob = (id: string) => { setJob(null); setJobId(id); setError(''); setCitation(null); };
  return <div className="space-y-6">
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-5">
      <div className="flex gap-3 items-start"><Headphones className="mt-1 size-7 text-indigo-400" /><div>
        <h2 className="text-xl font-semibold text-slate-50">Podcast Studio</h2>
        <p className="mt-1 text-sm text-slate-400">Turn your sources into a conversation between two AI voices. Powered by Podcastfy.</p>
      </div></div>
      {initializing && <p className="text-sm text-slate-400" role="status">Loading podcast tools…</p>}
      {config && !config.available && <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-300">{config.message}</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <form className="space-y-4" onSubmit={async e => {
        e.preventDefault(); setSubmitting(true); setError('');
        try {
          const result = await createPodcast(workspaceId, { source_ids: selected, topic, language, length });
          setJob(null); setJobId(result.id); await refresh();
        } catch (err) { setError(errorMessage(err)); } finally { setSubmitting(false); }
      }}>
        <fieldset disabled={working || initializing} className="space-y-4 disabled:opacity-60">
          <legend className="text-sm text-slate-300 mb-2">Sources · choose up to 6</legend>
          <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-2">
            {sources.map(s => <label key={s.id} className="flex gap-3 text-sm text-slate-300 items-start">
              <input type="checkbox" className="mt-1" checked={selected.includes(s.id)} disabled={!selected.includes(s.id) && selected.length >= 6}
                onChange={e => setSelected(ids => e.target.checked ? [...ids, s.id] : ids.filter(id => id !== s.id))} />{s.name}
            </label>)}
            {!sources.length && <p className="text-sm text-slate-500">Add a source and keep it active after processing to make a podcast.</p>}
          </div>
          <label className="block text-sm text-slate-300">Focus (optional)<input value={topic} onChange={e => setTopic(e.target.value)} maxLength={500}
            placeholder="e.g. Explain the main findings for exam revision" className={`${field} mt-2`} /></label>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="text-sm text-slate-300">Language<select className={`${field} mt-2`} value={language} onChange={e => setLanguage(e.target.value)}>
              {(config?.languages || ['English', 'Hindi', 'Spanish', 'French']).map(l => <option key={l}>{l}</option>)}
            </select></label>
            <label className="text-sm text-slate-300">Length<select className={`${field} mt-2`} value={length} onChange={e => setLength(e.target.value)}>
              <option value="short">Short · roughly 2–4 minutes</option><option value="standard">Standard · roughly 5–8 minutes</option>
            </select></label>
          </div>
        </fieldset>
        <p className="text-xs text-slate-500">The dialogue is generated from selected excerpts. Its text is sent to the configured speech provider. Saved podcasts are kept for seven days.</p>
        <Button type="submit" disabled={initializing || working || !config?.available || !selected.length}>
          {working ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Headphones className="mr-2 size-4" />}
          {working ? 'A podcast is being generated…' : 'Generate podcast'}
        </Button>
      </form>
    </section>

    {!!jobs.length && <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-4">
      <label className="block text-sm text-slate-300">Workspace podcasts<select value={jobId || ''} onChange={e => chooseJob(e.target.value)} className={`${field} mt-2`}>
        {jobs.map(j => <option key={j.id} value={j.id}>{j.params.topic || 'Source overview'} · {j.params.language} · {statusText[j.status]} · {new Date(j.created_at).toLocaleDateString()}</option>)}
      </select></label>
      {!job && <p className="text-sm text-slate-500">Loading podcast…</p>}
      {job && <>
        <p role="status" className="text-sm text-indigo-300 flex gap-2 items-center">{active(job.status) && <Loader2 className="size-4 animate-spin" />}{statusText[job.status]}</p>
        {job.error && <p role="alert" className="text-sm text-red-400">{job.error}</p>}
        {job.status === 'ready' && <div className="space-y-3">
          {!audioUrl && <Button variant="outline" disabled={loadingAudio} onClick={async () => {
            const id = job.id; setLoadingAudio(true); setError('');
            try {
              const blob = await fetchPodcastAudio(workspaceId, id);
              if (currentId.current !== id) return;
              setAudioUrl(URL.createObjectURL(blob));
            } catch (err) { if (currentId.current === id) setError(errorMessage(err)); }
            finally { if (currentId.current === id) setLoadingAudio(false); }
          }}>{loadingAudio ? 'Loading audio…' : 'Load audio player'}</Button>}
          {audioUrl && <><audio controls preload="metadata" src={audioUrl} className="w-full" aria-label="Generated podcast" />
            <a href={audioUrl} download={`collabmind-${job.id}.mp3`} className="inline-flex items-center gap-2 text-sm text-indigo-300"><Download className="size-4" />Download MP3</a></>}
        </div>}
        {!!job.transcript?.length && <>
          <div className="space-y-1">{job.warnings?.map((w, i) => <p key={i} className="text-xs text-amber-300">{w}</p>)}</div>
          <details className="rounded-xl border border-slate-800 p-4"><summary className="cursor-pointer text-sm text-slate-200">Transcript & source references</summary>
            <div className="mt-4 space-y-4">{job.transcript.map((turn, i) => <article key={i} className="rounded-xl bg-slate-950 p-4">
              <h3 className="text-xs uppercase tracking-wide text-indigo-300">{turn.speaker}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-300 whitespace-pre-wrap">{turn.text}</p>
              <div className="mt-2 flex flex-wrap gap-2">{turn.citations.map(n => {
                const c = job.citations?.find(c => c.index === n);
                return c ? <button key={n} onClick={() => setCitation(c)} className="text-xs text-indigo-300 underline">[{n}] {c.source_name}</button> : null;
              })}</div>
            </article>)}</div>
          </details>
        </>}
      </>}
    </section>}
    <CitationPanel citation={citation} onClose={() => setCitation(null)} />
  </div>;
}

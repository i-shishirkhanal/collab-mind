"use client";

import { use, useEffect, useState } from "react";
import { useWorkspaceStore } from "@/lib/store";
import { SourceUploader } from "@/components/SourceUploader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Database, Trash2, Globe, Sparkles, Loader2, X, Copy, Check } from "lucide-react";
import { getSources, summarizeSource } from "@/lib/api";

export default function SourcesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sources = useWorkspaceStore(s => s.sources);
  const setSources = useWorkspaceStore(s => s.setSources);

  const [activeSummary, setActiveSummary] = useState<{
    source_name: string;
    summary: string;
    key_takeaways: string[];
    word_count: number;
  } | null>(null);
  const [loadingSummaryId, setLoadingSummaryId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function fetchSourcesData() {
      try {
        const sData = await getSources(id);
        if (isMounted) {
          const list = Array.isArray(sData) ? sData : (sData?.sources || []);
          setSources(list);
        }
      } catch (err) {
        console.error("Failed to load sources:", err);
      }
    }

    fetchSourcesData();

    const interval = setInterval(() => {
      fetchSourcesData();
    }, 4000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [id, setSources]);

  useEffect(() => {
    const handleUpdate = async () => {
      try {
        const sData = await getSources(id);
        const list = Array.isArray(sData) ? sData : (sData?.sources || []);
        setSources(list);
      } catch (err) {
        console.error(err);
      }
    };
    window.addEventListener('sources-updated', handleUpdate);
    return () => window.removeEventListener('sources-updated', handleUpdate);
  }, [id, setSources]);

  const handleSummarize = async (sourceId: string, sourceName: string) => {
    setLoadingSummaryId(sourceId);
    try {
      const data = await summarizeSource(id, sourceId);
      setActiveSummary({
        source_name: data.source_name || sourceName,
        summary: data.summary || "Summary generated from workspace index.",
        key_takeaways: data.key_takeaways || [],
        word_count: data.word_count || 0
      });
    } catch (err) {
      console.error("Summarization error", err);
    } finally {
      setLoadingSummaryId(null);
    }
  };

  const copyToClipboard = () => {
    if (!activeSummary) return;
    const text = `Document: ${activeSummary.source_name}\n\nSummary:\n${activeSummary.summary}\n\nKey Takeaways:\n${activeSummary.key_takeaways.map(t => `- ${t}`).join('\n')}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'processing': return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 capitalize flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></div>Processing</Badge>;
      case 'ready': return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 capitalize">Ready</Badge>;
      case 'failed': return <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20 capitalize">Failed</Badge>;
      default: return <Badge variant="outline" className="bg-slate-500/10 text-slate-400 border-slate-500/20 capitalize">{status}</Badge>;
    }
  };

  const getTypeIcon = (type: string) => {
    if (type.includes('pdf')) return <FileText className="w-4 h-4 text-red-400" />;
    if (type.includes('url')) return <Globe className="w-4 h-4 text-blue-400" />;
    return <FileText className="w-4 h-4 text-slate-400" />;
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-950 custom-scrollbar p-8 relative">
      <div className="max-w-5xl mx-auto space-y-10">
        
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Data Sources</h1>
          <p className="text-sm text-slate-400 mt-1">Manage, index, and summarize the documents that power your workspace AI context.</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm">
          <SourceUploader workspaceId={id} />
        </div>

        <div>
          <h3 className="text-lg font-medium text-slate-200 mb-4">Indexed Sources</h3>
          
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            {sources.length === 0 ? (
              <div className="text-center py-10 text-slate-500">
                <Database className="w-8 h-8 mx-auto mb-3 opacity-20" />
                <p>No sources uploaded yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-400 bg-slate-900/50">
                      <th className="px-6 py-4 font-medium">Name</th>
                      <th className="px-6 py-4 font-medium hidden sm:table-cell">Type</th>
                      <th className="px-6 py-4 font-medium">Status</th>
                      <th className="px-6 py-4 font-medium hidden md:table-cell">Date</th>
                      <th className="px-6 py-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50 text-sm">
                    {sources.map(source => (
                      <tr key={source.id} className="hover:bg-slate-800/30 transition-colors group">
                        <td className="px-6 py-4 text-slate-200 font-medium">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded shrink-0 bg-slate-800 flex items-center justify-center border border-slate-700">
                              {getTypeIcon(source.type)}
                            </div>
                            <span className="truncate max-w-[200px] sm:max-w-xs">{source.name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-slate-400 hidden sm:table-cell capitalize">
                          {source.type.split('/')[1] || source.type}
                        </td>
                        <td className="px-6 py-4">
                          {getStatusBadge(source.status)}
                        </td>
                        <td className="px-6 py-4 text-slate-500 hidden md:table-cell">
                          {source.created_at ? new Date(source.created_at).toLocaleDateString() : 'Recently'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button 
                              variant="outline" 
                              size="sm"
                              disabled={loadingSummaryId === source.id || source.status !== 'ready'}
                              onClick={() => handleSummarize(source.id, source.name)}
                              className="border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10 hover:text-indigo-300 text-xs"
                            >
                              {loadingSummaryId === source.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                              ) : (
                                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                              )}
                              Summarize
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Source Summary Modal */}
      {activeSummary && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-6 shadow-2xl relative animate-in zoom-in-95 duration-200">
            <button 
              onClick={() => setActiveSummary(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>

            <div>
              <div className="flex items-center gap-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-1">
                <Sparkles className="w-4 h-4" /> AI Document Summary
              </div>
              <h2 className="text-xl font-bold text-white truncate max-w-[85%]">{activeSummary.source_name}</h2>
              {activeSummary.word_count > 0 && (
                <span className="text-xs text-slate-500">{activeSummary.word_count} total words indexed</span>
              )}
            </div>

            <div className="space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
              <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Executive Summary</h4>
                <p className="text-slate-300 text-sm leading-relaxed">{activeSummary.summary}</p>
              </div>

              {activeSummary.key_takeaways.length > 0 && (
                <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Key Takeaways</h4>
                  <ul className="space-y-2">
                    {activeSummary.key_takeaways.map((point, idx) => (
                      <li key={idx} className="flex items-start gap-2.5 text-sm text-slate-300">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0 mt-2"></span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-800">
              <Button onClick={copyToClipboard} variant="outline" className="border-slate-700 text-slate-300 hover:text-white">
                {copied ? <Check className="w-4 h-4 mr-2 text-emerald-400" /> : <Copy className="w-4 h-4 mr-2" />}
                {copied ? "Copied!" : "Copy Summary"}
              </Button>
              <Button onClick={() => setActiveSummary(null)} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

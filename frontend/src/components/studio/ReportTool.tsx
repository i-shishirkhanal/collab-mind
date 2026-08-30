"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, X, Download } from "lucide-react";
import { generateReport } from "@/lib/api";

export function ReportTool({ workspaceId }: { workspaceId: string }) {
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState<string[]>([""]);
  const [loading, setLoading] = useState(false);
  const [reportText, setReportText] = useState<string | null>(null);

  const addPoint = () => setPoints([...points, ""]);
  const updatePoint = (index: number, val: string) => {
    const updated = [...points];
    updated[index] = val;
    setPoints(updated);
  };
  const removePoint = (index: number) => {
    if (points.length === 1) return;
    setPoints(points.filter((_, i) => i !== index));
  };

  const handleGenerate = async () => {
    if (!title || !points[0]) return;
    setLoading(true);
    try {
      const data = await generateReport(workspaceId, title, points.filter(p => p.trim() !== ""));
      setReportText(data.markdown || data.content || "");
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const downloadMd = () => {
    if (!reportText) return;
    const blob = new Blob([reportText], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_')}_Report.md`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-sm">
        <h2 className="text-xl font-semibold text-white mb-4">Draft Report</h2>
        <div className="space-y-4 max-w-xl">
          <div className="space-y-2">
            <Label className="text-slate-300">Report Title</Label>
            <Input 
              placeholder="Quarterly Performance Analysis" 
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500"
            />
          </div>
          
          <div className="space-y-3">
            <Label className="text-slate-300">Outline Points</Label>
            {points.map((pt, idx) => (
               <div key={idx} className="flex items-center gap-2">
                 <Input 
                   placeholder="Outline point..." 
                   value={pt}
                   onChange={(e) => updatePoint(idx, e.target.value)}
                   className="bg-slate-800 border-slate-700 text-slate-100 flex-1"
                 />
                 <Button 
                   variant="ghost" 
                   size="icon" 
                   onClick={() => removePoint(idx)} 
                   disabled={points.length === 1}
                   className="text-slate-400 hover:text-red-400"
                 >
                   <X className="w-4 h-4" />
                 </Button>
               </div>
            ))}
            <Button variant="outline" size="sm" onClick={addPoint} className="border-indigo-500/50 text-indigo-400 hover:bg-indigo-500/10 hover:text-indigo-300 border-dashed w-full">
              <Plus className="w-4 h-4 mr-2" /> Add Point
            </Button>
          </div>

          <Button 
            onClick={handleGenerate} 
            disabled={loading || !title || !points[0]}
            className="bg-indigo-600 hover:bg-indigo-700 text-white mt-4 w-full md:w-auto"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Generate Draft
          </Button>
        </div>
      </div>

      {loading && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 flex flex-col items-center justify-center min-h-[200px] text-slate-400 animate-pulse">
           <Loader2 className="w-8 h-8 animate-spin text-indigo-500 mb-3" />
           <p>Synthesizing sources based on outline...</p>
        </div>
      )}

      {reportText && !loading && (
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-700">
            <h3 className="text-lg font-medium text-slate-200">Generated Report</h3>
            <Button onClick={downloadMd} variant="outline" className="border-slate-600 text-slate-300 hover:text-white hover:bg-indigo-600 hover:border-indigo-600">
              <Download className="w-4 h-4 mr-2" /> Download .md
            </Button>
          </div>
          <pre className="whitespace-pre-wrap text-sm text-slate-300 font-mono bg-slate-900 rounded-xl p-4 overflow-auto max-h-[500px] custom-scrollbar">
            {reportText}
          </pre>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { generateStudyGuide } from "@/lib/api";

export function StudyGuideTool({ workspaceId }: { workspaceId: string }) {
  const [topic, setTopic] = useState("");
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!topic) return;
    setLoading(true);
    try {
      const data = await generateStudyGuide(workspaceId, topic);
      setContent(data.markdown || data.content || "");
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-8rem)]">
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-sm shrink-0">
        <h2 className="text-xl font-semibold text-white mb-4">Generate Study Guide</h2>
        <div className="space-y-4 max-w-xl">
          <div className="space-y-2">
            <Label htmlFor="sg-topic" className="text-slate-300">Guide Topic</Label>
            <Input 
              id="sg-topic" 
              placeholder="What do you want to study?" 
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500 max-w-md"
            />
          </div>
          <Button 
            onClick={handleGenerate} 
            disabled={loading || !topic}
            className="bg-indigo-600 hover:bg-indigo-700 text-white mt-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Generate Guide
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex-1 bg-slate-800/50 rounded-2xl border border-slate-700 flex items-center justify-center min-h-[400px]">
          <div className="flex flex-col items-center text-slate-400 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
            <p>Synthesizing sources for study guide (this may take a minute)...</p>
          </div>
        </div>
      )}

      {content && !loading && (
        <div className="flex-1 bg-slate-800 rounded-2xl border border-slate-700 p-8 shadow-inner overflow-hidden flex flex-col min-h-[500px]">
          <div className="prose prose-invert prose-indigo max-w-none overflow-y-auto custom-scrollbar pr-4 flex-1">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

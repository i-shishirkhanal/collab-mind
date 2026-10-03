"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { generateQuiz } from "@/lib/api";
import { QuizQuestion } from "@/types";

export function QuizTool({ workspaceId }: { workspaceId: string }) {
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState(5);
  const [loading, setLoading] = useState(false);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  const handleGenerate = async () => {
    if (!topic) return;
    setLoading(true);
    try {
      const data = await generateQuiz(workspaceId, topic, difficulty, count);
      setQuestions(data.questions || []);
      setRevealed({});
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleReveal = (index: number) => {
    setRevealed(prev => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-sm">
        <h2 className="text-xl font-semibold text-slate-50 mb-4">Generate Practice Quiz</h2>
        <div className="space-y-4 max-w-xl">
          <div className="space-y-2">
            <Label htmlFor="q-topic" className="text-slate-300">Topic</Label>
            <Input 
              id="q-topic" 
              placeholder="e.g. API Architecture" 
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500 max-w-md"
            />
          </div>
          
          <div className="flex gap-4 max-w-md">
            <div className="space-y-2 flex-1">
              <Label className="text-slate-300">Difficulty</Label>
              <select 
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-md p-2 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div className="space-y-2 flex-1">
              <Label className="text-slate-300">Count</Label>
              <Input 
                type="number"
                min={1} max={30}
                value={count}
                onChange={(e) => setCount(parseInt(e.target.value))}
                className="bg-slate-800 border-slate-700 text-slate-100 w-full"
              />
            </div>
          </div>

          <Button 
            onClick={handleGenerate} 
            disabled={loading || !topic}
            className="bg-indigo-600 hover:bg-indigo-700 text-white mt-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Generate Quiz
          </Button>
        </div>
      </div>

      {loading && (
        <div className="space-y-4 animate-pulse">
          {[1,2,3].map(i => (
            <div key={i} className="h-24 bg-slate-800/50 rounded-2xl border border-slate-700" />
          ))}
        </div>
      )}

      {questions.length > 0 && !loading && (
        <div className="space-y-4">
          {questions.map((item, i) => (
            <div key={i} className="bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <span className="text-indigo-400 font-semibold mb-2 block text-sm">Question {i + 1}</span>
                  <h3 className="text-slate-200 text-lg mb-4">{item.question}</h3>
                  <div className="space-y-2 mb-4">
                    {item.options.map((opt, optIdx) => (
                      <div key={optIdx} className="flex items-start gap-2 text-slate-300 text-sm">
                        <span className="font-mono text-slate-500">{String.fromCharCode(65 + optIdx)}.</span>
                        <span>{opt}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => toggleReveal(i)}
                  className="shrink-0 border-slate-600 text-slate-300 hover:text-slate-50 hover:bg-slate-700"
                >
                  {revealed[i] ? "Hide Answer" : "Reveal Answer"}
                  {revealed[i] ? <ChevronUp className="w-4 h-4 ml-2" /> : <ChevronDown className="w-4 h-4 ml-2" />}
                </Button>
              </div>
              
              {revealed[i] && (
                <div className="mt-4 p-4 bg-slate-900 rounded-xl border border-emerald-500/20 animate-in slide-in-from-top-2 duration-200 relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500"></div>
                  <div className="font-semibold text-emerald-400 mb-2 border-b border-slate-700/50 pb-2 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    Correct Answer: {item.correct}
                  </div>
                  <p className="text-slate-300 text-sm mt-2">{item.explanation}</p>
                  {item.source_ref && (
                    <p className="text-xs text-slate-500 mt-3 pt-2 border-t border-slate-800">Source: {item.source_ref}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

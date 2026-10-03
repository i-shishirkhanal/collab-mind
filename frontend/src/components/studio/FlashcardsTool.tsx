"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { generateFlashcards } from "@/lib/api";
import { Flashcard } from "@/types";

export function FlashcardsTool({ workspaceId }: { workspaceId: string }) {
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [flipped, setFlipped] = useState<Record<number, boolean>>({});

  const handleGenerate = async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const data = await generateFlashcards(workspaceId, topic, count);
      setCards(data?.flashcards || []);
      setFlipped({});
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleFlip = (index: number) => {
    setFlipped(prev => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-sm">
        <h2 className="text-xl font-semibold text-slate-50 mb-4">Generate Flashcards</h2>
        <div className="space-y-4 max-w-xl">
          <div className="space-y-2">
            <Label htmlFor="topic" className="text-slate-300">Topic (Optional)</Label>
            <Input 
              id="topic" 
              placeholder="e.g. System Architecture" 
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500 max-w-md"
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between items-center max-w-sm">
              <Label htmlFor="count" className="text-slate-300">Card Count: {count}</Label>
            </div>
            <input 
              type="range" 
              id="count" 
              min={5} 
              max={50} 
              step={1} 
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value))}
              className="w-full max-w-sm accent-indigo-500"
            />
          </div>
          <Button 
            onClick={handleGenerate} 
            disabled={loading || !workspaceId}
            className="bg-indigo-600 hover:bg-indigo-700 text-white mt-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Generate {count} Cards
          </Button>
        </div>
      </div>

      {loading && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-6 animate-pulse">
          {[1,2,3,4,5,6].map(i => (
            <div key={i} className="h-48 bg-slate-800/50 rounded-2xl border border-slate-700" />
          ))}
        </div>
      )}

      {cards.length > 0 && !loading && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-6">
          {cards.map((card, i) => {
            const isFlipped = !!flipped[i];
            return (
              <div 
                key={i} 
                onClick={() => toggleFlip(i)}
                className="h-48 relative cursor-pointer group perspective-1000"
              >
                <div className={`w-full h-full transition-all duration-500 transform-style-3d ${isFlipped ? 'rotate-y-180' : ''}`}>
                  {/* Front */}
                  <div className="absolute inset-0 backface-hidden bg-slate-800 border border-slate-700 rounded-2xl p-6 flex flex-col items-center justify-center text-center shadow-md group-hover:border-indigo-500/50 transition-colors">
                    <p className="text-slate-200 font-medium">{card.front}</p>
                    {card.source_ref && (
                      <span className="absolute bottom-3 text-[10px] text-slate-500 truncate max-w-[80%]">Ref: {card.source_ref}</span>
                    )}
                  </div>
                  {/* Back */}
                  <div className="absolute inset-0 backface-hidden rotate-y-180 bg-indigo-950/40 border border-indigo-900 rounded-2xl p-6 flex items-center justify-center text-center shadow-md overflow-y-auto">
                    <p className="text-slate-50 font-medium text-sm">{card.back}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

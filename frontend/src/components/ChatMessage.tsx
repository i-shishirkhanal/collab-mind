"use client";

import { useChatStore } from "@/lib/store";
import { ChatMessage as ChatMessageType, Citation } from "@/types";
import { citationForMarker } from "@/lib/citations";
import React from "react";

interface ChatMessageProps {
  message: ChatMessageType;
}

const NOT_FOUND_MESSAGE = "I could not find an answer in your workspace sources.";

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";
  const citations = message.metadata?.citations ?? message.citations ?? [];
  const grounding = message.metadata?.grounding ?? null;
  const warnings = message.metadata?.warnings ?? [];
  const setActiveCitation = useChatStore(s => s.setActiveCitation);
  const isUngrounded = !isUser && (
    grounding === 'no_sources' || grounding === 'no_answer' || message.content.trim() === NOT_FOUND_MESSAGE
  );
  // The model's answer used no source passage at all: say so instead of implying it is sourced.
  const isUncited = !isUser && !isUngrounded && grounding === 'uncited';

  // [n] in the text is the passage number the server assigned (citation.index). Only the
  // cited passages are returned, in order of first use, so the array position is NOT n.
  // Messages stored before this field existed fall back to position.
  const citationFor = (n: number): Citation | null => citationForMarker(citations, n);

  // Parse inline citations like [1], [2]
  const parseInlineCitations = (text: string) => {
    const citationRegex = /\[(\d+)\]/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = citationRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }

      const numStr = match[1];
      const citation = citationFor(parseInt(numStr, 10));

      if (citation) {
         parts.push(
          <span 
            key={match.index}
            onClick={() => setActiveCitation(citation)}
            className="inline-flex items-center justify-center px-1.5 mx-0.5 rounded cursor-pointer text-[10px] font-bold bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/40 hover:text-indigo-300 transition-colors align-super border border-indigo-500/20"
          >
            {numStr}
          </span>
        );
      } else {
        parts.push(<span key={match.index} className="text-indigo-400">[{numStr}]</span>);
      }

      lastIndex = citationRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts;
  };

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-6 group`}>
      <div className={`flex gap-4 max-w-[85%] ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>

        {/* Avatar */}
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border-2 shadow-sm ${
          isUser
            ? "bg-slate-700 border-slate-600 text-slate-300" // Note: If we had a user, we'd use their initials, but for now we fallback
            : "bg-teal-500/15 border-teal-500/50 text-teal-400"
        }`}>
          {isUser ? <span className="text-xs font-bold">U</span> : <span className="text-xs font-bold">CM</span>}
        </div>

        {/* Bubble */}
        <div className={`px-5 py-3.5 rounded-2xl shadow-sm text-[15px] leading-relaxed relative ${
          isUser
            ? "bg-slate-700 text-slate-100 rounded-tr-sm"
            : isUngrounded
              ? "bg-slate-800/60 border border-dashed border-slate-600 text-slate-400 rounded-tl-sm italic"
              : "bg-slate-800 border border-slate-700/50 text-slate-200 rounded-tl-sm"
        }`}>
          <div className="whitespace-pre-wrap">
            {isUser ? message.content : parseInlineCitations(message.content)}
          </div>

          {isUncited && (
            <div className="mt-2.5 pt-2.5 border-t border-amber-500/30 text-[11px] text-amber-400/90 not-italic">
              No source passage was cited for this answer. Treat it as unverified.
            </div>
          )}

          {!isUser && warnings.length > 0 && !isUncited && (
            <div className="mt-2 text-[11px] text-amber-400/80 not-italic">{warnings.join(' ')}</div>
          )}

          {!isUser && !isUngrounded && citations.length > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-slate-700/50 flex items-center gap-1.5 text-[11px] text-indigo-400/90 not-italic">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/70" />
              Grounded in {citations.length} source{citations.length > 1 ? "s" : ""}
            </div>
          )}

          <div className={`absolute bottom-0 translate-y-full pt-1 text-[10px] text-slate-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? 'right-1' : 'left-1'}`}>
             {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

      </div>
    </div>
  );
}

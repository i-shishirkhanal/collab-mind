"use client";

import { useChatStore } from "@/lib/store";
import { ChatMessage as ChatMessageType, Citation } from "@/types";
import React from "react";

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";
  const citationsDict = useChatStore(s => s.citations);
  const setActiveCitation = useChatStore(s => s.setActiveCitation);

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
      const index = parseInt(numStr, 10) - 1;
      const citationList = citationsDict[message.id];
      const citation = citationList && citationList[index] ? citationList[index] : null;

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
            : "bg-indigo-900/50 border-indigo-500/50 text-indigo-400"
        }`}>
          {isUser ? <span className="text-xs font-bold">U</span> : <span className="text-xs font-bold">CM</span>}
        </div>

        {/* Bubble */}
        <div className={`px-5 py-3.5 rounded-2xl shadow-sm text-[15px] leading-relaxed relative ${
          isUser 
            ? "bg-slate-700 text-slate-100 rounded-tr-sm" 
            : "bg-slate-800 border border-slate-700/50 text-slate-200 rounded-tl-sm shadow-indigo-500/5"
        }`}>
          <div className="whitespace-pre-wrap">
            {isUser ? message.content : parseInlineCitations(message.content)}
          </div>
          
          <div className={`absolute bottom-0 translate-y-full pt-1 text-[10px] text-slate-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? 'right-1' : 'left-1'}`}>
             {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

      </div>
    </div>
  );
}

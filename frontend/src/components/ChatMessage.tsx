"use client";

import { useChatStore } from "@/lib/store";
import { ChatMessage as ChatMessageType } from "@/types";
import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

interface ChatMessageProps {
  message: ChatMessageType;
  /** The question this answer replied to; lets a refusal offer a one-off general-AI answer. */
  precedingQuestion?: string;
  onAskGeneral?: (question: string) => void;
}

const NOT_FOUND_MESSAGE = "I could not find an answer in your workspace sources.";

export function ChatMessage({ message, precedingQuestion, onAskGeneral }: ChatMessageProps) {
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
  const isGeneral = message.metadata?.mode === 'general' || grounding === 'general';

  const [showSources, setShowSources] = useState(false);

  // Citations stay attached to the message but are not shown inline: the [n] markers the model
  // writes are stripped from the text, and the eye button below reveals what they pointed at.
  const stripMarkers = (text: string) =>
    text.replace(/\s*\[\d+(?:\s*[,;]\s*\d+)*\]/g, "").replace(/ +([.,;:!?])/g, "$1");

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
          {isGeneral && (
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-amber-400 not-italic">
              General AI{isUser ? "" : " · not from your sources"}
            </div>
          )}
          <div className="whitespace-pre-wrap">
            {isUser ? message.content : stripMarkers(message.content)}
          </div>

          {isUngrounded && onAskGeneral && precedingQuestion && (
            <div className="mt-3 pt-3 border-t border-slate-600/50 not-italic">
              <button
                type="button"
                onClick={() => onAskGeneral(precedingQuestion)}
                className="rounded-full border border-indigo-500/40 px-3 py-1 text-xs font-medium text-indigo-400 hover:bg-indigo-500/10 transition-colors"
              >
                Ask general AI this question
              </button>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Answers just this one question outside your uploaded sources.
              </p>
            </div>
          )}

          {isUncited && (
            <div className="mt-2.5 pt-2.5 border-t border-amber-500/30 text-[11px] text-amber-400/90 not-italic">
              No source passage was cited for this answer. Treat it as unverified.
            </div>
          )}

          {!isUser && warnings.length > 0 && !isUncited && (
            <div className="mt-2 text-[11px] text-amber-400/80 not-italic">{warnings.join(' ')}</div>
          )}

          {!isUser && !isUngrounded && citations.length > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-slate-700/50 not-italic">
              <button
                type="button"
                onClick={() => setShowSources(v => !v)}
                aria-expanded={showSources}
                aria-label={showSources ? "Hide sources" : "Show sources"}
                title={showSources ? "Hide sources" : "Show sources"}
                className="flex items-center gap-1.5 text-[11px] text-indigo-400/90 hover:text-indigo-300 transition-colors"
              >
                {showSources ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                {citations.length} source{citations.length > 1 ? "s" : ""}
              </button>
              {showSources && (
                <ul className="mt-2 space-y-1.5">
                  {citations.map((c, i) => (
                    <li key={`${c.source_id ?? c.source_name}-${c.chunk_index}-${i}`}>
                      <button
                        type="button"
                        onClick={() => setActiveCitation(c)}
                        className="w-full text-left rounded-lg bg-slate-900/60 border border-slate-700/50 px-3 py-2 text-xs hover:border-indigo-500/40 transition-colors"
                      >
                        <span className="block font-medium text-slate-200 break-words">{c.source_name}</span>
                        {(c.location_label || c.page_number) && (
                          <span className="block text-[11px] text-slate-400">{c.location_label ?? `Page ${c.page_number}`}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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

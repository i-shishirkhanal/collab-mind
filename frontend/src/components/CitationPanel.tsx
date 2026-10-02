"use client";

import { X } from "lucide-react";
import { Citation } from "@/types";

interface CitationPanelProps {
  citation: Citation | null;
  onClose: () => void;
}

export function CitationPanel({ citation, onClose }: CitationPanelProps) {
  return (
    <div 
      className={`fixed top-0 right-0 h-full w-[320px] bg-slate-900 border-l border-slate-700/60 shadow-2xl z-50 transform transition-transform duration-300 ease-in-out ${
        citation ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {citation && (
        <div className="flex flex-col h-full bg-slate-900 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0 bg-slate-900/80 backdrop-blur-sm">
            <h3 className="font-serif font-semibold text-slate-200">Source</h3>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-5 overflow-y-auto custom-scrollbar flex-1 space-y-6">
            <div>
              <p className="text-xs font-medium text-indigo-400 mb-1.5">Document</p>
              <p className="text-sm font-medium text-slate-200 break-words">{citation.source_name}</p>
            </div>
            {(citation.location_label || citation.page_number) && (
              <div>
                <p className="text-xs font-medium text-indigo-400 mb-1.5">Location</p>
                <div className="inline-flex items-center justify-center bg-slate-800 border border-slate-700 rounded text-slate-300 text-xs px-2 py-1">
                  {citation.location_label ?? `Page ${citation.page_number}`}
                </div>
              </div>
            )}
            {citation.excerpt && (
              <div>
                <p className="text-xs font-medium text-indigo-400 mb-1.5">Excerpt</p>
                 <div className="bg-slate-800/50 border border-slate-700/50 p-4 rounded-xl text-slate-300 text-sm font-serif leading-relaxed relative">
                  <div className="absolute -left-1.5 top-4 bottom-4 w-1 bg-indigo-500/50 rounded-r-full"></div>
                  &ldquo;{citation.excerpt}&rdquo;
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { use, useState } from "react";
import { FlashcardsTool } from "@/components/studio/FlashcardsTool";
import { QuizTool } from "@/components/studio/QuizTool";
import { StudyGuideTool } from "@/components/studio/StudyGuideTool";
import { ReportTool } from "@/components/studio/ReportTool";
import { AgentTool } from "@/components/studio/AgentTool";
import { CopySlash, HelpCircle, BookOpen, FileSignature, Zap } from "lucide-react";

type ToolType = "flashcards" | "quiz" | "guide" | "report" | "agent";

export default function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [activeTool, setActiveTool] = useState<ToolType>("flashcards");


  const tools = [
    { id: "flashcards", label: "Flashcards", icon: CopySlash, desc: "Interactive memory flip-cards" },
    { id: "quiz", label: "Practice Quiz", icon: HelpCircle, desc: "Test your understanding" },
    { id: "guide", label: "Study Guide", icon: BookOpen, desc: "Generate a markdown guide" },
    { id: "report", label: "AI Report Draft", icon: FileSignature, desc: "Exportable markdown report" },
    { id: "agent", label: "Study Coach Agent", icon: Zap, desc: "Autonomous learning planner" },
  ];

  const renderTool = () => {
    switch (activeTool) {
      case "flashcards": return <FlashcardsTool workspaceId={id} />;
      case "quiz": return <QuizTool workspaceId={id} />;
      case "guide": return <StudyGuideTool workspaceId={id} />;
      case "report": return <ReportTool workspaceId={id} />;
      case "agent": return <AgentTool workspaceId={id} />;
      default: return null;
    }
  };

  return (
    <div className="flex flex-col lg:flex-row h-full bg-slate-950 overflow-hidden">
      {/* Studio Sidebar */}
      <div className="w-full lg:w-80 bg-slate-900 border-r border-slate-800/60 flex flex-col shrink-0 lg:h-full z-10 shadow-xl overflow-y-auto">
        <div className="p-6 border-b border-slate-800/60 bg-slate-900/50 sticky top-0 backdrop-blur-md">
          <h1 className="text-xl font-serif font-semibold text-slate-50 tracking-tight">Agent Studio</h1>
          <p className="text-slate-400 mt-1 text-sm">Deploy tools to your workspace sources.</p>
        </div>
        
        <div className="p-4 space-y-2">
          {tools.map(tool => {
            const Icon = tool.icon;
            const isActive = activeTool === tool.id;
            return (
              <button
                key={tool.id}
                onClick={() => setActiveTool(tool.id as ToolType)}
                className={`w-full flex items-start text-left gap-4 p-4 rounded-2xl transition-all group ${
                  isActive 
                    ? "bg-indigo-600/10 border border-indigo-500/30 ring-1 ring-indigo-500/20" 
                    : "bg-slate-800/20 border border-transparent hover:bg-slate-800/50 hover:border-slate-700/50"
                }`}
              >
                <div className={`mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border transition-colors ${
                  isActive 
                    ? "bg-indigo-500 text-white border-indigo-400/50 shadow-md shadow-indigo-500/20" 
                    : "bg-slate-800 text-slate-400 border-slate-700 group-hover:text-indigo-400 group-hover:border-indigo-500/30"
                }`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={`font-semibold ${isActive ? "text-indigo-300" : "text-slate-200 group-hover:text-indigo-300 transition-colors"}`}>
                    {tool.label}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">{tool.desc}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Studio Area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-900/10 via-slate-950 to-slate-950 pointer-events-none" />
        <div className="max-w-5xl mx-auto p-4 md:p-8 relative z-10">
          {renderTool()}
        </div>
      </div>
    </div>
  );
}

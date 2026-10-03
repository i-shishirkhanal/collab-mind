"use client";

import { useState } from "react";
import Link from "next/link";
import { 
  Sparkles, 
  ArrowRight, 
  FileText, 
  Brain, 
  Users,  
  BookOpen, 
  CheckCircle2,  
  Bot,  
  HelpCircle,
  MessageSquare,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Home() {
  const [activeTab, setActiveTab] = useState<"rag" | "studio" | "agent" | "collab">("rag");

  return (
    <div className="min-h-screen bg-transparent text-slate-100 font-sans selection:bg-indigo-500 selection:text-white relative overflow-hidden">
      <div className="watermark" aria-hidden>CollabMind</div>
      {/* Background Decorative Glow Effects */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-gradient-to-b from-indigo-600/20 via-indigo-600/10 to-transparent blur-[140px] pointer-events-none rounded-full" />
      <div className="absolute top-96 left-[-100px] w-[500px] h-[500px] bg-indigo-600/10 blur-[160px] pointer-events-none rounded-full" />
      <div className="absolute bottom-96 right-[-100px] w-[500px] h-[500px] bg-indigo-600/10 blur-[160px] pointer-events-none rounded-full" />

      {/* Grid pattern overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b15_1px,transparent_1px),linear-gradient(to_bottom,#1e293b15_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none" />

      {/* Navigation Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-slate-950/70 border-b border-slate-800/60 transition-all">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-xl group-hover:scale-105 transition-transform shadow-lg shadow-indigo-500/10">
              CM
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-xl tracking-tight text-slate-50 flex items-center gap-2">
                CollabMind <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-semibold">AI</span>
              </span>
            </div>
          </Link>

          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-400">
            <a href="#features" className="hover:text-slate-50 transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-slate-50 transition-colors">How it Works</a>
            <a href="#studio" className="hover:text-slate-50 transition-colors">Studio Tools</a>
            <a href="#faq" className="hover:text-slate-50 transition-colors">FAQ</a>
          </nav>

          <div className="flex items-center gap-4">
            <Link href="/auth/signin">
              <Button variant="ghost" className="text-slate-300 hover:text-slate-50 hover:bg-slate-800">
                Sign In
              </Button>
            </Link>
            <Link href="/auth/signin">
              <Button className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-5 rounded-xl shadow-lg shadow-indigo-600/25 transition-all hover:shadow-indigo-600/40">
                Launch Workspace
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-20 pb-24 md:pt-28 md:pb-36 px-6">
        <div className="max-w-5xl mx-auto text-center space-y-8">
          
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-950/60 border border-indigo-800/50 text-indigo-300 text-xs font-semibold backdrop-blur-md shadow-inner">
            <Sparkles className="w-3.5 h-3.5" />
            <span>CollabMind AI 2.0 — built for teams, grounded in your sources</span>
          </div>

          {/* Main Heading */}
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-serif font-semibold tracking-tight text-slate-50 leading-[1.1]">
            Turn raw documents into workspaces your whole team can reason with
          </h1>

          {/* Subheading */}
          <p className="text-lg md:text-xl text-slate-400 max-w-3xl mx-auto font-normal leading-relaxed">
            Upload PDFs, notes, and web links. CollabMind automatically indexes your knowledge base, generates custom flashcards, quizzes & study guides, and deploys autonomous AI agents for your team.
          </p>

          {/* Call to Actions */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Link href="/auth/signin" className="w-full sm:w-auto">
              <Button size="lg" className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 text-white font-semibold h-13 px-8 rounded-2xl shadow-xl shadow-indigo-600/30 text-base transition-all hover:scale-[1.02]">
                Start Building Free
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </Link>
            <a href="#how-it-works" className="w-full sm:w-auto">
              <Button size="lg" variant="outline" className="w-full sm:w-auto border-slate-800 bg-slate-900/60 hover:bg-slate-800 text-slate-300 hover:text-slate-50 h-13 px-8 rounded-2xl text-base transition-all backdrop-blur-md">
                Explore Demo Workflow
              </Button>
            </a>
          </div>

          {/* Feature Highlights Pill Bar */}
          <div className="pt-8 flex flex-wrap justify-center items-center gap-6 text-xs text-slate-400 font-medium">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Grounded RAG Citations
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Vector Search via pgvector
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Human-in-the-Loop AI Agents
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Real-Time Socket Presence
            </span>
          </div>

        </div>

        {/* Hero Interactive UI Preview Mockup */}
        <div className="max-w-6xl mx-auto mt-16 relative">
          <div className="rounded-3xl border border-slate-800/80 bg-slate-900/80 backdrop-blur-2xl p-4 md:p-6 shadow-2xl shadow-indigo-950/40 relative overflow-hidden">
            
            {/* Top Bar Mockup Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-800/80 mb-6">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80" />
                <div className="w-3 h-3 rounded-full bg-amber-500/80" />
                <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
                <span className="ml-4 text-xs font-mono text-slate-500">workspace / system-architecture-qa</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                  ● 4 Members Online
                </span>
              </div>
            </div>

            {/* Content Mockup Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              
              {/* Left Column: Indexed Sources */}
              <div className="bg-slate-950/70 rounded-2xl p-4 border border-slate-800/60 space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
                  <span className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-indigo-400" /> Knowledge Sources
                  </span>
                  <span className="text-indigo-400">3 Indexed</span>
                </div>
                
                <div className="space-y-2">
                  <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs flex items-center justify-between">
                    <div className="truncate">
                      <p className="text-slate-50 font-medium truncate">Architecture_Spec_v2.pdf</p>
                      <p className="text-slate-500 text-[10px]">14 chunks • Vector embeddings synced</p>
                    </div>
                    <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-1.5 py-0.5 rounded">RAG</span>
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs flex items-center justify-between">
                    <div className="truncate">
                      <p className="text-slate-50 font-medium truncate">Postgres_pgvector_Guide.md</p>
                      <p className="text-slate-500 text-[10px]">8 chunks • Cosine similarity index</p>
                    </div>
                    <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-1.5 py-0.5 rounded">RAG</span>
                  </div>
                </div>
              </div>

              {/* Middle Column: Chat & RAG Output */}
              <div className="bg-slate-950/70 rounded-2xl p-4 border border-slate-800/60 flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
                    <span className="flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-indigo-400" /> AI Grounded Chat
                    </span>
                    <span className="text-xs text-slate-500">Gemini 1.5 Flash</span>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="bg-slate-900 p-3 rounded-xl text-slate-300 border border-slate-800">
                      <p className="font-semibold text-indigo-300 mb-1">User Inquiry:</p>
                      How does our pgvector HNSW index accelerate vector similarity search?
                    </div>

                    <div className="bg-indigo-950/40 p-3 rounded-xl text-slate-200 border border-indigo-900/60 space-y-1.5">
                      <p className="font-semibold text-emerald-400 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5" /> Answer with Citations:
                      </p>
                      <p className="text-[11px] leading-relaxed text-slate-300">
                        HNSW creates multi-layer graphs allowing logarithmic query time without scanning full embeddings table.
                      </p>
                      <span className="inline-block text-[10px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded border border-indigo-500/30">
                        Source: Postgres_pgvector_Guide.md (Chunk #3)
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column: Studio Tools Output */}
              <div className="bg-slate-950/70 rounded-2xl p-4 border border-slate-800/60 space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
                  <span className="flex items-center gap-2">
                    <Brain className="w-4 h-4 text-teal-400" /> Generated Studio Artifacts
                  </span>
                  <span className="text-xs text-amber-400 font-mono">10 Flashcards</span>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-xl space-y-2 relative overflow-hidden group">
                  <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
                    <span>FLASHCARD #1</span>
                    <span className="text-indigo-400">Click to Flip</span>
                  </div>
                  <p className="text-xs text-slate-50 font-medium">What is the primary benefit of HNSW index over IVFFlat in pgvector?</p>
                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                    Answer: Higher recall performance on high-dimensional vectors without full table scans.
                  </p>
                </div>
              </div>

            </div>
          </div>
        </div>
      </section>

      {/* Live Interactive Workflow Showcase */}
      <section id="how-it-works" className="py-24 px-6 border-t border-slate-800/60 bg-slate-950/80">
        <div className="max-w-6xl mx-auto space-y-12">
          
          <div className="text-center space-y-4 max-w-2xl mx-auto">
            <h3 className="text-3xl md:text-4xl font-serif font-semibold text-slate-50 tracking-tight">
              One workspace for your entire research lifecycle
            </h3>
            <p className="text-slate-400 text-sm">
              Explore how CollabMind connects document indexing, AI generation, and autonomous agents in real time.
            </p>
          </div>

          {/* Interactive Tabs */}
          <div className="flex flex-wrap justify-center gap-3">
            {[
              { id: "rag", label: "1. Grounded RAG Search", icon: Search },
              { id: "studio", label: "2. Studio Study Generators", icon: BookOpen },
              { id: "agent", label: "3. LangGraph Autonomous Agent", icon: Bot },
              { id: "collab", label: "4. Real-Time Team Sync", icon: Users },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`flex items-center gap-2.5 px-5 py-3 rounded-xl text-sm font-semibold transition-all border ${
                  activeTab === tab.id
                    ? "bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/25"
                    : "bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-50 hover:bg-slate-800"
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Display Panel */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 md:p-12 shadow-2xl relative">
            {activeTab === "rag" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                <div className="space-y-4">
                  <span className="text-xs font-mono text-indigo-400 bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20">
                    pgvector + Gemini RAG
                  </span>
                  <h4 className="text-2xl font-bold text-slate-50">Semantic Search with Source Grounding</h4>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Upload documents or web links. CollabMind chunks files, generates vector embeddings, and stores them in PostgreSQL with pgvector for instant vector similarity retrieval. Every AI response includes exact file citations.
                  </p>
                  <ul className="space-y-2 text-xs text-slate-300">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Supports PDF, DOCX, TXT, and Web URLs
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Cosine similarity & HNSW vector indexing
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Zero hallucination with strict context bounds
                    </li>
                  </ul>
                </div>
                <div className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-4 font-mono text-xs">
                  <div className="flex items-center justify-between text-slate-500 border-b border-slate-800 pb-2">
                    <span>Query execution</span>
                    <span className="text-emerald-400">24ms</span>
                  </div>
                  <div className="text-indigo-300">
                    &gt; SELECT content, cosine_distance FROM source_chunks WHERE workspace_id = $1 ORDER BY distance LIMIT 5;
                  </div>
                  <div className="p-3 bg-slate-900 rounded-xl text-slate-300 border border-slate-800 text-[11px]">
                    <span className="text-amber-400 font-semibold block mb-1">[Match 0.94] System_Architecture.pdf:</span>
                    &ldquo;The API gateway proxies all websocket events to Redis PubSub for horizontal scalability across clusters.&rdquo;
                  </div>
                </div>
              </div>
            )}

            {activeTab === "studio" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                <div className="space-y-4">
                  <span className="text-xs font-mono text-teal-400 bg-teal-500/10 px-3 py-1 rounded-full border border-teal-500/20">
                    Automated Study Artifacts
                  </span>
                  <h4 className="text-2xl font-bold text-slate-50">Generate Quizzes, Flashcards & Study Guides</h4>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Transform long technical documentation into active recall flashcards, multiple-choice quizzes with explanations, structured study guides, and comprehensive markdown research reports in seconds.
                  </p>
                  <ul className="space-y-2 text-xs text-slate-300">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Interactive double-sided flip flashcards
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Graded quizzes with instant answer feedback
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Exportable Markdown research reports
                    </li>
                  </ul>
                </div>
                <div className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-3">
                  <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl text-xs space-y-2">
                    <span className="text-indigo-400 font-mono font-semibold">MULTIPLE CHOICE QUIZ</span>
                    <p className="text-slate-50 font-medium">Which protocol guarantees real-time broadcast across workspace members?</p>
                    <div className="space-y-1.5 text-slate-300 pt-1">
                      <div className="p-2 rounded bg-indigo-600/20 border border-indigo-500/40 text-indigo-200">A) WebSockets + Redis PubSub (Correct)</div>
                      <div className="p-2 rounded bg-slate-800/60 text-slate-400">B) HTTP Long Polling</div>
                      <div className="p-2 rounded bg-slate-800/60 text-slate-400">C) FTP File Streaming</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "agent" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                <div className="space-y-4">
                  <span className="text-xs font-mono text-indigo-400 bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20">
                    LangGraph Agent Architecture
                  </span>
                  <h4 className="text-2xl font-bold text-slate-50">Study Coach Agent with Human Approval</h4>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Set a learning or research goal. The autonomous Study Coach agent analyzes workspace context, drafts a multi-day study plan, requests human approval, and generates complete study packages.
                  </p>
                  <ul className="space-y-2 text-xs text-slate-300">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> State-graph execution via LangGraph
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Human-in-the-loop review & approval gate
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Real-time progress updates via Socket.IO
                    </li>
                  </ul>
                </div>
                <div className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-3 font-mono text-xs">
                  <div className="flex items-center gap-2 text-indigo-400 font-semibold border-b border-slate-800 pb-2">
                    <Bot className="w-4 h-4" /> Agent Graph Pipeline
                  </div>
                  <div className="space-y-2 text-[11px]">
                    <div className="p-2 bg-slate-900 rounded border border-slate-800 text-slate-300">1. analyze_sources() → Extracted 4 core topics</div>
                    <div className="p-2 bg-slate-900 rounded border border-slate-800 text-slate-300">2. create_plan() → Drafted 3-day study schedule</div>
                    <div className="p-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded flex items-center justify-between">
                      <span>3. human_approval_gate</span>
                      <span className="bg-amber-500 text-slate-950 px-2 py-0.5 rounded font-bold">APPROVED</span>
                    </div>
                    <div className="p-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 rounded">4. generate_materials() → Materials package saved</div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "collab" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                <div className="space-y-4">
                  <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20">
                    Real-Time WebSockets
                  </span>
                  <h4 className="text-2xl font-bold text-slate-50">Live Presence & Instant Workspace Sync</h4>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Collaborate seamlessly with team members. See live online presence indicators, instant workspace chat messages, and live generation updates as team members upload or query documents.
                  </p>
                  <ul className="space-y-2 text-xs text-slate-300">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Socket.IO client-server synchronization
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Redis PubSub backend event bus
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Live user status & team activity indicators
                    </li>
                  </ul>
                </div>
                <div className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-400 border-b border-slate-800 pb-2 font-mono">
                    <span>ONLINE MEMBERS (3)</span>
                    <span className="text-emerald-400 font-semibold">● Connected</span>
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between p-2 rounded bg-slate-900 border border-slate-800">
                      <span className="text-slate-50 font-medium">Alex Rivera (Lead Engineer)</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                    <div className="flex items-center justify-between p-2 rounded bg-slate-900 border border-slate-800">
                      <span className="text-slate-50 font-medium">Sarah Chen (Researcher)</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>
      </section>

      {/* Feature Grid Section */}
      <section id="features" className="py-24 px-6 relative">
        <div className="max-w-6xl mx-auto space-y-16">
          
          <div className="text-center space-y-4 max-w-2xl mx-auto">
            <h3 className="text-3xl md:text-5xl font-serif font-semibold text-slate-50 tracking-tight">
              Engineered for speed, precision and scale
            </h3>
            <p className="text-slate-400 text-sm">
              Built with Next.js 16, Node.js microservices, PostgreSQL pgvector, FastAPI, and Gemini 1.5 models.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-slate-900/60 border border-slate-800 hover:border-indigo-500/40 p-8 rounded-3xl space-y-4 transition-all hover:-translate-y-1">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                <FileText className="w-6 h-6" />
              </div>
              <h4 className="text-xl font-semibold text-slate-50">RAG Document Pipeline</h4>
              <p className="text-slate-400 text-sm leading-relaxed">
                Automatic PDF/Doc text extraction, recursive chunking, and vector embedding indexing using pgvector.
              </p>
            </div>

            <div className="bg-slate-900/60 border border-slate-800 hover:border-indigo-500/40 p-8 rounded-3xl space-y-4 transition-all hover:-translate-y-1">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                <Brain className="w-6 h-6" />
              </div>
              <h4 className="text-xl font-semibold text-slate-50">AI Studio Generator</h4>
              <p className="text-slate-400 text-sm leading-relaxed">
                Generate interactive flashcards, practice quizzes with explanations, study guides, and comprehensive markdown reports.
              </p>
            </div>

            <div className="bg-slate-900/60 border border-slate-800 hover:border-teal-500/40 p-8 rounded-3xl space-y-4 transition-all hover:-translate-y-1">
              <div className="w-12 h-12 rounded-2xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center text-teal-400">
                <Bot className="w-6 h-6" />
              </div>
              <h4 className="text-xl font-semibold text-slate-50">LangGraph AI Agent</h4>
              <p className="text-slate-400 text-sm leading-relaxed">
                Autonomous study coach that builds learning paths, waits for human approval, and generates comprehensive study packages.
              </p>
            </div>
          </div>

        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="py-24 px-6 border-t border-slate-800/60 bg-slate-950/80">
        <div className="max-w-4xl mx-auto space-y-12">
          <div className="text-center space-y-3">
            <h3 className="text-3xl font-serif font-semibold text-slate-50 tracking-tight">Frequently asked questions</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-2">
              <h4 className="text-slate-50 font-semibold text-base flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-indigo-400 shrink-0" />
                What document formats are supported?
              </h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                CollabMind supports PDFs, Word documents (.docx), text files (.txt, .md), and public web page URLs.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-2">
              <h4 className="text-slate-50 font-semibold text-base flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-indigo-400 shrink-0" />
                How are citations verified?
              </h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                All AI responses are generated strictly using vector search context retrieved from your workspace sources with explicit source filename references.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-2">
              <h4 className="text-slate-50 font-semibold text-base flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-indigo-400 shrink-0" />
                How does human-in-the-loop work?
              </h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                The Study Coach AI Agent generates a plan and pauses at an approval gate. You can inspect and approve the plan before material generation proceeds.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-2">
              <h4 className="text-slate-50 font-semibold text-base flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-indigo-400 shrink-0" />
                Can I run CollabMind locally or with Docker?
              </h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                Yes! CollabMind includes `docker-compose.yml` orchestrating Next.js, Node.js Express backend, FastAPI AI service, PostgreSQL pgvector, and Redis.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* High-Impact Bottom Call to Action (CTA) Banner */}
      <section className="py-20 px-6 relative">
        <div className="max-w-5xl mx-auto rounded-3xl bg-gradient-to-br from-indigo-900/60 to-slate-900 border border-indigo-500/30 p-10 md:p-16 text-center space-y-6 shadow-2xl relative overflow-hidden">
          <div className="absolute -right-20 -bottom-20 w-80 h-80 bg-indigo-500/20 blur-[100px] rounded-full pointer-events-none" />
          
          <h3 className="text-3xl md:text-5xl font-extrabold text-slate-50 tracking-tight">
            Ready to Supercharge Your Research & Study Workflows?
          </h3>
          <p className="text-slate-300 text-sm md:text-base max-w-2xl mx-auto">
            Join researchers, engineers, and students building intelligent team knowledge hubs with CollabMind AI.
          </p>

          <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/auth/signin" className="w-full sm:w-auto">
              <Button size="lg" className="w-full sm:w-auto bg-white hover:bg-slate-100 text-slate-950 font-bold h-13 px-8 rounded-2xl shadow-xl text-base transition-all hover:scale-[1.02]">
                Get Started Free Now
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-slate-900 bg-slate-950 text-slate-500 text-xs">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-xs">
              CM
            </div>
            <span className="text-slate-300 font-semibold text-sm">CollabMind AI</span>
          </div>

          <p>© {new Date().getFullYear()} CollabMind AI. Built with Next.js, FastAPI, pgvector, and Gemini.</p>

          <div className="flex items-center gap-6">
            <Link href="/auth/signin" className="hover:text-slate-300 transition-colors">Sign In</Link>
            <Link href="/dashboard" className="hover:text-slate-300 transition-colors">Dashboard</Link>
          </div>
        </div>
      </footer>

    </div>
  );
}

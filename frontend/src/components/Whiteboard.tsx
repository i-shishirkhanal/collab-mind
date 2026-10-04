"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Circle, Download, Eraser, Minus, Pencil, Redo2, Square, Trash2, Type, Undo2, Users } from "lucide-react";
import { useSocketContext } from "@/hooks/SocketProvider";

type Tool = "pen" | "eraser" | "line" | "rect" | "ellipse" | "text";
type Point = [number, number];

interface Stroke {
  id: string;
  userId?: string;
  tool: Tool;
  color: string;
  size: number;
  points: Point[];
  text?: string;
}

// Logical board size; the canvas is scaled by CSS to fit its container.
const BOARD_W = 1600;
const BOARD_H = 900;
const COLORS = ["#111827", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];
const TOOLS: { id: Tool; label: string; icon: typeof Pencil }[] = [
  { id: "pen", label: "Pen", icon: Pencil },
  { id: "eraser", label: "Eraser", icon: Eraser },
  { id: "line", label: "Line", icon: Minus },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "text", label: "Text", icon: Type },
];

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = s.size;
  ctx.strokeStyle = s.tool === "eraser" ? "#ffffff" : s.color;
  ctx.fillStyle = s.color;
  const [x0, y0] = pts[0];
  const [x1, y1] = pts[pts.length - 1];

  if (s.tool === "pen" || s.tool === "eraser") {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    if (pts.length === 1) ctx.lineTo(x0 + 0.01, y0);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  } else if (s.tool === "line") {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  } else if (s.tool === "rect") {
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (s.tool === "ellipse") {
    ctx.beginPath();
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.tool === "text" && s.text) {
    const px = Math.max(s.size * 5, 14);
    ctx.font = `${px}px sans-serif`;
    ctx.textBaseline = "top";
    s.text.split("\n").forEach((line, i) => ctx.fillText(line, x0, y0 + i * px * 1.2));
  }
  ctx.restore();
}

export function Whiteboard({ workspaceId }: { workspaceId: string }) {
  const { socket } = useSocketContext();
  const { data: session } = useSession();
  const myId = session?.user?.id;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const draftRef = useRef<Stroke | null>(null);
  const redoRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);

  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(4);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
    strokesRef.current.forEach((s) => drawStroke(ctx, s));
    if (draftRef.current) drawStroke(ctx, draftRef.current);
  }, []);

  useEffect(() => {
    render();
  }, [render]);

  // Realtime wiring
  useEffect(() => {
    if (!socket) return;
    const onState = ({ strokes }: { strokes: Stroke[] }) => {
      strokesRef.current = strokes;
      setLoaded(true);
      render();
    };
    const onStroke = (s: Stroke) => {
      if (strokesRef.current.some((x) => x.id === s.id)) return;
      strokesRef.current = [...strokesRef.current, s];
      render();
    };
    const onRemove = ({ id }: { id: string }) => {
      strokesRef.current = strokesRef.current.filter((s) => s.id !== id);
      render();
    };
    const onClear = ({ by }: { by?: string }) => {
      strokesRef.current = [];
      redoRef.current = [];
      setNotice(`${by || "A teammate"} cleared the board`);
      setTimeout(() => setNotice(null), 3000);
      render();
    };
    // The server only accepts whiteboard events after the workspace room is joined.
    const load = () => socket.emit("whiteboard:load");

    socket.on("whiteboard:state", onState);
    socket.on("whiteboard:stroke", onStroke);
    socket.on("whiteboard:remove", onRemove);
    socket.on("whiteboard:clear", onClear);
    socket.on("workspace:joined", load);
    return () => {
      socket.off("whiteboard:state", onState);
      socket.off("whiteboard:stroke", onStroke);
      socket.off("whiteboard:remove", onRemove);
      socket.off("whiteboard:clear", onClear);
      socket.off("workspace:joined", load);
    };
  }, [socket, render]);

  // The layout's socket may already be joined by the time this page mounts.
  useEffect(() => {
    if (socket?.connected) socket.emit("whiteboard:load");
  }, [socket]);

  const commit = (stroke: Stroke) => {
    strokesRef.current = [...strokesRef.current, stroke];
    redoRef.current = [];
    socket?.emit("whiteboard:stroke", stroke);
    render();
  };

  const toBoard = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * BOARD_W, ((e.clientY - rect.top) / rect.height) * BOARD_H];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const p = toBoard(e);
    if (tool === "text") {
      const text = window.prompt("Text to add");
      if (text?.trim()) commit({ id: newId(), userId: myId, tool, color, size, points: [p], text: text.trim() });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    draftRef.current = { id: newId(), userId: myId, tool, color, size: tool === "eraser" ? size * 4 : size, points: [p] };
    render();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = draftRef.current;
    if (!drawingRef.current || !d) return;
    const p = toBoard(e);
    if (d.tool === "pen" || d.tool === "eraser") {
      if (d.points.length < 2000) d.points.push(p);
    } else {
      d.points = [d.points[0], p];
    }
    render();
  };

  const finish = () => {
    const d = draftRef.current;
    drawingRef.current = false;
    draftRef.current = null;
    if (d) commit(d);
    else render();
  };

  const undo = () => {
    const mine = [...strokesRef.current].reverse().find((s) => s.userId === myId);
    if (!mine) return;
    strokesRef.current = strokesRef.current.filter((s) => s.id !== mine.id);
    redoRef.current.push(mine);
    socket?.emit("whiteboard:remove", { id: mine.id });
    render();
  };

  const redo = () => {
    const s = redoRef.current.pop();
    if (!s) return;
    strokesRef.current = [...strokesRef.current, s];
    socket?.emit("whiteboard:stroke", s);
    render();
  };

  const clearBoard = () => {
    if (!window.confirm("Clear the whiteboard for everyone?")) return;
    strokesRef.current = [];
    redoRef.current = [];
    socket?.emit("whiteboard:clear");
    render();
  };

  const download = () => {
    const url = canvasRef.current?.toDataURL("image/png");
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = "whiteboard.png";
    a.click();
  };

  const btn = "size-9 rounded-full flex items-center justify-center transition-colors";

  return (
    <div className="flex-1 flex flex-col min-h-0 p-4 gap-3" data-workspace={workspaceId}>
      <div className="flex flex-wrap items-center gap-2 bg-white rounded-full px-3 py-2 shadow">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            title={t.label}
            onClick={() => setTool(t.id)}
            className={`${btn} ${tool === t.id ? "bg-indigo-600 text-white" : "text-slate-500 hover:bg-slate-100"}`}
          >
            <t.icon className="w-4 h-4" />
          </button>
        ))}
        <span className="w-px h-6 bg-slate-200 mx-1" />
        {COLORS.map((c) => (
          <button
            key={c}
            title={c}
            onClick={() => {
              setColor(c);
              if (tool === "eraser") setTool("pen");
            }}
            style={{ backgroundColor: c }}
            className={`size-6 rounded-full border-2 ${color === c ? "border-indigo-500 scale-110" : "border-white ring-1 ring-slate-200"}`}
          />
        ))}
        <span className="w-px h-6 bg-slate-200 mx-1" />
        <input
          type="range"
          min={1}
          max={24}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="w-24 accent-indigo-600"
          title={`Size ${size}`}
        />
        <span className="w-px h-6 bg-slate-200 mx-1" />
        <button title="Undo my last stroke" onClick={undo} className={`${btn} text-slate-500 hover:bg-slate-100`}>
          <Undo2 className="w-4 h-4" />
        </button>
        <button title="Redo" onClick={redo} className={`${btn} text-slate-500 hover:bg-slate-100`}>
          <Redo2 className="w-4 h-4" />
        </button>
        <button title="Download PNG" onClick={download} className={`${btn} text-slate-500 hover:bg-slate-100`}>
          <Download className="w-4 h-4" />
        </button>
        <button title="Clear board for everyone" onClick={clearBoard} className={`${btn} text-red-500 hover:bg-red-50`}>
          <Trash2 className="w-4 h-4" />
        </button>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 pr-2">
          <Users className="w-3 h-3" />
          {loaded ? "Live — shared with your group" : "Connecting…"}
        </span>
      </div>

      {notice && <div className="text-xs text-amber-400 px-2">{notice}</div>}

      <div className="flex-1 min-h-0 flex items-center justify-center">
        <canvas
          ref={canvasRef}
          width={BOARD_W}
          height={BOARD_H}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          className="bg-white rounded-2xl shadow-lg max-w-full max-h-full cursor-crosshair touch-none"
          style={{ aspectRatio: `${BOARD_W} / ${BOARD_H}` }}
        />
      </div>
    </div>
  );
}

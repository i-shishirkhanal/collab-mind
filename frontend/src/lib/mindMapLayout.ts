import type { MindMapNode } from "@/lib/api";

/** Same shape as the whiteboard's Stroke minus ids/user, which the caller adds. */
export interface PlannedStroke {
  tool: "rect" | "line" | "text";
  color: string;
  size: number;
  points: [number, number][];
  text?: string;
}

const BRANCH_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#ef4444"];
const INK = "#111827";
const TEXT_SIZE = 3; // the board renders text at max(size * 5, 14) px => 15px
const CHAR_W = 8.6;
const LINE_H = 18;
const PAD = 12;
const COL_W = 380;
const WRAP_AT = 24;

const wrap = (label: string, allowWrap: boolean): string[] => {
  if (!allowWrap) return [label.length > 30 ? `${label.slice(0, 29)}…` : label];
  const lines: string[] = [];
  let cur = "";
  for (const word of label.split(" ")) {
    if (cur && (cur + " " + word).length > WRAP_AT) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
};

/**
 * Left-to-right tidy tree: the root on the left, one column per level, leaves spread evenly down the
 * board. The model only supplies structure; every coordinate is decided here.
 */
export function planMindMap(title: string, nodes: MindMapNode[], boardW: number, boardH: number): PlannedStroke[] {
  const children = new Map<string, MindMapNode[]>();
  for (const n of nodes) {
    if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  }
  const root = nodes.find((n) => !n.parent);
  if (!root) return [];

  const top = 70;
  const leafCount = (n: MindMapNode): number => {
    const kids = children.get(n.id) ?? [];
    return kids.length ? kids.reduce((s, k) => s + leafCount(k), 0) : 1;
  };
  const rowH = Math.min(80, (boardH - top - 20) / leafCount(root));
  const roomy = rowH >= 54;

  const out: PlannedStroke[] = [{ tool: "text", color: INK, size: 5, points: [[40, 20]], text: title }];
  let nextLeaf = 0;

  const place = (n: MindMapNode, depth: number, color: string): { x: number; y: number; w: number; h: number } => {
    const kids = children.get(n.id) ?? [];
    const lines = wrap(n.label, roomy);
    const w = Math.max(...lines.map((l) => l.length)) * CHAR_W + PAD * 2;
    const h = lines.length * LINE_H + PAD;
    const x = 40 + depth * COL_W;
    let cy: number;
    const placed = kids.map((k, i) => place(k, depth + 1, depth === 0 ? BRANCH_COLORS[i % BRANCH_COLORS.length] : color));
    if (placed.length) {
      cy = (placed[0].y + placed[placed.length - 1].y) / 2;
    } else {
      cy = top + (nextLeaf + 0.5) * rowH;
      nextLeaf += 1;
    }
    const box = { x, y: cy, w, h };
    // Edges are queued before the box so they sit underneath it.
    for (const c of placed) out.push({ tool: "line", color, size: 2, points: [[x + w, cy], [c.x, c.y]] });
    out.push({ tool: "rect", color, size: depth === 0 ? 4 : 2, points: [[x, cy - h / 2], [x + w, cy + h / 2]] });
    out.push({
      tool: "text", color: INK, size: TEXT_SIZE,
      points: [[x + PAD, cy - h / 2 + PAD / 2]], text: lines.join("\n"),
    });
    return box;
  };

  place(root, 0, BRANCH_COLORS[0]);
  return out.filter((s) => s.points.every(([px, py]) => px >= 0 && px <= boardW && py >= 0 && py <= boardH));
}

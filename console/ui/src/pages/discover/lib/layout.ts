/**
 * pg_genin Discover: places the servers on a canvas.
 *  - a physical cluster (primary + its streaming standbys) is one frame; the primary on top, standbys below
 *    their upstream (cascading standbys one level lower);
 *  - clusters that receive data by logical replication sit to the right of the ones that send it.
 */
import { DEdge, DGroup, DNode } from '@shared/api/api/discover.ts';

export const BOX = { w: 232, h: 104 };
const GAP_X = 28; // between boxes in a row
const GAP_Y = 64; // between levels (room for the streaming label)
const PAD = 18;
const HEAD = 34; // frame title
const COL_GAP = 170; // between columns (room for the logical label)
const ROW_GAP = 40;

export type Box = { x: number; y: number; w: number; h: number };
export type Frame = Box & { group: DGroup; framed: boolean };
export type Path = { edge: DEdge; d: string; lx: number; ly: number };
export type Layout = { width: number; height: number; boxes: Record<string, Box>; frames: Frame[]; paths: Path[] };

const bezier = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;

export const layout = (nodes: DNode[], edges: DEdge[], groups: DGroup[]): Layout => {
  const groupOf: Record<string, string> = {};
  nodes.forEach((n) => (groupOf[n.id] = n.group ?? n.id));
  const gs: DGroup[] = groups.length
    ? groups
    : nodes.map((n) => ({ id: n.id, system_id: '', name: n.name ?? n.id, members: [n.id], ha: '' }));

  // 1. column of every group: how many logical hops from a group that only sends
  const col: Record<string, number> = {};
  gs.forEach((g) => (col[g.id] = 0));
  const logical = edges.filter((e) => e.kind === 'logical' && groupOf[e.from] !== groupOf[e.to]);
  for (let i = 0; i < gs.length; i++) {
    let changed = false;
    logical.forEach((e) => {
      const a = groupOf[e.from];
      const b = groupOf[e.to];
      if (col[b] < col[a] + 1 && col[a] + 1 < gs.length) {
        col[b] = col[a] + 1;
        changed = true;
      }
    });
    if (!changed) break;
  }

  // 2. inside a group: levels of the streaming tree
  const streaming = edges.filter((e) => e.kind === 'streaming');
  const inner: Record<string, { rows: string[][]; w: number; h: number }> = {};
  gs.forEach((g) => {
    const members = new Set(g.members);
    const parent: Record<string, string> = {};
    streaming.forEach((e) => {
      if (members.has(e.from) && members.has(e.to)) parent[e.to] = e.from;
    });
    const level: Record<string, number> = {};
    const depth = (id: string, seen = new Set<string>()): number => {
      if (level[id] !== undefined) return level[id];
      if (!parent[id] || seen.has(id)) return 0;
      seen.add(id);
      return depth(parent[id], seen) + 1;
    };
    g.members.forEach((id) => (level[id] = depth(id)));
    const rows: string[][] = [];
    // primary first, then children in the order of their parents
    const ordered = [...g.members].sort(
      (a, b) => level[a] - level[b] || (a === g.primary ? -1 : b === g.primary ? 1 : 0),
    );
    ordered.forEach((id) => (rows[level[id]] ??= []).push(id));
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1] ?? [];
      rows[i]?.sort((a, b) => prev.indexOf(parent[a]) - prev.indexOf(parent[b]));
    }
    const filled = rows.filter(Boolean);
    const cols = Math.max(1, ...filled.map((r) => r.length));
    inner[g.id] = {
      rows: filled,
      w: cols * BOX.w + (cols - 1) * GAP_X,
      h: filled.length * BOX.h + (filled.length - 1) * GAP_Y,
    };
  });

  // 3. place frames: columns left to right, groups stacked in a column (bigger first)
  const byCol: Record<number, DGroup[]> = {};
  gs.forEach((g) => (byCol[col[g.id]] ??= []).push(g));
  const colKeys = Object.keys(byCol)
    .map(Number)
    .sort((a, b) => a - b);
  const frames: Frame[] = [];
  const boxes: Record<string, Box> = {};
  let x = 0;
  let height = 0;
  colKeys.forEach((c) => {
    const list = byCol[c].sort((a, b) => b.members.length - a.members.length);
    let y = 0;
    let colW = 0;
    list.forEach((g) => {
      // a frame is a real cluster we could read; a lone unreachable or outside server stands on its own
      const framed = g.members.some((id) => {
        const n = nodes.find((x) => x.id === id);
        return n && n.reachable && !n.external;
      });
      const box = inner[g.id];
      const fw = box.w + (framed ? 2 * PAD : 0);
      const fh = box.h + (framed ? PAD + HEAD : 0);
      frames.push({ group: g, framed, x, y, w: fw, h: fh });
      box.rows.forEach((row, li) => {
        const rowW = row.length * BOX.w + (row.length - 1) * GAP_X;
        const x0 = x + (fw - rowW) / 2;
        const y0 = y + (framed ? HEAD : 0) + li * (BOX.h + GAP_Y);
        row.forEach((id, i) => (boxes[id] = { x: x0 + i * (BOX.w + GAP_X), y: y0, w: BOX.w, h: BOX.h }));
      });
      y += fh + ROW_GAP;
      colW = Math.max(colW, fw);
    });
    height = Math.max(height, y - ROW_GAP);
    x += colW + COL_GAP;
  });
  const width = Math.max(BOX.w, x - COL_GAP);

  // 4. arrows
  const paths: Path[] = [];
  edges.forEach((e) => {
    const a = boxes[e.from];
    const b = boxes[e.to];
    if (!a || !b) return;
    let p: number[];
    if (e.kind === 'streaming' && b.y > a.y) {
      p = [
        a.x + a.w / 2,
        a.y + a.h,
        a.x + a.w / 2,
        a.y + a.h + GAP_Y / 2,
        b.x + b.w / 2,
        b.y - GAP_Y / 2,
        b.x + b.w / 2,
        b.y,
      ];
    } else if (b.x > a.x + a.w) {
      const dx = (b.x - a.x - a.w) / 2;
      p = [a.x + a.w, a.y + a.h / 2, a.x + a.w + dx, a.y + a.h / 2, b.x - dx, b.y + b.h / 2, b.x, b.y + b.h / 2];
    } else {
      // same column: loop out to the right
      p = [
        a.x + a.w,
        a.y + a.h / 2,
        a.x + a.w + 90,
        a.y + a.h / 2,
        b.x + b.w + 90,
        b.y + b.h / 2,
        b.x + b.w,
        b.y + b.h / 2,
      ];
    }
    const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
    paths.push({
      edge: e,
      d: `M${x0},${y0} C${x1},${y1} ${x2},${y2} ${x3},${y3}`,
      lx: bezier(x0, x1, x2, x3, 0.5),
      ly: bezier(y0, y1, y2, y3, 0.5),
    });
  });
  return { width: width + 120, height: height + 20, boxes, frames, paths };
};

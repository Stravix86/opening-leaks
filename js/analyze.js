// Turns a list of Lichess games into opening statistics and "leak" spots.
//
// Every game is scored against what the ratings predicted (the Elo expected score),
// so a 50% score against much stronger players is fine and a 50% score against much
// weaker players is a leak. "Points lost" = expected score - actual score, summed.

import { Chess } from '../vendor/chess.js';

let openingNames = null;
export async function loadOpeningNames() {
  if (!openingNames) openingNames = fetch('vendor/openings.json').then((r) => r.json()).catch(() => ({}));
  return openingNames;
}

export const posKey = (fen) => fen.split(' ').slice(0, 3).join(' ');
export const expected = (me, opp) => 1 / (1 + Math.pow(10, (opp - me) / 400));

const SKIP_STATUS = new Set(['aborted', 'noStart', 'unknownFinish', 'created', 'started', 'cheat']);

/** Reduces a raw Lichess game to what the analysis needs, or null if it can't be used. */
export function normalizeGame(g, uid) {
  if (g.variant !== 'standard' || SKIP_STATUS.has(g.status) || !g.moves) return null;
  const w = g.players?.white, b = g.players?.black;
  if (!w?.user || !b?.user) return null; // games against the computer or anonymous players
  const color = w.user.id === uid ? 'white' : b.user.id === uid ? 'black' : null;
  if (!color) return null;
  const me = color === 'white' ? w : b, opp = color === 'white' ? b : w;
  if (!me.rating || !opp.rating) return null;
  const score = g.winner ? (g.winner === color ? 1 : 0) : 0.5;
  return {
    id: g.id,
    color,
    moves: g.moves.split(' '),
    score,
    exp: expected(me.rating, opp.rating),
    myRating: me.rating,
    oppRating: opp.rating,
    oppName: opp.user.name,
    speed: g.speed,
    createdAt: g.createdAt,
    opening: g.opening?.name || 'Unknown opening',
    eco: g.opening?.eco || '',
  };
}

function newStats() { return { games: 0, score: 0, exp: 0, w: 0, d: 0, l: 0, opp: 0 }; }
function add(s, g) {
  s.games++; s.score += g.score; s.exp += g.exp; s.opp += g.oppRating;
  if (g.score === 1) s.w++; else if (g.score === 0) s.l++; else s.d++;
}
export const lost = (s) => s.exp - s.score;
/** Rough performance rating: average opponent + 400 * (W - L) / N, clamped. */
export const perf = (s) => Math.round(s.opp / s.games + 400 * Math.max(-1, Math.min(1, (s.w - s.l) / s.games)));

/**
 * Builds one position tree per colour.
 * Nodes are keyed by position (so transpositions merge) and remember the first
 * move sequence that reached them, for display.
 */
export async function buildTrees(games, { maxPly = 24, onProgress } = {}) {
  const names = await loadOpeningNames();
  const trees = { white: new Map(), black: new Map() };
  const start = new Chess().fen();
  for (const color of ['white', 'black']) {
    trees[color].set(posKey(start), makeNode(start, [], null, null, 'Starting position', ''));
  }
  const total = games.length;
  for (let i = 0; i < total; i++) {
    const g = games[i];
    const tree = trees[g.color];
    const chess = new Chess();
    let node = tree.get(posKey(start));
    add(node.stats, g);
    const n = Math.min(maxPly, g.moves.length);
    for (let ply = 0; ply < n; ply++) {
      const san = g.moves[ply];
      let mv;
      try { mv = chess.move(san); } catch { break; }
      const fen = chess.fen();
      const key = posKey(fen);
      let child = tree.get(key);
      if (!child) {
        const found = names[key];
        const [eco, name] = found ? found.split('|') : [node.eco, node.name];
        child = makeNode(fen, node.path.concat(mv.san), node.fen, { from: mv.from, to: mv.to }, name, eco);
        tree.set(key, child);
      }
      add(child.stats, g);
      if (g.score < child.worstScore || (g.score === child.worstScore && child.examples.length < 6)) {
        if (g.score < child.worstScore) { child.examples = []; child.worstScore = g.score; }
        if (child.examples.length < 6) child.examples.push({ id: g.id, color: g.color, ply: ply + 1, opp: g.oppName, oppRating: g.oppRating, score: g.score });
      }
      let edge = node.moves.get(mv.san);
      if (!edge) { edge = { san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''), key, stats: newStats() }; node.moves.set(mv.san, edge); }
      add(edge.stats, g);
      node = child;
    }
    if (onProgress && i % 40 === 39) { onProgress(i + 1, total); await new Promise((r) => setTimeout(r, 0)); }
  }
  return trees;
}

function makeNode(fen, path, parentFen, lastMove, name, eco) {
  return { fen, path, parentFen, lastMove, name, eco, stats: newStats(), moves: new Map(), examples: [], worstScore: 2 };
}

/** Per-opening results for one colour, using Lichess's own opening names. */
export function openingTable(games, color, level = 'family') {
  const map = new Map();
  for (const g of games) {
    if (color !== 'both' && g.color !== color) continue;
    const name = level === 'family' ? g.opening.split(':')[0].trim() : g.opening;
    const k = g.color + '|' + name;
    let row = map.get(k);
    if (!row) { row = { name, color: g.color, eco: g.eco, stats: newStats() }; map.set(k, row); }
    add(row.stats, g);
  }
  return [...map.values()];
}

export function summary(games) {
  const all = newStats(), white = newStats(), black = newStats();
  for (const g of games) { add(all, g); add(g.color === 'white' ? white : black, g); }
  return { all, white, black };
}

/**
 * Finds the positions where the most points are lost.
 * Start from the worst nodes, then walk down while a single continuation accounts
 * for most of the loss, so each spot points at the specific line that hurts.
 */
export function findLeaks(trees, { minGames, limit = 12, colors = ['white', 'black'] } = {}) {
  const spots = new Map();
  const candidates = [];
  for (const color of colors) {
    for (const node of trees[color].values()) {
      if (node.path.length === 0 || node.stats.games < minGames) continue;
      // Ignore positions where the shortfall is spread thinly over many games.
      if (lost(node.stats) / node.stats.games < 0.12) continue;
      candidates.push({ color, node });
    }
  }
  candidates.sort((a, b) => lost(b.node.stats) - lost(a.node.stats));

  for (const { color, node } of candidates) {
    if (spots.size >= limit) break;
    if (lost(node.stats) < 1) break;
    const tree = trees[color];
    let cur = node;
    for (let step = 0; step < 60; step++) {
      let best = null;
      for (const e of cur.moves.values()) {
        const child = tree.get(e.key);
        if (!child || child === cur) continue;
        if (!best || lost(e.stats) > lost(best.stats)) best = { stats: e.stats, child };
      }
      if (best && best.stats.games >= minGames && lost(best.stats) >= 0.7 * lost(cur.stats)) cur = best.child;
      else break;
    }
    const k = color + '|' + posKey(cur.fen);
    if (!spots.has(k)) spots.set(k, { color, node: cur });
  }
  // A shallower spot is redundant if a deeper spot of the same colour sits on its line
  // and explains nearly all of its loss.
  const list = [...spots.values()];
  return list.filter((s) => !list.some((o) => o !== s && o.color === s.color
      && o.node.path.length > s.node.path.length
      && o.node.path.slice(0, s.node.path.length).join(' ') === s.node.path.join(' ')
      && lost(o.node.stats) >= 0.85 * lost(s.node.stats)))
    .sort((a, b) => lost(b.node.stats) - lost(a.node.stats));
}

/** Whose move led into this node: the user's or the opponent's. */
export function lastMoverIsUser(node, color) {
  const plies = node.path.length;
  if (!plies) return false;
  const whiteMoved = plies % 2 === 1;
  return (color === 'white') === whiteMoved;
}

/** "1. e4 e5 2. Nf3" style text for a move list. */
export function movesText(path, from = 0) {
  let out = '';
  for (let i = from; i < path.length; i++) {
    const n = Math.floor(i / 2) + 1;
    if (i % 2 === 0) out += `${n}. ${path[i]} `;
    else out += (i === from ? `${n}... ` : '') + path[i] + ' ';
  }
  return out.trim();
}

/** Converts a UCI move (Lichess cloud evals write castling as king-takes-rook) to SAN. */
export function uciToSan(fen, uci) {
  const c = new Chess(fen);
  let from = uci.slice(0, 2), to = uci.slice(2, 4);
  const piece = c.get(from);
  if (piece && piece.type === 'k') {
    const fix = { e1h1: 'g1', e1a1: 'c1', e8h8: 'g8', e8a8: 'c8' }[from + to];
    if (fix) to = fix;
  }
  try {
    const mv = c.move({ from, to, promotion: uci[4] || 'q' });
    return { san: mv.san, from: mv.from, to: mv.to };
  } catch {
    return null;
  }
}

export function fenAfter(fen, san) {
  const c = new Chess(fen);
  c.move(san);
  return c.fen();
}

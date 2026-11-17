import { fetchGames, fetchUser, cloudEval, gameUrl, analysisUrl, LichessError } from './lichess.js';
import {
  normalizeGame, buildTrees, findLeaks, openingTable, summary, lost, perf, posKey,
  lastMoverIsUser, movesText, uciToSan, loadOpeningNames,
} from './analyze.js';
import { boardSvg } from './board.js';
import { Chess } from '../vendor/chess.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => Math.round(x * 100) + '%';
const fmtInt = (n) => n.toLocaleString('en-US');

const S = {
  user: '', games: [], trees: null, depth: 24, leaks: [],
  leakColor: 'both', opColor: 'white', opLevel: 'family', opSort: 'lost',
  exColor: 'white', exKey: null, exPath: [], abort: null, running: false,
};

// ---------- theme ----------
$('themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('olf.theme', next); } catch {}
});

// ---------- query form ----------
const form = $('form');
function readForm() {
  return {
    user: $('user').value.trim(),
    max: Number($('max').value),
    depth: Number($('depth').value),
    speeds: [...form.querySelectorAll('input[name=speed]:checked')].map((i) => i.value),
    rated: $('rated').checked,
  };
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(readForm());
});

$('cancelBtn').addEventListener('click', () => S.abort?.abort());

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

function setStatus(text, fraction) {
  $('status').hidden = false;
  $('statusText').textContent = text;
  const bar = $('progressBar');
  const wrap = bar.parentElement;
  if (fraction == null) { wrap.classList.add('indeterminate'); bar.style.width = ''; }
  else { wrap.classList.remove('indeterminate'); bar.style.width = Math.min(100, fraction * 100).toFixed(1) + '%'; }
}

async function run(q) {
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(q.user)) { showError('Enter a valid Lichess username.'); return; }
  if (!q.speeds.length) { showError('Pick at least one time control.'); return; }
  S.abort?.abort();
  const ctrl = new AbortController();
  S.abort = ctrl;
  showError('');
  $('goBtn').disabled = true;
  $('cancelBtn').hidden = false;
  setStatus('Looking up ' + q.user + '…', null);
  loadOpeningNames();

  const games = [];
  let stopped = false;
  S.running = true;
  try {
    const profile = await fetchUser(q.user, ctrl.signal);
    if (profile.disabled || profile.closed) throw new LichessError('That account is closed.', 'closed');
    S.user = profile.username || q.user;
    const uid = profile.id || q.user.toLowerCase();
    let seen = 0, pending = false;
    const paint = () => { pending = false; if (S.abort !== ctrl || !S.running) return; setStatus(`Downloading games from Lichess: ${fmtInt(seen)} of up to ${fmtInt(q.max)}`, seen / q.max); };
    setStatus('Downloading games from Lichess…', 0);
    await fetchGames(q.user, { max: q.max, speeds: q.speeds, rated: q.rated, signal: ctrl.signal }, (raw) => {
      seen++;
      const g = normalizeGame(raw, uid);
      if (g) games.push(g);
      if (!pending) { pending = true; requestAnimationFrame(paint); }
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      stopped = true;
    } else {
      S.running = false;
      finish();
      showError(e instanceof LichessError ? e.message : 'Something went wrong while reading games from Lichess.');
      console.error(e);
      return;
    }
  }
  if (S.abort !== ctrl) return; // a newer run started
  S.running = false;
  $('cancelBtn').hidden = true;

  if (games.length < 10) {
    finish();
    showError(stopped && !games.length
      ? 'Stopped before any games were downloaded.'
      : `Only ${games.length} usable game${games.length === 1 ? '' : 's'} found with these settings. Try more time controls or include casual games.`);
    return;
  }
  S.games = games;
  S.depth = q.depth;
  updateUrl(q);
  await analyse();
  finish();
}

function finish() {
  $('goBtn').disabled = false;
  $('status').hidden = true;
}

async function analyse() {
  setStatus(`Analysing ${fmtInt(S.games.length)} games…`, 0);
  S.trees = await buildTrees(S.games, {
    maxPly: S.depth,
    onProgress: (n, total) => setStatus(`Analysing games: ${fmtInt(n)} of ${fmtInt(total)}`, n / total),
  });
  S.exKey = null; S.exPath = [];
  $('intro').hidden = true;
  $('results').hidden = false;
  renderSummary();
  renderLeaks();
  renderOpenings();
  renderExplorer();
}

function updateUrl(q) {
  const p = new URLSearchParams({ user: q.user });
  if (q.max !== 500) p.set('n', q.max);
  if (q.depth !== 24) p.set('depth', q.depth);
  const def = ['bullet', 'blitz', 'rapid', 'classical'];
  if (q.speeds.join(',') !== def.join(',')) p.set('speeds', q.speeds.join(','));
  if (!q.rated) p.set('casual', '1');
  history.replaceState(null, '', '?' + p);
  document.title = `${S.user} · Opening Leak Finder`;
}

// ---------- summary ----------
function renderSummary() {
  const s = summary(S.games);
  const times = S.games.map((g) => g.createdAt);
  const from = new Date(Math.min(...times)), to = new Date(Math.max(...times));
  const dfmt = (d) => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const allLeaks = findLeaks(S.trees, { minGames: minGames(), limit: 15 });
  const tile = (k, v, sub) => `<div class="card tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const colorTile = (label, st) => st.games
    ? tile(label, pct(st.score / st.games), `${fmtInt(st.games)} games, ratings predicted ${pct(st.exp / st.games)}`)
    : tile(label, '–', 'No games');
  $('summary').innerHTML =
    tile('Player', esc(S.user), `${fmtInt(S.games.length)} games, ${dfmt(from)}${dfmt(from) !== dfmt(to) ? ' to ' + dfmt(to) : ''}`) +
    colorTile('As White', s.white) +
    colorTile('As Black', s.black) +
    tile('Leaks found', String(allLeaks.length), allLeaks.length
      ? `${allLeaks.reduce((a, l) => a + lost(l.node.stats), 0).toFixed(1)} points below expectation`
      : 'Nothing stands out');
}

// ---------- tabs ----------
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  for (const t of $('tabs').querySelectorAll('button')) t.setAttribute('aria-selected', String(t === b));
  for (const name of ['leaks', 'openings', 'explorer']) $('panel-' + name).hidden = name !== b.dataset.tab;
});

function segmented(id, onChange) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    onChange(b.dataset.v);
  });
}
segmented('leakColor', (v) => { S.leakColor = v; renderLeaks(); });
segmented('opColor', (v) => { S.opColor = v; renderOpenings(); });
segmented('opLevel', (v) => { S.opLevel = v; renderOpenings(); });
segmented('exColor', (v) => { S.exColor = v; S.exKey = null; S.exPath = []; renderExplorer(); });
$('minGames').addEventListener('change', () => { renderLeaks(); renderSummary(); });

function minGames() {
  const v = $('minGames').value;
  if (v !== 'auto') return Number(v);
  return Math.max(3, Math.round(S.games.length / 120));
}

// ---------- shared bits ----------
function bar(st) {
  const n = st.games || 1;
  return `<div class="bar" title="${st.w} won, ${st.d} drawn, ${st.l} lost"><span class="w" style="width:${st.w / n * 100}%"></span><span class="d" style="width:${st.d / n * 100}%"></span><span class="l" style="width:${st.l / n * 100}%"></span></div>`;
}
function diffCell(st) {
  const d = (st.score - st.exp) / st.games * 100;
  const cls = d <= -5 ? 'neg' : d >= 5 ? 'pos' : '';
  return `<span class="${cls}">${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(0)}</span>`;
}
function lostCell(st) {
  const l = lost(st);
  const cls = l >= 1 ? 'neg' : l <= -1 ? 'pos' : '';
  return `<span class="${cls}">${l > 0 ? '−' : l < 0 ? '+' : ''}${Math.abs(l).toFixed(1)}</span>`;
}
function moveNo(ply) {
  // ply is the 1-based index of the move in the game
  const n = Math.ceil(ply / 2);
  return ply % 2 ? `${n}.` : `${n}...`;
}

// ---------- leaks ----------

function renderLeaks() {
  const list = $('leakList');
  list.innerHTML = '';
  const mg = minGames();
  S.leaks = findLeaks(S.trees, {
    minGames: mg, limit: 15,
    colors: S.leakColor === 'both' ? ['white', 'black'] : [S.leakColor],
  });
  $('leaksNote').textContent = `Positions you reached in at least ${mg} games where you scored well below what the ratings predicted, worst first. "Points lost" is how many points short of the expected score you finished in those games.`;
  if (!S.leaks.length) {
    list.innerHTML = `<div class="card empty">No clear leaks with these settings. Try more games, a lower minimum, or another colour.</div>`;
    return;
  }
  const cards = S.leaks.map((leak, i) => list.appendChild(leakCard(leak, i + 1)));
  // Evaluations load one card at a time, top to bottom (about 30 small requests at most).
  for (const c of cards) loadEngine(c);
}

function leakCard({ color, node }, rank) {
  const st = node.stats;
  const tree = S.trees[color];
  const plies = node.path.length;
  const mine = lastMoverIsUser(node, color);
  const lastSan = node.path[plies - 1];
  const lastLabel = `${moveNo(plies)}${moveNo(plies).endsWith('...') ? '' : ' '}${lastSan}`;
  const userToMove = !mine;

  const card = document.createElement('article');
  card.className = 'card leak';
  card._leak = { color, node };

  // Board: last move highlighted; the user's usual reply drawn in blue when it's their turn.
  const next = [...node.moves.values()].sort((a, b) => b.stats.games - a.stats.games);
  const arrows = [];
  if (userToMove && next[0]) arrows.push({ from: next[0].uci.slice(0, 2), to: next[0].uci.slice(2, 4), color: 'blue' });
  const boardWrap = document.createElement('div');
  boardWrap.className = 'leak-board';
  boardWrap.appendChild(boardSvg(node.fen, { orientation: color, lastMove: node.lastMove, arrows }));
  boardWrap.insertAdjacentHTML('beforeend', `<div class="legend">${userToMove && next[0] ? '<span><i style="background:#003088"></i>Your usual move</span>' : ''}<span class="eng-legend" hidden><i style="background:#15781b"></i>Engine's choice</span></div>`);

  const body = document.createElement('div');
  const lineHtml = `${esc(movesText(node.path.slice(0, -1)))} <b>${esc(plies % 2 ? `${Math.ceil(plies / 2)}. ${lastSan}` : lastSan)}</b>`;
  const verdict = mine
    ? `After your move <strong>${esc(lastLabel)}</strong>, you scored ${pct(st.score / st.games)} where the ratings predicted ${pct(st.exp / st.games)}.`
    : `When your opponent plays <strong>${esc(lastLabel)}</strong>, you score ${pct(st.score / st.games)} where the ratings predicted ${pct(st.exp / st.games)}.`;

  // Continuations from this position.
  const rows = next.slice(0, 5).map((e) => `
    <tr><td><b>${esc(e.san)}</b></td><td class="num">${e.stats.games}</td><td class="hide-sm">${bar(e.stats)}</td>
    <td class="num">${pct(e.stats.score / e.stats.games)}</td><td class="num">${diffCell(e.stats)}</td></tr>`).join('');

  const losses = node.examples.filter((x) => x.score < 1).slice(0, 4);
  body.innerHTML = `
    <div class="leak-head">
      <h3><span class="rank">${rank}</span>${esc(node.name)}${node.eco ? `<span class="eco muted small"> ${esc(node.eco)}</span>` : ''}</h3>
      <span class="badge ${color}">As ${color === 'white' ? 'White' : 'Black'}</span>
    </div>
    <p class="line">${lineHtml}</p>
    <p class="verdict">${verdict}</p>
    <div class="facts">
      <span><b>${st.games}</b> games</span>
      <span><b>${st.w}</b> won · <b>${st.d}</b> drawn · <b>${st.l}</b> lost</span>
      <span><b class="neg">${lost(st).toFixed(1)}</b> points lost</span>
      <span>avg. opponent <b>${Math.round(st.opp / st.games)}</b></span>
    </div>
    <div class="engine pending">Checking the Lichess cloud evaluation…</div>
    ${rows ? `<div class="sub">${userToMove ? 'Your moves from here' : 'Their replies from here'}</div>
    <div class="table-wrap"><table class="stats compact"><thead><tr><th>Move</th><th class="num">Games</th><th class="hide-sm">Results</th><th class="num">Score</th><th class="num" title="Score minus expected score, in percentage points">vs exp.</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    <div class="links">
      <a href="#" class="to-explorer">Show in explorer</a>
      <a href="${analysisUrl(node.fen, color)}" target="_blank" rel="noopener">Open position on Lichess</a>
      ${losses.map((x) => `<a href="${gameUrl(x.id, x.color, x.ply)}" target="_blank" rel="noopener">${x.score === 0 ? 'Loss' : 'Draw'} vs ${esc(x.opp)} (${x.oppRating})</a>`).join('')}
    </div>`;
  card.append(boardWrap, body);
  body.querySelector('.to-explorer').addEventListener('click', (e) => { e.preventDefault(); openInExplorer(color, node.path); });
  return card;
}

// Cloud evals: one request at a time, so Lichess isn't flooded.
let evalQueue = Promise.resolve();
function loadEngine(card) {
  evalQueue = evalQueue.then(() => engineFor(card)).catch(() => {});
}

function evalText(pv) {
  if (!pv) return null;
  if (pv.mate != null) return (pv.mate > 0 ? '#' : '#-') + Math.abs(pv.mate);
  const v = Math.round(pv.cp / 10) / 10;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}
function evalPawns(pv) {
  if (!pv) return null;
  if (pv.mate != null) return pv.mate > 0 ? 50 : -50;
  return pv.cp / 100;
}

async function engineFor(card) {
  const { color, node } = card._leak;
  const box = card.querySelector('.engine');
  const mine = lastMoverIsUser(node, color);
  const [here, before] = await Promise.all([
    cloudEval(node.fen),
    mine && node.parentFen ? cloudEval(node.parentFen) : Promise.resolve(null),
  ]);
  if (!card.isConnected) return;
  const pv = here?.pvs?.[0];
  if (!pv) {
    box.textContent = 'This position is not in the Lichess cloud evaluation database. Use "Open position on Lichess" to analyse it.';
    return;
  }
  const sign = color === 'white' ? 1 : -1;
  const best = pv.moves ? uciToSan(node.fen, pv.moves.split(' ')[0]) : null;
  const parts = [];
  const userView = evalPawns(pv) * sign;
  parts.push(`Engine evaluation here: <b>${evalText(pv)}</b> (${userView >= 0.5 ? 'better for you' : userView <= -0.5 ? 'better for your opponent' : 'about equal'}).`);
  if (mine && before?.pvs?.[0]) {
    const bpv = before.pvs[0];
    const bBest = bpv.moves ? uciToSan(node.parentFen, bpv.moves.split(' ')[0]) : null;
    const drop = (evalPawns(bpv) - evalPawns(pv)) * sign;
    const played = node.path[node.path.length - 1];
    if (bBest && bBest.san !== played && drop >= 0.5) {
      parts.push(`Your ${esc(played)} gives away about ${drop >= 10 ? 'the game' : drop.toFixed(1) + ' pawns'}; the engine prefers <b>${esc(bBest.san)}</b> (${evalText(bpv)}).`);
    } else if (bBest && bBest.san === played) {
      parts.push(`${esc(played)} is the engine's top choice, so the problem is in how the games continue.`);
    } else {
      parts.push(`${esc(played)} is a sound move; look at how the games continue from here.`);
    }
  } else if (best) {
    parts.push(`Best reply: <b>${esc(best.san)}</b>.`);
  }
  box.innerHTML = parts.join(' ');
  box.classList.remove('pending');
  if (best && !mine) {
    const old = card.querySelector('svg.board');
    const usual = [...node.moves.values()].sort((a, b) => b.stats.games - a.stats.games)[0];
    const arrows = [{ from: best.from, to: best.to, color: 'green' }];
    if (usual && usual.uci.slice(0, 4) !== best.from + best.to) arrows.unshift({ from: usual.uci.slice(0, 2), to: usual.uci.slice(2, 4), color: 'blue' });
    old.replaceWith(boardSvg(node.fen, { orientation: color, lastMove: node.lastMove, arrows }));
    card.querySelector('.eng-legend').hidden = false;
  }
}

// ---------- openings table ----------
const OP_COLS = [
  { key: 'name', label: 'Opening' },
  { key: 'games', label: 'Games', num: true },
  { key: 'bar', label: 'Results' },
  { key: 'score', label: 'Score', num: true },
  { key: 'exp', label: 'Expected', num: true, cls: 'hide-sm' },
  { key: 'diff', label: 'vs exp.', num: true },
  { key: 'lost', label: 'Net points', num: true },
  { key: 'perf', label: 'Perf.', num: true, cls: 'hide-sm' },
];

function renderOpenings() {
  const rows = openingTable(S.games, S.opColor, S.opLevel).filter((r) => r.stats.games >= 3);
  const sorters = {
    lost: (a, b) => lost(b.stats) - lost(a.stats),
    games: (a, b) => b.stats.games - a.stats.games,
    score: (a, b) => a.stats.score / a.stats.games - b.stats.score / b.stats.games,
    diff: (a, b) => (a.stats.score - a.stats.exp) / a.stats.games - (b.stats.score - b.stats.exp) / b.stats.games,
    perf: (a, b) => perf(a.stats) - perf(b.stats),
    name: (a, b) => a.name.localeCompare(b.name),
    exp: (a, b) => b.stats.exp / b.stats.games - a.stats.exp / a.stats.games,
  };
  rows.sort(sorters[S.opSort] || sorters.lost);
  const head = `<thead><tr>${OP_COLS.map((c) => `<th class="${c.num ? 'num ' : ''}${c.cls || ''}${S.opSort === c.key ? ' sorted' : ''}" ${c.key !== 'bar' ? `data-sort="${c.key}"` : ''}>${c.label}</th>`).join('')}</tr></thead>`;
  const body = rows.map((r) => {
    const s = r.stats;
    return `<tr><td class="name">${esc(r.name)}${S.opLevel === 'full' && r.eco ? `<span class="eco">${esc(r.eco)}</span>` : ''}</td>
      <td class="num">${s.games}</td><td>${bar(s)}</td>
      <td class="num">${pct(s.score / s.games)}</td><td class="num hide-sm">${pct(s.exp / s.games)}</td>
      <td class="num">${diffCell(s)}</td><td class="num">${lostCell(s)}</td><td class="num hide-sm">${perf(s)}</td></tr>`;
  }).join('');
  $('opTable').innerHTML = head + `<tbody>${body || `<tr><td colspan="8" class="muted">No openings with at least 3 games.</td></tr>`}</tbody>`;
}
$('opTable').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  S.opSort = th.dataset.sort;
  renderOpenings();
});

// ---------- explorer ----------
function openInExplorer(color, path) {
  const c = new Chess();
  S.exPath = path.map((san) => { c.move(san); return { san, key: posKey(c.fen()) }; });
  S.exKey = S.exPath.length ? S.exPath[S.exPath.length - 1].key : null;
  S.exColor = color;
  for (const x of $('exColor').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.v === color));
  $('tabs').querySelector('[data-tab=explorer]').click();
  renderExplorer();
  $('tabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function exNode() {
  const tree = S.trees[S.exColor];
  return tree.get(S.exKey) || tree.get(posKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
}

function renderExplorer() {
  const node = exNode();
  S.exKey = posKey(node.fen);
  const board = $('exBoard');
  board.innerHTML = '';
  board.appendChild(boardSvg(node.fen, { orientation: S.exColor, lastMove: node.lastMove }));
  $('exName').textContent = node.path.length ? `${node.name}${node.eco ? ' · ' + node.eco : ''}` : 'Starting position';
  const path = S.exPath;
  $('exPath').innerHTML = path.length
    ? path.map((p, i) => `${i % 2 === 0 ? `<span class="dim">${i / 2 + 1}.</span>` : ''}<button data-i="${i}" class="${i === path.length - 1 ? 'cur' : ''}">${esc(p.san)}</button>`).join(' ')
    : '<span class="dim">Pick a move below to start.</span>';
  $('exLink').href = analysisUrl(node.fen, S.exColor);
  $('exBack').disabled = !path.length;
  $('exStart').disabled = !path.length;

  const moves = [...node.moves.values()].sort((a, b) => b.stats.games - a.stats.games);
  const st = node.stats;
  const head = `<thead><tr><th>Move</th><th class="num">Games</th><th>Results</th><th class="num">Score</th><th class="num">vs exp.</th><th class="num" title="Points above or below what the ratings predicted">Net points</th></tr></thead>`;
  const body = moves.map((e) => `<tr class="click" data-san="${esc(e.san)}"><td><b>${esc(e.san)}</b></td><td class="num">${e.stats.games}</td><td>${bar(e.stats)}</td>
    <td class="num">${pct(e.stats.score / e.stats.games)}</td><td class="num">${diffCell(e.stats)}</td><td class="num">${lostCell(e.stats)}</td></tr>`).join('');
  const total = st.games
    ? `<tfoot><tr><td class="muted">All</td><td class="num">${st.games}</td><td>${bar(st)}</td><td class="num">${pct(st.score / st.games)}</td><td class="num">${diffCell(st)}</td><td class="num">${lostCell(st)}</td></tr></tfoot>`
    : '';
  $('exTable').innerHTML = head + `<tbody>${body || `<tr><td colspan="6" class="muted">${node.path.length >= S.depth ? 'This is as deep as the analysis goes. Change "Look at" to go further.' : 'No games continue from here.'}</td></tr>`}</tbody>` + total;
}

$('exTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-san]');
  if (!tr) return;
  const node = exNode();
  const edge = node.moves.get(tr.dataset.san);
  if (!edge) return;
  S.exPath.push({ san: edge.san, key: edge.key });
  S.exKey = edge.key;
  renderExplorer();
});
$('exPath').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  S.exPath = S.exPath.slice(0, Number(b.dataset.i) + 1);
  S.exKey = S.exPath[S.exPath.length - 1].key;
  renderExplorer();
});
$('exBack').addEventListener('click', () => {
  S.exPath.pop();
  S.exKey = S.exPath.length ? S.exPath[S.exPath.length - 1].key : null;
  renderExplorer();
});
$('exStart').addEventListener('click', () => { S.exPath = []; S.exKey = null; renderExplorer(); });

// ---------- start-up: ?user=... runs straight away ----------
(function init() {
  const p = new URLSearchParams(location.search);
  const user = p.get('user');
  if (p.get('n') && [...$('max').options].some((o) => o.value === p.get('n'))) $('max').value = p.get('n');
  if (p.get('depth') && [...$('depth').options].some((o) => o.value === p.get('depth'))) $('depth').value = p.get('depth');
  if (p.get('speeds')) {
    const sp = p.get('speeds').split(',');
    for (const i of form.querySelectorAll('input[name=speed]')) i.checked = sp.includes(i.value);
  }
  if (p.get('casual') === '1') $('rated').checked = false;
  if (user) {
    $('user').value = user;
    run(readForm());
  } else {
    try { const last = localStorage.getItem('olf.user'); if (last) $('user').value = last; } catch {}
  }
})();

form.addEventListener('submit', () => { try { localStorage.setItem('olf.user', $('user').value.trim()); } catch {} });

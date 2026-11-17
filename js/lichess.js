// Talking to the public Lichess API. No token needed for public games.

const API = 'https://lichess.org';

export class LichessError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/**
 * Streams a player's games as NDJSON and calls onGame for each one.
 * opts: { max, speeds: string[], rated: boolean, signal }
 */
export async function fetchGames(username, opts, onGame) {
  const q = new URLSearchParams({
    max: String(opts.max),
    moves: 'true',
    opening: 'true',
    clocks: 'false',
    evals: 'false',
    pgnInJson: 'false',
  });
  if (opts.speeds && opts.speeds.length) q.set('perfType', opts.speeds.join(','));
  if (opts.rated) q.set('rated', 'true');

  let res;
  try {
    res = await fetch(`${API}/api/games/user/${encodeURIComponent(username)}?${q}`, {
      headers: { Accept: 'application/x-ndjson' },
      signal: opts.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new LichessError('Could not reach Lichess. Check your connection and try again.', 'network');
  }
  if (res.status === 404) throw new LichessError(`No Lichess player called "${username}".`, 'notfound');
  if (res.status === 429) throw new LichessError('Lichess is limiting requests right now. Wait a minute and try again.', 'ratelimit');
  if (!res.ok || !res.body) throw new LichessError(`Lichess returned an error (${res.status}).`, 'http');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onGame(JSON.parse(line));
    }
  }
  const rest = buf.trim();
  if (rest) onGame(JSON.parse(rest));
}

export async function fetchUser(username, signal) {
  const res = await fetch(`${API}/api/user/${encodeURIComponent(username)}`, { signal });
  if (res.status === 404) throw new LichessError(`No Lichess player called "${username}".`, 'notfound');
  if (!res.ok) throw new LichessError(`Lichess returned an error (${res.status}).`, 'http');
  return res.json();
}

const evalCache = new Map();

/** Cloud evaluation of a position, or null if Lichess has none stored. */
export async function cloudEval(fen, multiPv = 1) {
  const key = fen + '|' + multiPv;
  if (evalCache.has(key)) return evalCache.get(key);
  const p = (async () => {
    try {
      const res = await fetch(`${API}/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })();
  evalCache.set(key, p);
  return p;
}

export const gameUrl = (id, color, ply) => `${API}/${id}${color === 'black' ? '/black' : ''}${ply ? '#' + ply : ''}`;
export const analysisUrl = (fen, color) => `${API}/analysis/standard/${fen.replace(/ /g, '_')}${color === 'black' ? '?color=black' : ''}`;

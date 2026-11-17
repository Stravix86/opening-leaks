// A static SVG chessboard: pieces, last-move highlight and arrows.

const FILES = 'abcdefgh';
const NS = 'http://www.w3.org/2000/svg';

function sq(square, orientation) {
  const f = FILES.indexOf(square[0]), r = Number(square[1]) - 1;
  return orientation === 'white' ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
}

/**
 * fen: position; opts: { orientation, lastMove: {from,to}, arrows: [{from,to,color}], coords }
 * Returns an <svg> element.
 */
export function boardSvg(fen, opts = {}) {
  const orientation = opts.orientation || 'white';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('class', 'board');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Board position ' + fen.split(' ')[0]);
  let html = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    html += `<rect x="${x}" y="${y}" width="1" height="1" class="${(x + y) % 2 ? 'dk' : 'lt'}"/>`;
  }
  if (opts.lastMove) {
    for (const s of [opts.lastMove.from, opts.lastMove.to]) {
      const p = sq(s, orientation);
      html += `<rect x="${p.x}" y="${p.y}" width="1" height="1" class="hl"/>`;
    }
  }
  if (opts.coords !== false) {
    for (let i = 0; i < 8; i++) {
      const file = orientation === 'white' ? FILES[i] : FILES[7 - i];
      const rank = orientation === 'white' ? 8 - i : i + 1;
      html += `<text x="${i + 0.96}" y="7.95" class="co ${(i + 7) % 2 ? 'on-dk' : 'on-lt'}" text-anchor="end">${file}</text>`;
      html += `<text x="0.04" y="${i + 0.24}" class="co ${i % 2 ? 'on-dk' : 'on-lt'}">${rank}</text>`;
    }
  }
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const square = FILES[f] + (8 - r);
      const p = sq(square, orientation);
      const name = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
      html += `<image href="vendor/pieces/${name}.svg" x="${p.x}" y="${p.y}" width="1" height="1"/>`;
      f++;
    }
  }
  for (const a of opts.arrows || []) html += arrow(a, orientation);
  svg.innerHTML = html;
  return svg;
}

function arrow({ from, to, color = 'green' }, orientation) {
  const a = sq(from, orientation), b = sq(to, orientation);
  const x1 = a.x + 0.5, y1 = a.y + 0.5, x2 = b.x + 0.5, y2 = b.y + 0.5;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const head = 0.42, w = 0.17;
  const ex = x2 - ux * head, ey = y2 - uy * head; // where the shaft ends
  const px = -uy, py = ux;
  const pts = [
    [x1 + px * w / 2 + ux * 0.2, y1 + py * w / 2 + uy * 0.2],
    [ex + px * w / 2, ey + py * w / 2],
    [ex + px * w * 1.6, ey + py * w * 1.6],
    [x2 - ux * 0.08, y2 - uy * 0.08],
    [ex - px * w * 1.6, ey - py * w * 1.6],
    [ex - px * w / 2, ey - py * w / 2],
    [x1 - px * w / 2 + ux * 0.2, y1 - py * w / 2 + uy * 0.2],
  ].map((p) => p.map((n) => n.toFixed(3)).join(',')).join(' ');
  return `<polygon points="${pts}" class="arrow ${color}"/>`;
}

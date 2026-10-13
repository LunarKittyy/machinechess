import { FILES, CLS } from "./util.js";

export const parseFen = (fen) => {
  const rows = fen.split(" ")[0].split("/"), grid = {};
  rows.forEach((row, i) => { let f = 0; for (const ch of row) { if (/\d/.test(ch)) f += +ch; else { grid[FILES[f] + (8 - i)] = ch; f++; } } });
  return { grid, turn: fen.split(" ")[1] };
};
export const sqXY = (sq, flip) => { const f = FILES.indexOf(sq[0]), r = +sq[1] - 1; return flip ? [7 - f, r] : [f, 7 - r]; };
export const pieceUrl = (ch) => `/pieces/${ch === ch.toUpperCase() ? "w" : "b"}${ch.toUpperCase()}.svg`;

const arrowSvg = (arrows, flip) => {
  const parts = arrows.map((a, i) => {
    const [x1, y1] = sqXY(a.from, flip), [x2, y2] = sqXY(a.to, flip);
    const sx = x1 + .5, sy = y1 + .5, ex = x2 + .5, ey = y2 + .5;
    const len = Math.hypot(ex - sx, ey - sy) || 1, ux = (ex - sx) / len, uy = (ey - sy) / len;
    const w = a.rank === 0 ? .17 : .1, head = a.rank === 0 ? .42 : .3;
    const bx = ex - ux * head, by = ey - uy * head, px = -uy, py = ux;
    const trim = .12;
    return `<g class="arrow r${a.rank}"><line x1="${sx + ux * trim}" y1="${sy + uy * trim}" x2="${bx}" y2="${by}" stroke-width="${w}"/>
      <polygon points="${ex - ux * .04},${ey - uy * .04} ${bx + px * (head * .62)},${by + py * (head * .62)} ${bx - px * (head * .62)},${by - py * (head * .62)}"/></g>`;
  }).join("");
  return `<svg class="arrows" viewBox="0 0 8 8" aria-hidden="true">${parts}</svg>`;
};

export function drawBoard(el, fen, o = {}) {
  const { grid, turn } = parseFen(fen), flip = !!o.flip;
  let h = "";
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const file = flip ? 7 - f : f, rank = flip ? r + 1 : 8 - r, sq = FILES[file] + rank;
    const light = (file + rank) % 2 === 1;
    const cls = ["sq", light ? "l" : "d", o.last?.includes(sq) && "last", o.selected === sq && "sel", o.checkSq === sq && "chk"].filter(Boolean).join(" ");
    h += `<div class="${cls}" style="left:${f * 12.5}%;top:${r * 12.5}%" data-sq="${sq}">${f === 0 ? `<span class="co r">${rank}</span>` : ""}${r === 7 ? `<span class="co f">${FILES[file]}</span>` : ""}</div>`;
  }
  for (const [sq, ch] of Object.entries(grid)) {
    const [x, y] = sqXY(sq, flip);
    h += `<div class="pc" data-sq="${sq}" style="background-image:url(${pieceUrl(ch)});transform:translate(${x * 100}%,${y * 100}%)"></div>`;
  }
  if (o.arrows?.length) h += arrowSvg(o.arrows, flip);
  if (o.badge && CLS[o.badge.cls]?.mark) {
    const [x, y] = sqXY(o.badge.sq, flip);
    h += `<div class="badge" style="left:${(x + 1) * 12.5}%;top:${y * 12.5}%;background:${CLS[o.badge.cls].color}" title="${CLS[o.badge.cls].label}">${CLS[o.badge.cls].mark}</div>`;
  }
  if (o.promo) h += `<div class="promo"><div>${["q", "r", "b", "n"].map((p) => `<button type="button" data-promo="${p}" aria-label="Promote to ${p}" style="background-image:url(${pieceUrl(o.promo === "white" ? p.toUpperCase() : p)})"></button>`).join("")}</div></div>`;
  el.innerHTML = h;
  if (o.animate) {
    const [from, to] = o.animate;
    const pc = el.querySelector(`.pc[data-sq="${to}"]`);
    if (pc) {
      const [x0, y0] = sqXY(from, flip), [x1, y1] = sqXY(to, flip);
      pc.style.transform = `translate(${x0 * 100}%,${y0 * 100}%)`;
      pc.getBoundingClientRect();
      pc.classList.add("slide");
      pc.style.transform = `translate(${x1 * 100}%,${y1 * 100}%)`;
    }
  }
  return { turn, grid };
}

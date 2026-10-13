export const FILES = "abcdefgh";
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
export const api = async (path, body, token) => {
  const opt = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
  opt.headers = { "Content-Type": "application/json", ...(token ? { "X-Seat-Token": token } : {}) };
  const r = await fetch("/api/" + path, opt);
  return r.json();
};
export const fmtClock = (ms) => {
  ms = Math.max(0, ms); const s = Math.floor(ms / 1000);
  if (ms < 10000) return `0:${String(s).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
export const fmtDur = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
export const ago = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};
export const other = (c) => (c === "white" ? "black" : "white");
export const agentLabel = (a) => {
  const model = a.model || "default", base = model.startsWith(a.id + "/") ? model : `${model} (${a.id})`;
  return [base, a.effort, a.subagents && "subagents"].filter(Boolean).join(" · ");
};
export const seatName = (g, c) => { const s = g.seats[c]; return s.kind === "agent" && s.agent ? agentLabel(s.agent) : s.name || (s.claimed ? "player" : "open seat"); };
export const variantTags = (s) => [
  s.rules === "lawless" && "lawless",
  s.board_mode === "request" && "board on request",
  s.board_mode === "never" && "no board",
  s.clock && `${s.clock.base_s / 60}+${s.clock.inc_s}`,
  s.max_illegal >= 0 && `${s.max_illegal} strikes`,
  s.chess960 != null && "960",
  s.fen && "custom start",
  !s.messages && "no chat",
].filter(Boolean);
export const tagsHtml = (s) => variantTags(s).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
export const resultText = (g) => {
  const r = g.result; if (!r) return "";
  return r.void ? "abandoned" : `${r.score} ${r.reason}`;
};

/* engine evals are white's point of view: {cp, mate} */
export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-10000, Math.min(10000, cp)))) - 1);
export const evalCp = (e) => (!e ? null : e.mate != null ? (e.mate > 0 ? 10000 - e.mate : -10000 - e.mate) : e.cp);
export const fmtEval = (e) => {
  if (!e) return "";
  if (e.terminal) return e.cp > 0 ? "1-0" : e.cp < 0 ? "0-1" : "½";
  if (e.mate != null) return (e.mate < 0 ? "-" : "") + "M" + Math.abs(e.mate);
  const v = e.cp / 100; return (v > 0 ? "+" : "") + v.toFixed(1);
};
export const CLS = {
  best: { label: "Best", mark: "", color: "var(--c-best)" },
  excellent: { label: "Excellent", mark: "", color: "var(--c-best)" },
  good: { label: "Good", mark: "", color: "var(--c-good)" },
  inaccuracy: { label: "Inaccuracy", mark: "?!", color: "var(--c-inacc)" },
  mistake: { label: "Mistake", mark: "?", color: "var(--c-mistake)" },
  blunder: { label: "Blunder", mark: "??", color: "var(--c-blunder)" },
};
export const chev = (k) => {
  const d = { first: "M2.5 2v10M11.5 2L5.5 7l6 5", prev: "M10 2L4 7l6 5", next: "M4 2l6 5-6 5", last: "M11.5 2v10M2.5 2l6 5-6 5" }[k];
  return `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
};

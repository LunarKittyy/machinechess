// machine chess web client: lobby, new game, game view (js/game.js), leaderboard. No build step.
import { esc, store, api, ago, fmtDur, seatName, tagsHtml, resultText, other } from "./js/util.js";
import { gameView } from "./js/game.js";

const $app = document.getElementById("app");
for (const c of "wb") for (const p of "PNBRQK") new Image().src = `/pieces/${c}${p}.svg`;

let cleanup = () => {};
const setCleanup = (f) => { cleanup = f; };
const go = (path) => { history.pushState({}, "", path); route(); };
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.metaKey && !e.ctrlKey && a.origin === location.origin) { e.preventDefault(); go(a.pathname); }
});
window.addEventListener("popstate", route);

function route() {
  cleanup(); cleanup = () => {};
  const p = location.pathname;
  const nav = p === "/new" ? "new" : p === "/leaderboard" ? "board" : "games";
  document.querySelectorAll("[data-nav]").forEach((a) => (a.dataset.nav === nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const m = p.match(/^\/g\/([0-9a-f]+)$/);
  if (m) return gameView(m[1], { $app, go, setCleanup });
  if (p === "/new") return newView();
  if (p === "/leaderboard") return boardView();
  return lobbyView();
}

/* ------------------------------------------------------- running sessions */
const $sess = document.getElementById("sessions");
async function pollSessions() {
  let list = [];
  try { list = await api("sessions"); } catch { return; }
  if (!Array.isArray(list)) return;
  $sess.hidden = !list.length;
  if (!list.length) { $sess.innerHTML = ""; return; }
  const open = $sess.querySelector("details")?.open;
  $sess.innerHTML = `<details ${open ? "open" : ""}><summary><span class="dot"></span>${list.length} agent${list.length > 1 ? "s" : ""} running</summary><div class="sess-pop">${list.map((s) =>
    `<div class="srow"><div><a href="/g/${s.game}" data-link>${esc(s.name)}</a><div class="muted small">${s.color} · game ${s.game} · ${esc(s.game_status)} · ${ago(s.started)}</div></div><button class="btn small" data-kill="${s.game}">Close</button></div>`).join("")}
    <div class="sess-foot"><button class="btn small ghost" data-killall>Close all</button></div></div></details>`;
  $sess.querySelectorAll("[data-kill]").forEach((b) => (b.onclick = async () => { await api(`games/${b.dataset.kill}/close-agents`, {}); pollSessions(); }));
  $sess.querySelector("[data-killall]").onclick = async () => { for (const g of new Set(list.map((s) => s.game))) await api(`games/${g}/close-agents`, {}); pollSessions(); };
}
setInterval(pollSessions, 4000); pollSessions();

/* ------------------------------------------------------------------ lobby */
async function lobbyView() {
  document.title = "Games · machine chess";
  let alive = true; cleanup = () => { alive = false; clearInterval(t); };
  const row = (g) => {
    const live = g.status !== "finished";
    const status = live ? `<span class="chip now"><span class="dot"></span>${g.status === "waiting" ? "waiting" : "live"}</span>` : `<span class="result">${esc(resultText(g))}</span>`;
    const acc = g.review ? `<span class="mono muted">${g.review.white.accuracy ?? "-"} / ${g.review.black.accuracy ?? "-"}</span>` : "";
    return `<tr class="row" data-id="${g.id}"><td class="vs"><span class="swatch white"></span>${esc(seatName(g, "white"))}<i>vs</i><span class="swatch black"></span>${esc(seatName(g, "black"))}</td>
      <td>${status}</td><td class="mono hide-s">${g.plies}</td><td class="hide-s">${acc}</td><td class="hide-s">${tagsHtml(g.settings)}</td><td class="muted hide-s">${ago(g.created)}</td></tr>`;
  };
  const table = (games, title) => games.length ? `<h2 class="sec">${title}</h2><table class="games"><thead><tr><th>Players</th><th>Status</th><th class="hide-s">Plies</th><th class="hide-s">Accuracy</th><th class="hide-s">Rules</th><th class="hide-s">Started</th></tr></thead><tbody>${games.map(row).join("")}</tbody></table>` : "";
  const draw = async () => {
    const games = await api("games");
    if (!alive) return;
    const liveG = games.filter((g) => g.status !== "finished"), done = games.filter((g) => g.status === "finished");
    $app.innerHTML = `<div class="lobby-head"><h1>Games</h1><a class="btn primary" href="/new" data-link>New game</a></div>
      ${games.length ? table(liveG, "In progress") + table(done, "Finished")
        : `<div class="empty"><h2>No games yet</h2><p>Start one and pick who plays each side: a human, an installed LLM CLI, or an open seat that an agent joins with the <span class="mono">chess</span> command.</p><a class="btn primary" href="/new" data-link>New game</a></div>`}`;
    $app.querySelectorAll("tr.row").forEach((tr) => tr.addEventListener("click", () => go("/g/" + tr.dataset.id)));
  };
  const t = setInterval(draw, 3000);
  await draw();
}

/* --------------------------------------------------------------- new game */
async function newView() {
  document.title = "New game · machine chess";
  $app.innerHTML = `<p class="muted">Looking for installed agent CLIs…</p>`;
  const agents = await api("agents");
  const st = store.get("mc-new", {});
  const seatDefaults = { white: { kind: "human" }, black: { kind: "agent", cli: agents[0]?.id, model: "sonnet", effort: "", subagents: false } };
  const S = { white: { ...seatDefaults.white, ...(st.white || {}) }, black: { ...seatDefaults.black, ...(st.black || {}) } };
  const O = { rules: "standard", board_mode: "always", max_illegal: -1, timed: false, base_min: 10, inc_s: 5, messages: true, start: "standard", fen: "", c960: "", ...(st.opts || {}) };

  const seg = (name, val, opts) => `<span class="seg">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${v === val ? "checked" : ""}><span>${l}</span></label>`).join("")}</span>`;
  const cliOf = (id) => agents.find((a) => a.id === id) || agents[0];

  const seatHtml = (c) => {
    const s = S[c], a = cliOf(s.cli);
    let detail = "";
    if (s.kind === "agent") {
      if (!agents.length) detail = `<p class="note">No supported LLM CLI found on this machine (looked for claude, codex, agy, opencode).</p>`;
      else {
        const models = a.models;
        const known = models.some((m) => m.id === s.model);
        const model = models.find((m) => m.id === s.model);
        const efforts = (model && model.efforts) || a.efforts;
        detail = `<div class="grid2">
          <label class="field">CLI<select data-f="cli">${agents.map((x) => `<option value="${x.id}" ${x.id === s.cli ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>
          <label class="field">Model<select data-f="model">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === s.model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}<option value="__custom" ${!known && s.model ? "selected" : ""}>Other…</option><option value="" ${!s.model ? "selected" : ""}>CLI default</option></select></label>
          ${!known && s.model ? `<label class="field">Model id<input type="text" data-f="model_custom" value="${esc(s.model === "__custom" ? "" : s.model)}" placeholder="exact model id"></label>` : ""}
          ${efforts.length ? `<label class="field">Reasoning effort<select data-f="effort"><option value="">CLI default</option>${efforts.map((e) => `<option ${e === s.effort ? "selected" : ""}>${e}</option>`).join("")}</select></label>` : `<p class="hint">Effort is part of the model id for this CLI.</p>`}
        </div>
        <label class="check"><input type="checkbox" data-f="subagents" ${s.subagents ? "checked" : ""}> Allow subagents</label>
        <p class="hint">${a.subagent_control ? "Off by default. The prompt also states it, and the CLI is restricted where it supports that." : "Off by default. This CLI has no switch for it, so the rule is enforced by the prompt only."} Web, engines and scripts are always forbidden in the prompt.</p>`;
      }
    } else if (s.kind === "human") {
      detail = `<label class="field">Name (for the leaderboard)<input type="text" data-f="name" value="${esc(s.name || "")}" placeholder="Human"></label>`;
    } else {
      detail = `<p class="hint">You get a join command after creating the game. Any agent with a shell can take the seat: <span class="mono">chess join &lt;id&gt;</span>.</p>`;
    }
    return `<section class="seat" data-seat="${c}"><header><span class="swatch ${c}"></span><h2>${c === "white" ? "White" : "Black"}</h2>${seg("kind-" + c, s.kind, [["human", "Human"], ["agent", "LLM agent"], ["open", "Open seat"]])}</header>${detail}</section>`;
  };

  const render = () => {
    $app.innerHTML = `<form class="new" id="f">
      <div><h1>New game</h1>${seatHtml("white")}${seatHtml("black")}
        <div class="seat"><button type="button" class="btn small ghost" id="swap" style="justify-self:start">Swap sides</button></div></div>
      <div class="settings-col">
        <div class="fieldset"><h2>Rules</h2>
          ${seg("rules", O.rules, [["standard", "Standard"], ["lawless", "Lawless"]])}
          <p class="hint">${O.rules === "lawless" ? "Any move of your own piece to any square is accepted. The players must notice what happened. A game ends when a king is captured." : "Legal chess. Illegal moves are refused without saying why."}</p>
          <label class="field">Illegal move limit (-1 = no limit)<input type="number" name="max_illegal" value="${O.max_illegal}" min="-1"></label>
        </div>
        <div class="fieldset"><h2>Board feedback</h2>
          ${seg("board_mode", O.board_mode, [["always", "Every turn"], ["request", "On request"], ["never", "Never"]])}
          <p class="hint">${{ always: "The position is part of every reply.", request: "Only the opponent's move is shown. Players ask with chess board.", never: "No board and no history: a memory test. Check is still announced in standard rules." }[O.board_mode]}</p>
        </div>
        <div class="fieldset"><h2>Clock</h2>
          <label class="check"><input type="checkbox" name="timed" ${O.timed ? "checked" : ""}> Timed (thinking time counts against the player)</label>
          ${O.timed ? `<div class="grid2"><label class="field">Minutes each<input type="number" name="base_min" value="${O.base_min}" min="0.5" step="0.5"></label><label class="field">Increment (s)<input type="number" name="inc_s" value="${O.inc_s}" min="0"></label></div>` : `<p class="hint">Off. LLMs think for as long as they need.</p>`}
        </div>
        <div class="fieldset"><h2>Start</h2>
          <label class="field">Position<select name="start"><option value="standard" ${O.start === "standard" ? "selected" : ""}>Standard</option><option value="c960r" ${O.start === "c960r" ? "selected" : ""}>Chess960, random</option><option value="c960" ${O.start === "c960" ? "selected" : ""}>Chess960, number…</option><option value="fen" ${O.start === "fen" ? "selected" : ""}>Custom FEN…</option></select></label>
          ${O.start === "c960" ? `<label class="field">Position number (0-959)<input type="number" name="c960" min="0" max="959" value="${esc(O.c960)}"></label>` : ""}
          ${O.start === "fen" ? `<label class="field">FEN<input type="text" name="fen" value="${esc(O.fen)}" class="mono"></label>` : ""}
          <label class="check"><input type="checkbox" name="messages" ${O.messages ? "checked" : ""}> Players can leave messages for each other</label>
        </div>
        <p class="err" id="err" role="alert"></p>
        <div><button class="btn primary" type="submit">Start game</button></div>
      </div></form>`;
    wire();
  };

  const readForm = () => {
    const f = document.getElementById("f");
    const fd = new FormData(f);
    for (const c of ["white", "black"]) {
      S[c].kind = fd.get("kind-" + c);
      f.querySelectorAll(`[data-seat="${c}"] [data-f]`).forEach((el) => {
        const k = el.dataset.f; const v = el.type === "checkbox" ? el.checked : el.value;
        if (k === "model_custom") S[c].model = v; else S[c][k] = v;
      });
    }
    O.rules = fd.get("rules"); O.board_mode = fd.get("board_mode"); O.max_illegal = parseInt(fd.get("max_illegal") ?? -1, 10);
    O.timed = fd.has("timed"); if (O.timed) { O.base_min = parseFloat(fd.get("base_min") ?? O.base_min); O.inc_s = parseInt(fd.get("inc_s") ?? O.inc_s, 10); }
    O.start = fd.get("start"); O.fen = fd.get("fen") ?? O.fen; O.c960 = fd.get("c960") ?? O.c960; O.messages = fd.has("messages");
  };
  const wire = () => {
    const f = document.getElementById("f");
    f.addEventListener("change", (e) => {
      const before = JSON.stringify([S, O]);
      readForm();
      const t = e.target;
      if (t.dataset.f === "cli") { const a = cliOf(t.value); S[t.closest("[data-seat]").dataset.seat].model = a.models[0]?.id || ""; S[t.closest("[data-seat]").dataset.seat].effort = ""; }
      if (t.dataset.f === "model" && t.value === "__custom") S[t.closest("[data-seat]").dataset.seat].model = "__custom";
      if (before !== JSON.stringify([S, O]) && (t.type === "radio" || t.tagName === "SELECT" || t.name === "timed")) render();
      store.set("mc-new", { white: S.white, black: S.black, opts: O });
    });
    document.getElementById("swap").onclick = () => { readForm(); [S.white, S.black] = [S.black, S.white]; render(); };
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); readForm();
      store.set("mc-new", { white: S.white, black: S.black, opts: O });
      const settings = { rules: O.rules, board_mode: O.board_mode, max_illegal: O.max_illegal, messages: O.messages,
        clock: O.timed ? { base_s: Math.round(O.base_min * 60), inc_s: O.inc_s } : null,
        chess960: O.start === "c960r" ? "random" : O.start === "c960" ? O.c960 : null, fen: O.start === "fen" ? O.fen : null };
      const seat = (c) => {
        const s = S[c];
        if (s.kind === "human") return { kind: "human", name: s.name || "Human" };
        if (s.kind === "open") return { kind: "open" };
        return { kind: "agent", agent: { id: s.cli, model: s.model === "__custom" ? "" : s.model, effort: s.effort || "", subagents: !!s.subagents } };
      };
      const r = await api("games", { settings, white: seat("white"), black: seat("black") });
      if (r.error) { document.getElementById("err").textContent = r.error; return; }
      const all = store.get("mc-tokens", {}); all[r.id] = r.tokens; store.set("mc-tokens", all);
      go("/g/" + r.id);
    });
  };
  render();
}

/* ------------------------------------------------------------ leaderboard */
async function boardView() {
  document.title = "Leaderboard · machine chess";
  const games = (await api("games")).filter((g) => g.status === "finished" && g.result && !g.result.void);
  const variantKey = (s) => `${s.rules}|${s.board_mode}`;
  const variantLabel = (k) => { const [r, b] = k.split("|"); return `${r === "lawless" ? "Lawless" : "Standard"}, board ${{ always: "every turn", request: "on request", never: "never" }[b]}`; };
  const keys = [...new Set(games.map((g) => variantKey(g.settings)))].sort();
  let sel = store.get("mc-lb", "all");
  const draw = () => {
    const use = games.filter((g) => sel === "all" || variantKey(g.settings) === sel).sort((a, b) => a.created - b.created);
    const P = {};
    const get = (n) => (P[n] ||= { name: n, elo: 1000, g: 0, w: 0, d: 0, l: 0, illegal: 0, think: 0, thinkMoves: 0, unp: 0, acc: [], blunders: 0, ag: 0 });
    for (const g of use) {
      const a = get(seatName(g, "white")), b = get(seatName(g, "black"));
      const sa = g.result.winner === "white" ? 1 : g.result.winner === "black" ? 0 : 0.5;
      const ea = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
      a.elo += 24 * (sa - ea); b.elo += 24 * ((1 - sa) - (1 - ea));
      for (const [p, c, s] of [[a, "white", sa], [b, "black", 1 - sa]]) {
        p.g++; s === 1 ? p.w++ : s === 0 ? p.l++ : p.d++;
        const st = g.stats[c]; p.illegal += st.illegal; p.unp += st.unparseable; p.think += st.avg_think_ms * st.moves; p.thinkMoves += st.moves;
        const r = g.review?.[c]; if (r && r.accuracy != null) { p.acc.push(r.accuracy); p.blunders += r.counts.blunder; p.ag++; }
      }
    }
    const rows = Object.values(P).sort((x, y) => y.elo - x.elo);
    $app.innerHTML = `<div class="lb-head"><h1>Leaderboard</h1>${keys.length ? `<label class="field">Variant<select id="vsel"><option value="all">All variants</option>${keys.map((k) => `<option value="${k}" ${k === sel ? "selected" : ""}>${variantLabel(k)}</option>`).join("")}</select></label>` : ""}</div>
      ${rows.length ? `<div class="scroll-x"><table class="lb"><thead><tr><th>Player</th><th>Elo</th><th>Games</th><th>W-D-L</th><th>Score</th><th>Accuracy</th><th>Blunders / game</th><th>Illegal / game</th><th>Unreadable / game</th><th>Avg think</th></tr></thead><tbody>
      ${rows.map((p, i) => { const score = (p.w + p.d / 2) / p.g; return `<tr><td><span class="rankn">${i + 1}</span>${esc(p.name)}</td><td class="elo">${Math.round(p.elo)}</td><td>${p.g}</td><td>${p.w}-${p.d}-${p.l}</td><td>${Math.round(score * 100)}%<span class="bar"><i style="width:${score * 100}%"></i></span></td><td>${p.ag ? (p.acc.reduce((x, y) => x + y, 0) / p.ag).toFixed(1) : "-"}</td><td>${p.ag ? (p.blunders / p.ag).toFixed(1) : "-"}</td><td>${(p.illegal / p.g).toFixed(2)}</td><td>${(p.unp / p.g).toFixed(2)}</td><td>${p.thinkMoves ? fmtDur(Math.round(p.think / p.thinkMoves)) : "-"}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="hint" style="margin-top:1rem">Elo starts at 1000 and updates per game in order played (K=24). Accuracy and blunders come from Stockfish review of standard games. Abandoned games are not counted. Players are identified by CLI, model, effort and subagent setting.</p>`
        : `<div class="empty"><h2>Nothing to rank yet</h2><p>Finished games with a result appear here.</p></div>`}`;
    const v = document.getElementById("vsel"); if (v) v.onchange = () => { sel = v.value; store.set("mc-lb", sel); draw(); };
  };
  draw();
}

route();

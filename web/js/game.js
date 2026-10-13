import { FILES, esc, store, api, fmtClock, fmtDur, other, seatName, tagsHtml, resultText, winPct, evalCp, fmtEval, CLS, chev } from "./util.js";
import { drawBoard, parseFen } from "./board.js";

const TABS = [["moves", "Moves"], ["analysis", "Analysis"], ["transcript", "Transcript"], ["feed", "Feed"], ["info", "Game"]];

export async function gameView(id, { $app, go, setCleanup }) {
  let G = null, recv = 0, ply = null, flip = null, sel = null, promo = null;
  let tab = store.get("mc-tab", "moves"), arrowsOn = store.get("mc-arrows", true);
  let status = { text: "", bad: false }, confirmResign = false, rematchOpen = false, rematchOpts = { swap: true, cont: {} };
  const tr = { white: { entries: [], last: -1, spawn: null }, black: { entries: [], last: -1, spawn: null } };
  let trColor = store.get("mc-trcolor", "white"), expanded = new Set(), agentLog = {};
  const tokens = () => store.get("mc-tokens", {})[id] || {};
  const mine = () => Object.keys(tokens());
  let es, timers = [];
  document.body.classList.add("fit");
  const onKey = (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || !G) return;
    const n = G.moves.length, cur = ply ?? n;
    if (e.key === "ArrowLeft") setPly(cur - 1); else if (e.key === "ArrowRight") setPly(cur + 1);
    else if (e.key === "Home") setPly(0); else if (e.key === "End") setPly(n); else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  setCleanup(() => { document.body.classList.remove("fit"); es && es.close(); timers.forEach(clearInterval); document.removeEventListener("keydown", onKey); });

  $app.innerHTML = `<p class="muted">Loading game…</p>`;
  const snapshot = await api("games/" + id);
  if (snapshot.error) { $app.innerHTML = `<div class="empty"><h2>Game not found</h2><p><a href="/" data-link>Back to games</a></p></div>`; return; }
  es = new EventSource(`/api/games/${id}/stream`);
  es.onmessage = (e) => { const prev = G; G = JSON.parse(e.data); recv = Date.now(); onUpdate(prev); };

  const total = () => G.moves.length;
  const curPly = () => (ply === null || ply >= total() ? total() : ply);
  const live = () => ply === null || ply >= total();
  const entryAt = (p) => G.analysis?.plies?.[String(p)];
  const rv = (p) => G.review?.plies?.[String(p)];
  function setPly(p) { p = Math.max(0, Math.min(total(), p)); ply = p >= total() ? null : p; sel = null; promo = null; paint(true); if (tab === "transcript") scrollTranscriptToPly(); }
  const activeColor = () => (!G || G.status !== "active" || !live() ? null : mine().includes(G.turn) ? G.turn : null);
  const orient = () => (flip !== null ? flip : mine().length === 1 ? mine()[0] === "black" : false);

  let readied = false;
  function onUpdate(prev) {
    if (!readied) { readied = true; for (const t of Object.values(tokens())) api(`games/${id}/ready`, {}, t); }
    if (!prev) {
      $app.innerHTML = skeleton(); wireStatic();
      if (!store.get("mc-tab", null) && G.status === "finished" && G.analysis_state === "ok") tab = "analysis";
      timers.push(setInterval(tick, 500), setInterval(pollTranscript, 2000));
    }
    document.title = `${seatName(G, "white")} vs ${seatName(G, "black")} · machine chess`;
    const newMove = prev && G.moves.length === prev.moves.length + 1 && live();
    if (prev && live() && G.moves.length !== prev.moves.length) { sel = null; promo = null; }
    paint(newMove);
  }

  /* ---------------------------------------------------------------- layout */
  const skeleton = () => `<div class="crumbs"><a href="/" data-link class="back">All games</a><span class="sep">/</span><span id="g-title"></span><span id="g-chip"></span><span id="g-tags"></span><span class="crumb-actions" id="g-actions"></span></div>
    <div class="game">
      <div class="stage" id="stage" data-dock="0" data-eb="0"><div class="stage-inner">
        <div class="plate" id="p-top"></div>
        <div class="evalbar" id="evalbar"><div class="fill"></div><span class="lbl white"></span><span class="lbl black"></span></div>
        <div class="board" id="board" role="grid" aria-label="Chess board"></div>
        <div class="overlay" id="overlay"></div>
        <div class="plate" id="p-bot"></div>
        <div class="replay" id="replay"></div>
        <div class="dock" id="dock"></div>
      </div></div>
      <aside class="side"><div class="tabs" role="tablist" id="tabs"></div><div class="panel" id="panel"></div></aside>
    </div>`;

  const put = (el, html) => { if (el.__h === html) return false; el.__h = html; el.innerHTML = html; return true; };

  function wireStatic() { document.getElementById("board").addEventListener("click", boardClick); }

  function chipFor() {
    if (G.status === "waiting") return `<span class="chip">waiting for players</span>`;
    if (G.status === "active") return `<span class="chip now"><span class="dot"></span>live</span>`;
    const r = G.result;
    return `<span class="chip">${r.void ? "abandoned" : esc(r.score + " " + r.reason)}</span>`;
  }

  function sessionChip(c) {
    const s = G.seats[c];
    if (s.kind === "agent") {
      const sp = s.spawn;
      if (!sp) return "";
      if (sp.status === "running") {
        if (G.status === "finished") { const left = (G.ended + G.agent_grace) - (Date.now() + 0) / 1000; return `<span class="chip" data-closing="${c}">closes in ${fmtClock(Math.max(0, left) * 1000)}</span>`; }
        if (G.status === "waiting") return `<span class="chip">starting</span>`;
        return G.turn === c ? `<span class="chip now"><span class="dot"></span>thinking</span>` : `<span class="chip">waiting</span>`;
      }
      if (sp.status === "stopped") return `<span class="chip" title="${esc(sp.stopped_by || "")}">session closed</span>`;
      return `<span class="chip ${G.status !== "finished" ? "warn" : ""}">${G.status !== "finished" ? "session exited mid-game" : "session ended"}</span>`;
    }
    if (s.kind === "open") {
      if (!s.claimed) return `<span class="chip">open seat</span>`;
      if (G.status === "active") return G.turn === c ? `<span class="chip now"><span class="dot"></span>thinking</span>` : `<span class="chip">waiting</span>`;
    }
    return "";
  }

  const analysisPossible = () => !["hidden", "lawless", "no-engine"].includes(G.analysis_state);

  function plateHtml(c) {
    const s = G.seats[c], st = G.stats[c], pr = G.review?.players?.[c];
    const kind = s.kind === "agent" ? "LLM agent" : s.kind === "human" ? "Human" : "External CLI";
    const bits = [kind, `${st.moves} moves`, st.illegal ? `${st.illegal} illegal` : null, st.moves ? `avg ${fmtDur(st.avg_think_ms)}` : null].filter(Boolean).join(" · ");
    const acc = !analysisPossible() ? "" : pr?.accuracy != null
      ? `<div class="slot accslot"><div class="acc" title="Accuracy (Stockfish, win-probability based)"><b>${pr.accuracy.toFixed(1)}</b><span>accuracy</span></div></div>`
      : `<div class="slot accslot"><div class="acc none" title="Accuracy appears once the engine has analysed some moves"><b>-</b><span>accuracy</span></div></div>`;
    const chip = sessionChip(c);
    return `<span class="swatch ${c}"></span><div class="who"><div class="name">${esc(seatName(G, c))}</div><div class="sub">${esc(bits)}</div></div>
      ${acc}${chip ? `<div class="slot chipslot">${chip}</div>` : ""}${G.settings.clock ? `<div class="clock" data-clock="${c}"></div>` : ""}`;
  }

  /* ----------------------------------------------------------------- paint */
  function paint(animate) {
    if (!G) return;
    const f = orient(), bot = f ? "black" : "white", top = other(bot), p = curPly();
    const mv = p > 0 ? G.moves[p - 1] : null, fen = mv ? mv.fen : G.start_fen;
    let checkSq = null;
    if (/[+#]$/.test(mv?.san || "")) { const { grid, turn } = parseFen(fen); const k = turn === "w" ? "K" : "k"; checkSq = Object.keys(grid).find((s) => grid[s] === k); }
    const ent = G.analysis_state === "ok" ? entryAt(p) : null;
    const arrows = [];
    if (arrowsOn && ent?.lines) ent.lines.forEach((l, i) => l.uci && arrows.push({ from: l.uci.slice(0, 2), to: l.uci.slice(2, 4), rank: i }));
    const board = document.getElementById("board");
    const info = rv(p);
    const bkey = [fen, f, mv?.uci, sel, checkSq, promo?.color, JSON.stringify(arrows), info?.cls].join("|");
    if (bkey !== board.dataset.key || animate) {
      board.dataset.key = bkey;
      drawBoard(board, fen, { flip: f, last: mv ? [mv.uci.slice(0, 2), mv.uci.slice(2, 4)] : null, selected: sel, checkSq, promo: promo ? promo.color : null, arrows: arrows.reverse(),
        badge: mv && info ? { sq: mv.uci.slice(2, 4), cls: info.cls } : null, animate: animate && mv && p === total() ? [mv.uci.slice(0, 2), mv.uci.slice(2, 4)] : null });
    }
    board.classList.toggle("playable", !!activeColor());
    for (const [pos, c] of [["top", top], ["bot", bot]]) {
      const el = document.getElementById("p-" + pos);
      el.className = "plate" + (G.status === "active" && G.turn === c ? " on-turn" : "");
      put(el, plateHtml(c));
    }
    put(document.getElementById("g-title"), `${esc(seatName(G, "white"))}<span class="vs">vs</span>${esc(seatName(G, "black"))}`);
    put(document.getElementById("g-chip"), chipFor());
    put(document.getElementById("g-tags"), tagsHtml(G.settings));
    const stage = document.getElementById("stage");
    stage.dataset.eb = analysisPossible() ? "1" : "0";
    stage.dataset.dock = mine().length && G.status !== "finished" ? (G.settings.messages ? "2" : "1") : "0";
    paintEvalBar(ent, f);
    tick(); renderReplay(); renderStatus(); renderExtra(); renderTabs(); renderPanel();
  }

  let lastEnt = null;
  function paintEvalBar(ent, f) {
    const el = document.getElementById("evalbar");
    if (ent) lastEnt = ent;
    const shown = ent || lastEnt;
    el.classList.toggle("flipped", !!f);
    el.classList.toggle("stale", !ent);
    if (!shown) { el.querySelector(".fill").style.height = "50%"; el.classList.remove("w", "b"); return; }
    const cp = evalCp(shown), white = cp >= 0, txt = fmtEval(shown);
    el.querySelector(".fill").style.height = winPct(cp) + "%";
    el.classList.toggle("w", white); el.classList.toggle("b", !white);
    el.querySelector(".lbl.white").textContent = txt; el.querySelector(".lbl.black").textContent = txt;
    el.setAttribute("aria-label", "Engine evaluation " + txt);
  }

  function tick() {
    if (!G) return;
    if (G.clock) {
      const run = G.status === "active" ? G.turn : null;
      document.querySelectorAll("[data-clock]").forEach((el) => {
        const c = el.dataset.clock; let ms = G.clock[c + "_ms"]; if (run === c) ms -= Date.now() - recv;
        el.textContent = fmtClock(ms); el.classList.toggle("low", ms < 15000 && G.status !== "finished");
      });
    }
    document.querySelectorAll("[data-closing]").forEach((el) => {
      const left = (G.ended + G.agent_grace) - Date.now() / 1000; el.textContent = left > 0 ? `closes in ${fmtClock(left * 1000)}` : "closing";
    });
  }

  function renderReplay() {
    const n = total(), p = curPly(), el = document.getElementById("replay");
    const changed = put(el, `<div class="grp"><div class="nav-moves">
      <button class="btn icon" data-nav="0" aria-label="First position">${chev("first")}</button><button class="btn icon" data-nav="${p - 1}" aria-label="Previous move">${chev("prev")}</button>
      <button class="btn icon" data-nav="${p + 1}" aria-label="Next move">${chev("next")}</button><button class="btn icon" data-nav="${n}" aria-label="Latest position">${chev("last")}</button></div>
      <span class="muted mono">${p} / ${n}</span></div>
      <div class="grp">${G.analysis_state === "ok" ? `<label class="check small opt"><input type="checkbox" id="arrows" ${arrowsOn ? "checked" : ""}> Engine arrows</label>` : ""}
      ${!live() ? `<button class="btn small" data-nav="${n}">Back to live</button>` : ""}<button class="btn small ghost" id="flip">Flip</button></div>`);
    if (!changed) return;
    el.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => setPly(+b.dataset.nav)));
    document.getElementById("flip").onclick = () => { flip = !orient(); paint(); };
    const a = document.getElementById("arrows"); if (a) a.onchange = () => { arrowsOn = a.checked; store.set("mc-arrows", arrowsOn); paint(); };
  }

  let statusTimer; function renderStatus() { clearTimeout(statusTimer); if (G) renderExtra(); if (status.text) statusTimer = setTimeout(() => { status = { text: "", bad: false }; G && renderExtra(); }, 5000); }

  function rematchPanel() {
    const agentSeats = ["white", "black"].filter((c) => G.seats[c].kind === "agent");
    const rows = agentSeats.map((c) => {
      const sess = G.seats[c].spawn?.session;
      return `<label class="check"><input type="checkbox" data-cont="${c}" ${rematchOpts.cont[c] ? "checked" : ""} ${sess ? "" : "disabled"}> ${esc(seatName(G, c))} keeps its conversation (remembers this game)${sess ? "" : " <span class=muted>(no session saved)</span>"}</label>`;
    }).join("");
    return `<div class="rematch"><label class="check"><input type="checkbox" id="rm-swap" ${rematchOpts.swap ? "checked" : ""}> Swap colours</label>${rows}
      <p class="hint">Agents start with a fresh context unless you tick their conversation. The earlier game stays in the context if you do.</p>
      <div class="toolbar"><button class="btn primary" data-act="rematch-go">Start rematch</button><button class="btn ghost" data-act="rematch-toggle">Cancel</button></div></div>`;
  }

  function renderExtra() {
    const seats = mine();
    let acts = "", over = "", dock = "";
    if (G.status === "finished") {
      acts = `<button class="btn small" data-act="rematch-toggle">Rematch</button><a class="btn small" href="/new" data-link>New game</a>${rematchOpen ? rematchPanel() : ""}`;
    } else if (G.status === "waiting") {
      over = `<div class="banner">Waiting for ${["white", "black"].filter((c) => !G.seats[c].ready).map((c) => seatName(G, c) + " (" + c + ")").join(" and ")} to connect.</div>`;
      for (const c of ["white", "black"]) if (G.seats[c].kind === "open" && !G.seats[c].claimed) {
        over += `<div class="invite"><span>Open seat, ${c}. Run in the agent's shell:</span><code>chess join ${id} --color ${c} --name "name" --url ${location.origin}</code></div>`;
      }
    }
    if (G.status !== "finished" && seats.length) {
      const ac = activeColor(), offered = G.draw_offer && seats.includes(other(G.draw_offer));
      if (offered) over += `<div class="banner toast">${esc(seatName(G, G.draw_offer))} offers a draw. <span class="toolbar"><button class="btn small" data-act="draw-accept">Accept</button><button class="btn small" data-act="draw-decline">Decline</button></span></div>`;
      if (status.text) over += `<div class="banner toast ${status.bad ? "bad" : ""}" role="status">${esc(status.text)}</div>`;
      dock = `<form class="movebox drow" id="movebox"><input type="text" id="movein" placeholder="${ac ? (G.settings.rules === "lawless" ? "Move, e.g. e2e4" : "Move, e.g. Nf3 or g1f3") : G.status === "waiting" ? "Waiting for the opponent" : live() ? "Not your turn" : "Go back to live to move"}" autocomplete="off" spellcheck="false" ${ac ? "" : "disabled"}><button class="btn primary" ${ac ? "" : "disabled"}>Move</button>
        <button type="button" class="btn small" data-act="draw-offer">${G.draw_offer === seats[0] ? "Draw offered" : "Offer draw"}</button><button type="button" class="btn small danger" data-act="resign">${confirmResign ? "Confirm resign" : "Resign"}</button></form>`;
      if (G.settings.messages) dock += `<form class="sayrow drow say" id="sayform"><input type="text" id="sayin" placeholder="Message to the opponent, sent with your next move" maxlength="500"><button class="btn">Say</button></form>`;
    }
    const wire = (el, html) => put(el, html);
    const ch = [wire(document.getElementById("g-actions"), acts), wire(document.getElementById("overlay"), over), wire(document.getElementById("dock"), dock)];
    if (!ch.some(Boolean)) return;
    const root = document.getElementById("app");
    const mb = document.getElementById("movebox");
    if (mb) mb.onsubmit = (e) => { e.preventDefault(); const v = document.getElementById("movein").value.trim(); if (v) sendMove(v); };
    const sf = document.getElementById("sayform");
    if (sf) sf.onsubmit = async (e) => { e.preventDefault(); const v = document.getElementById("sayin").value.trim(); if (!v) return; const c = activeColor() || mine()[0]; const r = await api(`games/${id}/say`, { text: v }, tokens()[c]); status = { text: r.text, bad: r.code !== 0 }; document.getElementById("sayin").value = ""; renderStatus(); };
    root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => act(b.dataset.act)));
    root.querySelectorAll("[data-cont]").forEach((b) => (b.onchange = () => (rematchOpts.cont[b.dataset.cont] = b.checked)));
    const sw = document.getElementById("rm-swap"); if (sw) sw.onchange = () => (rematchOpts.swap = sw.checked);
  }

  async function act(a) {
    const c = activeColor() || (G.turn && mine().includes(G.turn) && G.turn) || mine()[0], t = tokens()[c];
    if (a === "rematch-toggle") { rematchOpen = !rematchOpen; return renderExtra(); }
    if (a === "rematch-go") {
      const r = await api(`games/${id}/rematch`, { swap: rematchOpts.swap, continue: rematchOpts.cont });
      if (r.error) { status = { text: r.error, bad: true }; return renderStatus(); }
      const all = store.get("mc-tokens", {}); all[r.id] = r.tokens; store.set("mc-tokens", all); return go("/g/" + r.id);
    }
    if (a === "resign") { if (!confirmResign) { confirmResign = true; renderExtra(); setTimeout(() => { confirmResign = false; G && renderExtra(); }, 3000); return; } confirmResign = false; const r = await api(`games/${id}/resign`, {}, t); status = { text: r.text, bad: false }; }
    else if (a.startsWith("draw-")) { const r = await api(`games/${id}/draw`, { action: a.slice(5) }, t); status = { text: r.text || (a === "draw-offer" ? "Draw offer queued. It is sent with your next move." : ""), bad: r.code === 6 }; }
    renderStatus();
  }

  async function sendMove(text) {
    const c = activeColor(); if (!c) return;
    const r = await api(`games/${id}/move`, { move: text, no_wait: true }, tokens()[c]);
    status = { text: r.code === 0 || (r.code === 4 && G.status !== "finished") ? "" : r.text, bad: r.code === 1 || r.code === 2 || r.code === 6 };
    if (r.code === 0) { const i = document.getElementById("movein"); if (i) i.value = ""; }
    renderStatus();
  }

  function boardClick(e) {
    const ac = activeColor(); if (!ac) return;
    const board = document.getElementById("board"), rect = board.getBoundingClientRect();
    if (e.target.closest(".promo")) { const b = e.target.closest("[data-promo]"); if (b && promo) { const m = promo.from + promo.to + b.dataset.promo; promo = null; sel = null; sendMove(m); paint(); } return; }
    const f = orient(), x = Math.floor(((e.clientX - rect.left) / rect.width) * 8), y = Math.floor(((e.clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return;
    const sq = FILES[f ? 7 - x : x] + (f ? y + 1 : 8 - y);
    const p = curPly(), fen = p ? G.moves[p - 1].fen : G.start_fen, { grid } = parseFen(fen);
    const isOwn = (s) => grid[s] && (ac === "white") === (grid[s] === grid[s].toUpperCase());
    if (!sel) { if (isOwn(sq)) { sel = sq; paint(); } return; }
    if (sq === sel) { sel = null; return paint(); }
    if (isOwn(sq) && G.settings.rules === "standard") { sel = sq; return paint(); }
    const pc = grid[sel];
    if (G.settings.rules === "standard" && pc && pc.toUpperCase() === "P" && (sq[1] === "8" || sq[1] === "1")) { promo = { from: sel, to: sq, color: ac }; return paint(); }
    const from = sel; sel = null; paint(); sendMove(from + sq);
  }

  /* ------------------------------------------------------------------ tabs */
  function renderTabs() {
    const el = document.getElementById("tabs");
    if (!put(el, TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`).join(""))) return;
    el.querySelectorAll("button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; store.set("mc-tab", tab); if (tab === "transcript") pollTranscript(true); renderTabs(); renderPanel(); }));
  }

  const moveLabel = (m) => `${m.no}${m.color === "white" ? "." : "..."} ${G.settings.rules === "lawless" ? m.uci : m.san}`;

  function renderPanel() {
    const el = document.getElementById("panel"); const keep = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.className = "panel tab-" + tab;
    if (tab === "moves") el.innerHTML = movesHtml();
    else if (tab === "analysis") el.innerHTML = analysisHtml();
    else if (tab === "transcript") el.innerHTML = transcriptHtml();
    else if (tab === "feed") el.innerHTML = feedHtml();
    else el.innerHTML = infoHtml();
    wirePanel(el);
    if (tab === "moves") { const c = el.querySelector(".cur"); if (c && live()) revealInPanel(el, c); else el.scrollTop = keep; }
    else if (tab === "transcript") { if (atBottom && live()) el.scrollTop = el.scrollHeight; else el.scrollTop = keep; }
    else el.scrollTop = keep;
  }

  function wirePanel(el) {
    el.querySelectorAll("[data-ply]").forEach((b) => (b.onclick = () => setPly(+b.dataset.ply)));
    el.querySelectorAll("[data-tr]").forEach((b) => (b.onclick = () => { trColor = b.dataset.tr; store.set("mc-trcolor", trColor); pollTranscript(true); renderPanel(); }));
    el.querySelectorAll("[data-exp]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const k = b.dataset.exp; expanded.has(k) ? expanded.delete(k) : expanded.add(k); renderPanel(); }));
    el.querySelectorAll("[data-log]").forEach((b) => (b.onclick = async () => { const c = b.dataset.log; const r = await api(`games/${id}/agent-log?color=${c}`); agentLog[c] = agentLog[c] != null ? null : r.log; renderPanel(); }));
    el.querySelectorAll("[data-restart]").forEach((b) => (b.onclick = () => api(`games/${id}/restart`, { color: b.dataset.restart })));
    el.querySelectorAll("[data-closeagents]").forEach((b) => (b.onclick = () => api(`games/${id}/close-agents`, {})));
    el.querySelectorAll("[data-abandon]").forEach((b) => (b.onclick = () => { if (b.dataset.sure) api(`games/${id}/abandon`, {}); else { b.dataset.sure = 1; b.textContent = "Confirm abandon"; setTimeout(() => { b.dataset.sure = ""; b.textContent = "Abandon game"; }, 3000); } }));
    const g = el.querySelector("#graph"); if (g) g.onclick = (e) => { const r = g.getBoundingClientRect(); setPly(Math.round(((e.clientX - r.left) / r.width) * total())); };
  }

  /* ----- moves */
  function movesHtml() {
    const rows = []; let cur = null;
    G.moves.forEach((m) => { if (m.color === "white" || !cur) { cur = { no: m.no, w: null, b: null }; rows.push(cur); } cur[m.color === "white" ? "w" : "b"] = m; });
    const cell = (m) => {
      if (!m) return "";
      const r = rv(m.ply), e = entryAt(m.ply);
      return `<button data-ply="${m.ply}" class="${m.ply === curPly() ? "cur" : ""}" title="${esc(CLS[r?.cls]?.label || "")} · think ${fmtDur(m.think_ms)}">
        <span class="san">${esc(G.settings.rules === "lawless" ? m.uci : m.san)}</span>${r && CLS[r.cls].mark ? `<span class="mk" style="color:${CLS[r.cls].color}">${CLS[r.cls].mark}</span>` : ""}${e && G.analysis_state === "ok" ? `<span class="ev">${esc(fmtEval(e))}</span>` : ""}</button>`;
    };
    return rows.length ? `<table class="moves"><tbody>${rows.map((r) => `<tr><td class="n">${r.no}</td><td>${cell(r.w)}</td><td>${cell(r.b)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted pad">No moves yet.</p>`;
  }

  /* ----- analysis */
  function graphSvg() {
    const n = total(), W = 340, H = 96, pts = [];
    for (let p = 0; p <= n; p++) { const e = entryAt(p); pts.push(e ? [p, winPct(evalCp(e))] : null); }
    const X = (p) => (n ? (p / n) * W : 0), Y = (w) => H - (w / 100) * H;
    const have = pts.filter(Boolean);
    if (have.length < 2) return `<p class="muted">The graph appears once a few positions are analysed.</p>`;
    const line = have.map(([p, w]) => `${X(p).toFixed(1)},${Y(w).toFixed(1)}`).join(" ");
    const area = `0,${H} ${line} ${X(have.at(-1)[0]).toFixed(1)},${H}`;
    const dots = G.moves.map((m) => { const r = rv(m.ply), e = entryAt(m.ply); return r && e && (r.cls === "mistake" || r.cls === "blunder") ? `<circle cx="${X(m.ply).toFixed(1)}" cy="${Y(winPct(evalCp(e))).toFixed(1)}" r="3" fill="${CLS[r.cls].color}"/>` : ""; }).join("");
    const cx = X(curPly());
    return `<svg id="graph" class="graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evaluation graph">
      <rect width="${W}" height="${H}" class="g-bg"/><polygon points="${area}" class="g-area"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="g-mid"/>
      <polyline points="${line}" class="g-line"/>${dots}<line x1="${cx}" x2="${cx}" y1="0" y2="${H}" class="g-cur"/></svg>`;
  }

  function analysisHtml() {
    const st = G.analysis_state;
    if (st === "hidden") return `<div class="note pad-note"><b>Analysis is hidden while a human plays.</b><br>It would be help. It unlocks when the game ends.</div>`;
    if (st === "lawless") return `<div class="note pad-note">Engine analysis needs standard rules. Lawless games are not analysed.</div>`;
    if (st === "no-engine") return `<div class="note pad-note">Stockfish is not installed. Install it and restart the server.</div>`;
    const have = Object.keys(G.analysis?.plies || {}).length, n = total() + 1, p = curPly(), ent = entryAt(p), pl = G.review?.players;
    let h = "";
    if (have < n) h += `<div class="progress" role="progressbar" aria-valuenow="${have}" aria-valuemax="${n}"><i style="width:${(have / n) * 100}%"></i><span>Analysing ${have} of ${n} positions</span></div>`;
    h += graphSvg();
    if (ent?.lines?.length) {
      h += `<h3>${p ? "After " + esc(moveLabel(G.moves[p - 1])) : "Start position"} <span class="muted">depth ${ent.depth}</span></h3><div class="lines">` +
        ent.lines.map((l, i) => `<div class="line ${i === 0 ? "top" : ""}"><b class="mono ev">${esc(fmtEval(l))}</b><span class="pv">${l.pv.map((m, j) => `<span class="${j === 0 ? "first" : ""}">${esc(m)}</span>`).join(" ")}</span></div>`).join("") + `</div>`;
    } else if (ent?.terminal) h += `<p class="muted">Game over in this position.</p>`;
    if (pl && (pl.white.moves || pl.black.moves)) {
      const row = (cls) => `<tr><td><span class="cdot" style="background:${CLS[cls].color}"></span>${CLS[cls].label}</td><td>${pl.white.counts[cls]}</td><td>${pl.black.counts[cls]}</td></tr>`;
      h += `<table class="summary"><thead><tr><th></th><th>${esc(seatName(G, "white"))}</th><th>${esc(seatName(G, "black"))}</th></tr></thead><tbody>
        <tr class="big"><td>Accuracy</td><td>${pl.white.accuracy?.toFixed(1) ?? "-"}</td><td>${pl.black.accuracy?.toFixed(1) ?? "-"}</td></tr>
        <tr><td>Avg centipawn loss</td><td>${pl.white.acpl ?? "-"}</td><td>${pl.black.acpl ?? "-"}</td></tr>
        ${["best", "excellent", "good", "inaccuracy", "mistake", "blunder"].map(row).join("")}</tbody></table>`;
      const key = G.moves.map((m) => ({ m, r: rv(m.ply) })).filter((x) => x.r && (x.r.cls === "mistake" || x.r.cls === "blunder")).sort((a, b) => b.r.loss - a.r.loss).slice(0, 6);
      if (key.length) h += `<h3>Key moments</h3><div class="moments">${key.map(({ m, r }) => `<button data-ply="${m.ply}"><span class="mk" style="color:${CLS[r.cls].color}">${CLS[r.cls].mark}</span><span>${esc(moveLabel(m))}</span><span class="muted">${esc(seatName(G, m.color))}</span><span class="mono muted">-${r.loss.toFixed(0)}%</span></button>`).join("")}</div>`;
    }
    h += `<p class="hint">${esc(G.analysis?.engine || "Stockfish")}, ${G.analysis?.time ?? ""} s per position. Accuracy follows the win-probability method; classes compare the move to the engine's best line.</p>`;
    return h;
  }

  /* ----- transcript */
  async function pollTranscript(force) {
    if (!G || (tab !== "transcript" && !force)) return;
    const t = tr[trColor];
    if (!force && G.status === "finished" && t.spawn && t.spawn.status !== "running" && t.loaded) return;
    const r = await api(`games/${id}/transcript?color=${trColor}&after=${t.last}`);
    t.spawn = r.spawn; t.loaded = true;
    if (r.entries.length) { t.entries.push(...r.entries); t.last = t.entries.at(-1).n; }
    if (tab === "transcript" && (r.entries.length || force)) renderPanel();
  }

  function turnsOf(color) {
    const moves = G.moves.filter((m) => m.color === color); let k = 0; const turns = []; let cur = { entries: [], move: null };
    for (const e of tr[color].entries) {
      cur.entries.push(e);
      if (e.kind === "result" && /^You played:/m.test(e.text)) { cur.move = moves[k++] || null; turns.push(cur); cur = { entries: [], move: null }; }
    }
    if (cur.entries.length) turns.push(cur);
    return turns;
  }

  const tidyCmd = (t) => t.replace(/\S*\/runs\/[0-9a-f]+\/(white|black)\/chess\b/g, "chess");
  function entryHtml(color, e) {
    const key = `${color}:${e.n}`;
    if (e.kind === "thinking") return `<div class="tx think ${expanded.has(key) ? "open" : ""}" data-exp="${key}" title="Click to expand"><span class="tag">thinking</span>${esc(e.text)}</div>`;
    if (e.kind === "text") return `<div class="tx prose">${esc(e.text)}</div>`;
    if (e.kind === "tool") return `<div class="tx cmd"><span class="ps">${esc(e.tool === "shell" || e.tool === "Bash" || e.tool === "bash" || e.tool === "run_command" ? "$" : e.tool)}</span><code>${esc(tidyCmd(e.text))}</code></div>`;
    if (e.kind === "result") {
      const lines = e.text.split("\n"), open = expanded.has(key), shown = open ? lines : lines.slice(0, 3);
      const meta = [e.code ? `exit ${e.code}` : null, e.ms ? fmtDur(e.ms) : null].filter(Boolean).join(" · ");
      return `<div class="tx out">${meta ? `<span class="meta">${meta}</span>` : ""}<pre>${esc(shown.join("\n"))}</pre>${lines.length > 3 ? `<button class="more" data-exp="${key}">${open ? "show less" : `show ${lines.length - 3} more lines`}</button>` : ""}</div>`;
    }
    if (e.kind === "system") return `<div class="tx sys">${esc(e.text)}</div>`;
    return `<div class="tx raw">${esc(e.text)}</div>`;
  }

  function transcriptHtml() {
    const seats = ["white", "black"].filter((c) => G.seats[c].kind === "agent");
    if (!seats.length) return `<div class="note pad-note">No agent seats in this game, so there is no transcript.</div>`;
    if (!seats.includes(trColor)) trColor = seats[0];
    const t = tr[trColor], sp = t.spawn || G.seats[trColor].spawn;
    const turns = turnsOf(trColor);
    const stateTxt = !sp ? "" : sp.status === "running" ? "session running" : sp.status === "stopped" ? `session closed (${sp.stopped_by || "stopped"})` : `session ended (exit ${sp.exit_code})`;
    let h = `<div class="trbar"><span class="seg small">${seats.map((c) => `<label><input type="radio" name="trc" ${c === trColor ? "checked" : ""} data-tr="${c}"><span>${esc(seatName(G, c))}</span></label>`).join("")}</span>
      <span class="muted">${esc(stateTxt)}</span></div>`;
    if (!t.loaded) return h + `<p class="muted pad">Loading…</p>`;
    if (!turns.length) return h + `<p class="muted pad">Nothing recorded yet.</p>`;
    h += turns.map((tu, i) => {
      const last = i === turns.length - 1 && !tu.move;
      const head = tu.move ? `${moveLabel(tu.move)}${rv(tu.move.ply) && CLS[rv(tu.move.ply).cls].mark ? ` <span class="mk" style="color:${CLS[rv(tu.move.ply).cls].color}">${CLS[rv(tu.move.ply).cls].mark}</span>` : ""}` : last ? (G.status === "finished" ? "Wrap-up" : "In progress") : "Setup";
      return `<section class="turn ${tu.move && tu.move.ply === curPly() ? "cur" : ""}" data-turnply="${tu.move?.ply ?? ""}"><button class="turn-h" ${tu.move ? `data-ply="${tu.move.ply}"` : "disabled"}>${head}</button>${tu.entries.map((e) => entryHtml(trColor, e)).join("")}</section>`;
    }).join("");
    return h;
  }
  function scrollTranscriptToPly() {
    const panel = document.getElementById("panel"), el = panel.querySelector(`[data-turnply="${curPly()}"]`);
    if (el) panel.scrollTo({ top: el.offsetTop - 44, behavior: "smooth" });
  }
  function revealInPanel(panel, el) {
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    if (top < panel.scrollTop) panel.scrollTop = top - 8; else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight + 8;
  }

  /* ----- feed + info */
  const plyOfEvent = (e) => G.log.filter((x) => x.type === "move" && x.i < e.i).length;
  function feedHtml() {
    const evs = G.log.filter((e) => ["say", "illegal", "draw_offer", "draw_declined", "agent_exit", "result", "join"].includes(e.type));
    if (!evs.length) return `<p class="muted pad">Messages, illegal attempts and draw offers show up here.</p>`;
    return `<div class="feed">${evs.map((e) => {
      const s = G.started ? Math.max(0, Math.round(e.t - G.started)) : 0, at = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      const who = e.by ? `<span class="who">${esc(seatName(G, e.by))}</span>` : "", j = `data-ply="${plyOfEvent(e)}"`;
      if (e.type === "say") return `<div class="ev say" ${j}><span class="at">${at}</span>${who}<div class="txt">${esc(e.text)}</div></div>`;
      if (e.type === "illegal") return `<div class="ev bad" ${j}><span class="at">${at}</span>${who}${e.kind === "parse" ? "sent an unreadable move" : "tried an illegal move"} <span class="mono">${esc(e.input)}</span></div>`;
      if (e.type === "draw_offer") return `<div class="ev sys" ${j}><span class="at">${at}</span>${who}offered a draw</div>`;
      if (e.type === "draw_declined") return `<div class="ev sys" ${j}><span class="at">${at}</span>${who}declined the draw</div>`;
      if (e.type === "join") return `<div class="ev sys"><span class="at">${at}</span>${who}joined</div>`;
      if (e.type === "agent_exit") return `<div class="ev sys ${e.code ? "bad" : ""}"><span class="at">${at}</span>${esc(seatName(G, e.color))}'s agent process exited (code ${e.code})</div>`;
      return `<div class="ev sys" ${j}><span class="at">${at}</span>${esc(G.result.void ? "Game abandoned" : G.result.score + " " + G.result.reason)}</div>`;
    }).join("")}</div>`;
  }

  function infoHtml() {
    const s = G.settings, c = s.clock;
    const kv = [["Rules", s.rules === "lawless" ? "Lawless" : "Standard"], ["Board feedback", { always: "Every turn", request: "On request", never: "Never" }[s.board_mode]], ["Illegal limit", s.max_illegal < 0 ? "none" : s.max_illegal],
      ["Clock", c ? `${c.base_s / 60} min + ${c.inc_s} s` : "off"], ["Messages", s.messages ? "on" : "off"], ["Start", s.chess960 != null ? `Chess960 #${s.chess960}` : s.fen ? "custom FEN" : "standard"], ["Game id", G.id]];
    const stat = ["white", "black"].map((col) => { const t = G.stats[col]; return `<div><h3>${esc(seatName(G, col))}</h3><dl class="kv"><dt>Moves</dt><dd>${t.moves}</dd><dt>Illegal</dt><dd>${t.illegal}</dd><dt>Unreadable</dt><dd>${t.unparseable}</dd><dt>Avg think</dt><dd>${t.moves ? fmtDur(t.avg_think_ms) : "-"}</dd><dt>Max think</dt><dd>${t.moves ? fmtDur(t.max_think_ms) : "-"}</dd></dl></div>`; }).join("");
    const agentSeats = ["white", "black"].filter((c2) => G.seats[c2].kind === "agent");
    const sessions = agentSeats.length ? `<h3>Agent sessions</h3><div class="sessions">${agentSeats.map((c2) => {
      const sp = G.seats[c2].spawn || {};
      const st = sp.status === "running" ? "running" : sp.status === "stopped" ? `closed (${sp.stopped_by})` : `exited (code ${sp.exit_code})`;
      return `<div class="srow"><div><b>${esc(seatName(G, c2))}</b> <span class="muted">${c2}</span><div class="muted small">${esc(st)}${sp.restarts ? ` · ${sp.restarts} restart(s)` : ""}${sp.session ? ` · session ${esc(sp.session.slice(0, 8))}` : ""}</div></div>
        <div class="controls">${sp.status === "running" ? `<button class="btn small" data-closeagents>Close now</button>` : G.status !== "finished" ? `<button class="btn small" data-restart="${c2}">Restart</button>` : ""}<button class="btn small ghost" data-log="${c2}">Raw output</button></div></div>${agentLog[c2] != null ? `<pre class="log">${esc(agentLog[c2] || "(empty)")}</pre>` : ""}`;
    }).join("")}${G.status === "finished" ? `<p class="hint">Agent processes are closed automatically ${Math.round(G.agent_grace)} s after the game. Their conversations stay saved, so a rematch can continue them.</p>` : ""}</div>` : "";
    let host = `<div class="controls" style="margin-top:1.2rem">`;
    if (s.rules === "standard") host += `<a class="btn small" href="/api/games/${id}/pgn" download="${id}.pgn">Download PGN</a>`;
    if (G.status !== "finished") host += `<button class="btn small danger" data-abandon>Abandon game</button>`;
    host += `</div>`;
    return `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl><div class="statrow">${stat}</div>${sessions}${host}`;
  }

  G = snapshot; recv = Date.now(); onUpdate(null);
}

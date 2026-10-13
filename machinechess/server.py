import json
import mimetypes
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import chess
import chess.pgn

import atexit
import signal
import sys

from . import agents, analysis, seatview
from .game import COLORS, Game, other
from .store import Store

WEB = Path(__file__).resolve().parent.parent / "web"
ROOT = Path(__file__).resolve().parent.parent
store = None
analyzer = analysis.Analyzer()
BASE_URL = "http://127.0.0.1:8765"
WAIT_S = 100


def pgn_for(game):
    d = game.d
    g = chess.pgn.Game()
    g.headers["Event"] = "machine-chess"
    g.headers["Date"] = time.strftime("%Y.%m.%d", time.localtime(d["created"]))
    for c, tag in (("white", "White"), ("black", "Black")):
        g.headers[tag] = d["seats"][c]["name"] or d["seats"][c]["kind"]
    g.headers["Result"] = (d["result"] or {}).get("score", "*")
    if d["start_fen"] != chess.STARTING_FEN:
        g.headers["FEN"] = d["start_fen"]
        g.headers["SetUp"] = "1"
    node = g
    b = chess.Board(d["start_fen"], chess960=d["settings"]["chess960"] is not None)
    for m in d["moves"]:
        mv = b.parse_uci(m["uci"])
        node = node.add_variation(mv)
        b.push(mv)
    return str(g) + "\n"


def snapshot(game):
    snap = game.public()
    st = analysis.state(game)
    snap["analysis_state"] = st
    snap["agent_grace"] = agents.GRACE
    if st == "ok":
        snap["analysis"] = game.d.get("analysis")
        snap["review"] = analysis.review(game)
    return snap


def summary(game):
    out = game.summary()
    if analysis.state(game) == "ok" and game.d.get("analysis"):
        out["review"] = analysis.review(game)["players"]
    return out


def create_game(body):
    settings = body.get("settings") or {}
    seats = {}
    for c in COLORS:
        s = dict(body.get(c) or {"kind": "open"})
        if s["kind"] == "agent":
            a = s["agent"]
            s["name"] = agents.identity(a)
        elif s["kind"] == "human":
            s["name"] = s.get("name") or "Human"
        seats[c] = s
    game = Game.create(settings, seats)
    store.add(game)
    for c in COLORS:
        if seats[c]["kind"] == "agent":
            with game.lock:
                agents.spawn(game, c, BASE_URL, WAIT_S)
    out = {"id": game.d["id"], "tokens": {}, "invites": {}}
    for c in COLORS:
        k = seats[c]["kind"]
        if k == "human":
            out["tokens"][c] = game.d["seats"][c]["token"]
        if k == "open":
            out["invites"][c] = f"chess join {game.d['id']} --color {c} --name \"<your name>\" --url {BASE_URL}"
    return out


def rematch(old, body):
    """New game with the same settings and players. Agent seats start fresh unless told to continue their session."""
    swap = bool(body.get("swap", True))
    cont = body.get("continue") or {}
    spec = {"settings": dict(old.d["settings"])}
    if old.d["settings"]["chess960"] is not None:
        spec["settings"]["chess960"] = "random" if body.get("new_960") else old.d["settings"]["chess960"]
    for c in COLORS:
        src = other(c) if swap else c
        seat = old.d["seats"][src]
        s = {"kind": seat["kind"], "name": seat["name"]}
        if seat["kind"] == "agent":
            s["agent"] = seat["agent"]
            sp = seat.get("spawn") or {}
            if cont.get(src) and sp.get("session"):
                s["resume"] = {"session": sp["session"], "workdir": sp.get("workdir")}
        spec[c] = s
    return create_game(spec)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # ---- plumbing ----
    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except ValueError:
            return {}

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        u = urlparse(self.path)
        path = u.path
        try:
            if path.startswith("/api/"):
                return self.api(method, path[5:].strip("/").split("/"), parse_qs(u.query))
            return self.static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # keep the server alive
            import traceback
            traceback.print_exc()
            try:
                self.send_json({"code": 6, "text": f"server error: {e}"}, 500)
            except Exception:
                pass

    def static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        if re.match(r"^/g/[0-9a-f]+$", path) or path in ("/leaderboard", "/new"):
            path = "/index.html"
        f = (WEB / path.lstrip("/")).resolve()
        if WEB not in f.parents and f != WEB or not f.is_file():
            self.send_json({"error": "not found"}, 404)
            return
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600" if path.startswith("/pieces/") else "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---- api ----
    def api(self, method, parts, q):
        if parts == ["agents"]:
            return self.send_json(agents.catalog())
        if parts == ["sessions"]:
            out = []
            for (gid, color), proc in list(agents.PROCS.items()):
                g = store.get(gid)
                if g and proc.poll() is None:
                    sp = g.d["seats"][color].get("spawn") or {}
                    out.append({"game": gid, "color": color, "name": g.d["seats"][color]["name"], "pid": proc.pid, "started": sp.get("started"), "game_status": g.d["status"]})
            return self.send_json(out)
        if parts == ["games"]:
            if method == "POST":
                try:
                    return self.send_json(create_game(self.body()))
                except (ValueError, KeyError) as e:
                    return self.send_json({"error": str(e)}, 400)
            return self.send_json([summary(g) for g in sorted(store.games.values(), key=lambda g: -g.d["created"])])
        if len(parts) < 2 or parts[0] != "games":
            return self.send_json({"error": "not found"}, 404)
        game = store.get(parts[1])
        if not game:
            return self.send_json({"code": 6, "text": "No such game.", "error": "no such game"}, 404)
        act = parts[2] if len(parts) > 2 else ""
        if act == "" and method == "GET":
            return self.send_json(snapshot(game))
        if act == "stream":
            return self.stream(game)
        if act == "pgn":
            data = pgn_for(game).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-chess-pgn")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if act == "join" and method == "POST":
            b = self.body()
            c, tok = game.join(b.get("color"), b.get("name"))
            if not c:
                return self.send_json({"code": 6, "text": "No open seat to join in that game."})
            return self.send_json({"code": 0, "color": c, "token": tok, "wait_s": WAIT_S})
        if act == "abandon" and method == "POST":
            game.abandon()
            for c in COLORS:
                agents.kill(game, c)
            return self.send_json({"ok": True})
        if act == "close-agents" and method == "POST":
            for c in COLORS:
                agents.kill(game, c, "closed by host")
            return self.send_json({"ok": True})
        if act == "transcript":
            c = q.get("color", ["white"])[0]
            after = int(q.get("after", ["-1"])[0])
            seat = game.d["seats"][c]
            return self.send_json({"entries": agents.read_transcript(game.d["id"], c, after), "spawn": game.public()["seats"][c]["spawn"]})
        if act == "rematch" and method == "POST":
            try:
                return self.send_json(rematch(game, self.body()))
            except (ValueError, KeyError) as e:
                return self.send_json({"error": str(e)}, 400)
        if act == "restart" and method == "POST":
            c = self.body().get("color")
            seat = game.d["seats"].get(c)
            if not seat or seat["kind"] != "agent" or game.d["status"] == "finished":
                return self.send_json({"ok": False}, 400)
            agents.kill(game, c)
            with game.lock:
                seat["resumed"] = True
                seat["intro_done"] = False
                seat["delivered"] = 0
                seat["spawn"]["stopped_by"] = None
                agents.spawn(game, c, BASE_URL, WAIT_S)
                game._changed()
            return self.send_json({"ok": True})
        if act == "agent-log":
            c = q.get("color", ["white"])[0]
            p = ROOT / "data" / "logs" / f"{game.d['id']}-{c}.log"
            txt = p.read_bytes()[-20000:].decode(errors="replace") if p.exists() else ""
            return self.send_json({"log": txt})

        # seat-authenticated actions
        color = game.color_for_token(self.headers.get("X-Seat-Token"))
        if not color:
            return self.send_json({"code": 6, "text": "Not seated in this game (bad token)."}, 403)
        b = self.body() if method == "POST" else {}
        wait_s = float(b.get("wait_s", WAIT_S))
        if act == "wait":
            game.ready(color)
            timed_out = game.wait(color, wait_s)
            return self.send_json(seatview.view(game, color, timed_out))
        if act == "ready":
            game.ready(color)
            return self.send_json({"ok": True})
        if act == "board":
            game.ready(color)
            return self.send_json(seatview.board_view(game, color))
        if act == "history":
            game.ready(color)
            return self.send_json(seatview.history_view(game, color))
        if act == "move":
            game.ready(color)
            res = game.submit_move(color, b.get("move", ""), b.get("say"), bool(b.get("draw")))
            if not res["ok"]:
                if res["reason"] in ("over",) or res.get("forfeit"):
                    return self.send_json({"code": 4, "text": seatview.reject_text(game, color, res)})
                return self.send_json({"code": res["code"], "text": seatview.reject_text(game, color, res) if res["reason"] != "not_started" else seatview.reject_text(game, color, res)})
            lead = [f"You played: {seatview.move_label(res['no'], color, res['uci'] if game.lawless else res['san'])}"]
            if b.get("no_wait"):
                return self.send_json({"code": 4 if game.d["status"] == "finished" else 0, "text": "\n".join(lead)})
            timed_out = game.wait(color, wait_s)
            out = seatview.view(game, color, timed_out, lead)
            if timed_out:
                out["code"] = 0
                out["text"] = out["text"].replace("Opponent has not moved yet. Run `chess wait` again.", "Move accepted. The opponent has not replied yet: run `chess wait`.")
            return self.send_json(out)
        if act == "say":
            r = game.say(color, b.get("text", ""))
            txt = {0: "Message queued; the opponent gets it with your next move.", 5: "Disabled: messages are turned off for this game."}.get(r["code"], "Empty message.")
            return self.send_json({"code": r["code"], "text": txt})
        if act == "resign":
            r = game.resign(color)
            return self.send_json({"code": r["code"], "text": seatview.result_text(game, color) if r["ok"] else "Cannot resign now."})
        if act == "draw":
            r = game.draw(color, b.get("action", ""))
            txt = r.get("msg") or (seatview.result_text(game, color) if r["code"] == 4 else "")
            return self.send_json({"code": r["code"], "text": txt})
        return self.send_json({"error": "not found"}, 404)

    def stream(self, game):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last = -1
        while True:
            with game.cond:
                if game.version == last:
                    game.cond.wait(15)
                v = game.version
            if v != last:
                last = v
                msg = "data: " + json.dumps(snapshot(game)) + "\n\n"
            else:
                msg = ": ping\n\n"
            self.wfile.write(msg.encode())
            self.wfile.flush()


def flag_loop():
    while True:
        time.sleep(0.3)
        for g in list(store.games.values()):
            if g.d["status"] == "active" and g.d["clock"]:
                g.tick()


def extra_hosts():
    """Addresses to listen on besides localhost: MC_BIND (comma list) or the tailscale IPv4 if present."""
    env = os.environ.get("MC_BIND")
    if env is not None:
        return [h.strip() for h in env.split(",") if h.strip()]
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5).stdout.split()
    except (OSError, subprocess.SubprocessError):
        return []
    return out[:1]


def main(host="127.0.0.1", port=8765):
    global store, BASE_URL
    BASE_URL = f"http://{host}:{port}"
    store = Store()
    store.on_change = analyzer.consider
    for g in store.games.values():
        agents.kill_orphans(g)
        agents.import_legacy_logs(g)
        analyzer.consider(g)
    threading.Thread(target=agents.catalog, daemon=True).start()
    threading.Thread(target=flag_loop, daemon=True).start()
    threading.Thread(target=agents.reaper, args=(store.get,), daemon=True).start()
    atexit.register(agents.kill_all)
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    print(f"machine-chess on {BASE_URL}")
    for extra in extra_hosts():
        try:
            other = ThreadingHTTPServer((extra, port), Handler)
        except OSError as e:
            print(f"could not bind {extra}:{port}: {e}")
            continue
        other.daemon_threads = True
        threading.Thread(target=other.serve_forever, daemon=True).start()
        print(f"machine-chess also on http://{extra}:{port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

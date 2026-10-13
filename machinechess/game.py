"""Game state, rules and the per-seat inbox."""
import re
import secrets
import threading
import time

import chess

COLORS = ("white", "black")
UCI_RE = re.compile(r"^([a-h][1-8])([a-h][1-8])([qrbn]?)$")
MAX_SAY = 500


def other(color):
    return "black" if color == "white" else "white"


def cbool(color):
    return chess.WHITE if color == "white" else chess.BLACK


def normalize_settings(raw):
    raw = raw or {}
    rules = raw.get("rules", "standard")
    if rules not in ("standard", "lawless"):
        raise ValueError("rules must be standard or lawless")
    board_mode = raw.get("board_mode", "always")
    if board_mode not in ("always", "request", "never"):
        raise ValueError("board_mode must be always, request or never")
    clock = raw.get("clock")
    if clock:
        base, inc = int(clock.get("base_s", 0)), int(clock.get("inc_s", 0))
        if base <= 0:
            raise ValueError("clock base must be positive")
        clock = {"base_s": base, "inc_s": max(0, inc)}
    else:
        clock = None
    fen = (raw.get("fen") or "").strip() or None
    c960 = raw.get("chess960")
    if c960 in ("", False):
        c960 = None
    if c960 == "random" or c960 is True:
        c960 = secrets.randbelow(960)
    if c960 is not None:
        c960 = int(c960)
        if not 0 <= c960 < 960:
            raise ValueError("chess960 position must be 0-959")
        fen = None
    if fen:
        b = chess.Board(fen)
        if rules == "standard" and b.status() & ~chess.STATUS_VALID:
            raise ValueError("invalid FEN: " + str(b.status()))
    return {
        "rules": rules,
        "board_mode": board_mode,
        "max_illegal": int(raw.get("max_illegal", -1)),
        "clock": clock,
        "messages": bool(raw.get("messages", True)),
        "fen": fen,
        "chess960": c960,
        "announce_check": bool(raw.get("announce_check", rules == "standard")) and rules == "standard",
    }


def start_board(settings):
    if settings["chess960"] is not None:
        return chess.Board.from_chess960_pos(settings["chess960"])
    if settings["fen"]:
        return chess.Board(settings["fen"])
    return chess.Board()


def lawless_push(board, uci):
    f, t, promo = chess.parse_square(uci[:2]), chess.parse_square(uci[2:4]), uci[4:]
    piece, captured = board.piece_at(f), board.piece_at(t)
    board.remove_piece_at(f)
    last = 7 if piece.color == chess.WHITE else 0
    if piece.piece_type == chess.PAWN and chess.square_rank(t) == last:
        piece = chess.Piece(chess.PIECE_SYMBOLS.index(promo or "q"), piece.color)
    board.set_piece_at(t, piece)
    board.halfmove_clock = 0 if captured or piece.piece_type == chess.PAWN else board.halfmove_clock + 1
    board.turn = not board.turn
    if board.turn == chess.WHITE:
        board.fullmove_number += 1
    board.ep_square = None
    board.castling_rights = chess.BB_EMPTY


class Game:
    def __init__(self, d, on_change=None):
        self.d = d
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.on_change = on_change
        self.version = 0
        self.rebuild()

    # ---------- construction ----------
    @classmethod
    def create(cls, settings, seats, on_change=None):
        settings = normalize_settings(settings)
        board = start_board(settings)
        d = {
            "id": secrets.token_hex(3),
            "created": time.time(),
            "status": "waiting",
            "settings": settings,
            "start_fen": board.fen(),
            "seats": {},
            "moves": [],
            "log": [],
            "result": None,
            "started": None,
            "ended": None,
            "turn_started": None,
            "clock": None,
            "draw_offer": None,
            "offer_armed": None,
        }
        for color in COLORS:
            s = seats.get(color, {})
            d["seats"][color] = {
                "kind": s.get("kind", "open"),
                "name": s.get("name") or ("Human" if s.get("kind") == "human" else None),
                "token": secrets.token_urlsafe(12),
                "claimed": s.get("kind") in ("human", "agent"),
                "ready": False,
                "delivered": 0,
                "intro_done": False,
                "resumed": False,
                "agent": s.get("agent"),
                "resume": s.get("resume"),
                "spawn": None,
                "last_seen": None,
                "in_wait": False,
            }
        if settings["clock"]:
            ms = settings["clock"]["base_s"] * 1000
            d["clock"] = {"white_ms": ms, "black_ms": ms}
        return cls(d, on_change)

    def rebuild(self):
        s = self.d["settings"]
        b = chess.Board(self.d["start_fen"], chess960=s["chess960"] is not None)
        if s["rules"] == "lawless" and not self.d["moves"]:
            b.castling_rights = chess.BB_EMPTY
        for m in self.d["moves"]:
            self._push(b, m["uci"])
        self.board = b

    @property
    def lawless(self):
        return self.d["settings"]["rules"] == "lawless"

    def _push(self, board, uci):
        if self.lawless:
            lawless_push(board, uci)
        else:
            board.push_uci(uci)

    # ---------- helpers ----------
    def _changed(self):
        self.version += 1
        self.cond.notify_all()
        if self.on_change:
            self.on_change(self)

    def _log(self, type_, **kw):
        ev = {"i": len(self.d["log"]), "t": time.time(), "type": type_}
        ev.update(kw)
        self.d["log"].append(ev)
        return ev

    def turn_color(self):
        return "white" if self.board.turn == chess.WHITE else "black"

    def color_for_token(self, token):
        for c in COLORS:
            if token and secrets.compare_digest(self.d["seats"][c]["token"], token):
                return c
        return None

    def clock_now(self):
        """Remaining ms per colour, with the running clock deducted."""
        c = self.d["clock"]
        if not c:
            return None
        out = {"white_ms": c["white_ms"], "black_ms": c["black_ms"]}
        if self.d["status"] == "active":
            run = self.turn_color() + "_ms"
            out[run] -= int((time.time() - self.d["turn_started"]) * 1000)
        return out

    def illegal_count(self, color):
        return sum(1 for e in self.d["log"] if e["type"] == "illegal" and e["by"] == color and e["kind"] == "illegal")

    # ---------- lifecycle ----------
    def join(self, color, name):
        with self.lock:
            order = [color] if color in COLORS else list(COLORS)
            for c in order:
                s = self.d["seats"][c]
                if s["kind"] == "open" and not s["claimed"]:
                    s["claimed"] = True
                    s["name"] = (name or "anonymous")[:60]
                    self._log("join", by=c, name=s["name"])
                    self._changed()
                    return c, s["token"]
            return None, None

    def ready(self, color):
        with self.lock:
            s = self.d["seats"][color]
            s["last_seen"] = time.time()
            if s["ready"]:
                return
            s["ready"] = True
            self._log("ready", by=color)
            if self.d["status"] == "waiting" and all(self.d["seats"][c]["ready"] for c in COLORS):
                self.d["status"] = "active"
                self.d["started"] = self.d["turn_started"] = time.time()
                self._log("start")
            self._changed()

    def finish(self, winner, reason, void=False):
        if self.d["status"] == "finished":
            return
        clk = self.clock_now()
        if clk:
            self.d["clock"] = clk
        self.d["status"] = "finished"
        self.d["ended"] = time.time()
        score = "1/2-1/2" if winner is None else ("1-0" if winner == "white" else "0-1")
        self.d["result"] = {"winner": winner, "reason": reason, "score": "*" if void else score, "void": void}
        self.d["draw_offer"] = None
        self._log("result", by=None, winner=winner, reason=reason)
        self._changed()

    def abandon(self):
        with self.lock:
            if self.d["status"] != "finished":
                self.finish(None, "abandoned", void=True)

    def tick(self):
        """Flag detection; called by the timer thread and before every action."""
        with self.lock:
            if self.d["status"] != "active" or not self.d["clock"]:
                return
            clk = self.clock_now()
            tc = self.turn_color()
            if clk[tc + "_ms"] <= 0:
                self.d["clock"][tc + "_ms"] = 0
                other_c = other(tc)
                if not self.lawless and self.board.has_insufficient_material(cbool(other_c)):
                    self.finish(None, "timeout vs insufficient material")
                else:
                    self.finish(other_c, "timeout")

    # ---------- player actions ----------
    def parse_move(self, text):
        """Return (kind, uci, san). kind: ok|illegal|parse."""
        s = (text or "").strip()
        b = self.board
        if self.lawless:
            m = UCI_RE.match(s.lower())
            if not m:
                return "parse", None, None
            f = chess.parse_square(m.group(1))
            p = b.piece_at(f)
            if m.group(1) == m.group(2) or p is None or p.color != b.turn:
                return "illegal", None, None
            return "ok", s.lower(), s.lower()
        try:
            if UCI_RE.match(s.lower()):
                s = s.lower()
                p = b.piece_at(chess.parse_square(s[:2]))
                if not s[4:] and p and p.piece_type == chess.PAWN and s[3] in "18":
                    s += "q"
                mv = b.parse_uci(s)
            else:
                mv = b.parse_san(s)
        except chess.IllegalMoveError:
            return "illegal", None, None
        except chess.AmbiguousMoveError:
            return "parse", None, "ambiguous"
        except ValueError:
            return "parse", None, None
        return "ok", b.uci(mv), b.san(mv)

    def submit_move(self, color, text, say=None, offer_draw=False):
        with self.lock:
            self.tick()
            st = self.d["status"]
            if st == "finished":
                return {"ok": False, "code": 4, "reason": "over"}
            if st == "waiting":
                return {"ok": False, "code": 6, "reason": "not_started"}
            if self.turn_color() != color:
                return {"ok": False, "code": 6, "reason": "not_your_turn"}
            kind, uci, san = self.parse_move(text)
            if kind != "ok":
                self._log("illegal", by=color, input=(text or "")[:40], kind=kind)
                cap = self.d["settings"]["max_illegal"]
                n = self.illegal_count(color)
                res = {"ok": False, "code": 1 if kind == "illegal" else 2, "reason": kind, "input": text, "illegal_n": n, "cap": cap, "detail": san}
                if kind == "illegal" and cap >= 0 and n >= cap:
                    self.finish(other(color), "illegal-move limit")
                    res["code"] = 4
                    res["forfeit"] = True
                else:
                    self._changed()
                return res
            if say:
                self._say(color, say)
            now = time.time()
            think = int((now - self.d["turn_started"]) * 1000)
            mover = self.board.turn
            no = self.board.fullmove_number
            self._push(self.board, uci)
            clock = self.d["clock"]
            if clock:
                clock[color + "_ms"] += self.d["settings"]["clock"]["inc_s"] * 1000
            rec = {
                "ply": len(self.d["moves"]) + 1, "no": no, "color": color, "san": san, "uci": uci,
                "fen": self.board.fen(), "think_ms": think, "t": now,
                "clock": dict(clock) if clock else None,
            }
            if self.d["draw_offer"] and self.d["draw_offer"] != color:
                self._log("draw_declined", by=color)
            self.d["draw_offer"] = None
            self.d["moves"].append(rec)
            self.d["turn_started"] = now
            self._log("move", by=color, ply=rec["ply"], san=san, uci=uci, no=no)
            if offer_draw or self.d["offer_armed"] == color:
                self.d["offer_armed"] = None
                self.d["draw_offer"] = color
                self._log("draw_offer", by=color)
            self._check_end(color, mover)
            self._changed()
            return {"ok": True, "code": 0, "san": san, "uci": uci, "no": no, "color": color}

    def _check_end(self, color, mover):
        b = self.board
        if self.lawless:
            if b.king(not mover) is None:
                self.finish(color, "king captured")
            return
        if b.is_checkmate():
            self.finish(color, "checkmate")
        elif b.is_stalemate():
            self.finish(None, "stalemate")
        elif b.is_insufficient_material():
            self.finish(None, "insufficient material")
        elif b.is_fivefold_repetition():
            self.finish(None, "fivefold repetition")
        elif b.is_seventyfive_moves():
            self.finish(None, "75-move rule")

    def _say(self, color, text):
        text = " ".join(str(text).split())[:MAX_SAY]
        if text and self.d["settings"]["messages"]:
            self._log("say", by=color, text=text)
            return True
        return False

    def say(self, color, text):
        with self.lock:
            if not self.d["settings"]["messages"]:
                return {"ok": False, "code": 5}
            ok = self._say(color, text)
            self._changed()
            return {"ok": ok, "code": 0 if ok else 6}

    def resign(self, color):
        with self.lock:
            if self.d["status"] != "active":
                return {"ok": False, "code": 4 if self.d["status"] == "finished" else 6}
            self.finish(other(color), "resignation")
            return {"ok": True, "code": 4}

    def draw(self, color, action):
        with self.lock:
            self.tick()
            if self.d["status"] != "active":
                return {"ok": False, "code": 4 if self.d["status"] == "finished" else 6}
            offer = self.d["draw_offer"]
            if action == "offer":
                self.d["offer_armed"] = color
                self._changed()
                return {"ok": True, "code": 0, "msg": "Draw offer queued; it is sent with your next move."}
            if action == "accept":
                if offer and offer != color:
                    self.finish(None, "agreement")
                    return {"ok": True, "code": 4}
                return {"ok": False, "code": 6, "msg": "There is no draw offer to accept."}
            if action == "decline":
                if offer and offer != color:
                    self.d["draw_offer"] = None
                    self._log("draw_declined", by=color)
                    self._changed()
                    return {"ok": True, "code": 0, "msg": "Draw offer declined."}
                return {"ok": False, "code": 6, "msg": "There is no draw offer to decline."}
            if action == "claim":
                if not self.lawless and self.board.can_claim_draw():
                    self.finish(None, "claimed draw")
                    return {"ok": True, "code": 4}
                return {"ok": False, "code": 6, "msg": "No draw can be claimed."}
            return {"ok": False, "code": 6, "msg": "Unknown draw action."}

    # ---------- inbox ----------
    def pending(self, color):
        """Opponent-visible events not yet delivered to this seat."""
        i = self.d["seats"][color]["delivered"]
        return [e for e in self.d["log"][i:] if e.get("by") == other(color) or e["type"] == "result"]

    def wake_ready(self, color):
        st = self.d["status"]
        return st == "finished" or (st == "active" and self.turn_color() == color)

    def wait(self, color, timeout):
        deadline = time.time() + timeout
        with self.cond:
            self.d["seats"][color]["in_wait"] = True
            try:
                return self._wait(color, deadline)
            finally:
                self.d["seats"][color]["in_wait"] = False
                self.d["seats"][color]["last_seen"] = time.time()

    def _wait(self, color, deadline):
        with self.cond:
            while True:
                self.tick()
                if self.wake_ready(color):
                    return False
                rem = deadline - time.time()
                if rem <= 0:
                    return True
                self.cond.wait(min(rem, 0.5))

    # ---------- snapshots ----------
    def stats(self):
        out = {}
        for c in COLORS:
            mv = [m for m in self.d["moves"] if m["color"] == c]
            th = [m["think_ms"] for m in mv]
            out[c] = {
                "moves": len(mv),
                "illegal": self.illegal_count(c),
                "unparseable": sum(1 for e in self.d["log"] if e["type"] == "illegal" and e["by"] == c and e["kind"] == "parse"),
                "avg_think_ms": int(sum(th) / len(th)) if th else 0,
                "max_think_ms": max(th) if th else 0,
                "restarts": int((self.d["seats"][c].get("spawn") or {}).get("restarts", 0)),
            }
        return out

    def public(self):
        with self.lock:
            d = self.d
            seats = {}
            for c in COLORS:
                s = d["seats"][c]
                seats[c] = {k: s.get(k) for k in ("kind", "name", "claimed", "ready", "agent", "last_seen", "in_wait")}
                sp = s.get("spawn") or {}
                seats[c]["spawn"] = {k: sp.get(k) for k in ("status", "exit_code", "restarts", "session", "started", "stopped_by")} if sp else None
            return {
                "id": d["id"], "version": self.version, "created": d["created"], "status": d["status"],
                "settings": d["settings"], "start_fen": d["start_fen"], "seats": seats,
                "moves": d["moves"], "log": d["log"], "result": d["result"],
                "started": d["started"], "ended": d["ended"],
                "turn": self.turn_color() if d["status"] == "active" else None,
                "fen": self.board.fen(),
                "check": (not self.lawless) and self.board.is_check(),
                "clock": self.clock_now(), "draw_offer": d["draw_offer"],
                "server_time": time.time(), "stats": self.stats(),
            }

    def summary(self):
        p = self.public()
        return {k: p[k] for k in ("id", "created", "status", "settings", "seats", "result", "started", "ended", "stats")} | {"plies": len(p["moves"])}

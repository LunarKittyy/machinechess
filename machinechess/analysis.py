"""Stockfish analysis for viewers: per-position evals, move classes and accuracy. Never shown to players."""
import math
import os
import shutil
import threading

import chess
import chess.engine

from .game import COLORS, other

TIME = float(os.environ.get("MC_ANALYSIS_TIME", "0.8"))
LINES = 3
MATE_CP = 10000
CLASSES = ("best", "excellent", "good", "inaccuracy", "mistake", "blunder")


def eligible(game):
    """Standard rules only. During play it must be AI vs AI; a finished game can always be reviewed."""
    d = game.d
    if d["settings"]["rules"] != "standard":
        return False
    if d["status"] == "finished":
        return not (d["result"] or {}).get("void") or len(d["moves"]) > 0
    return all(d["seats"][c]["kind"] != "human" for c in COLORS)


def state(game):
    if game.d["settings"]["rules"] != "standard":
        return "lawless"
    if not shutil.which("stockfish"):
        return "no-engine"
    return "ok" if eligible(game) else "hidden"


def pov_cp(entry, color):
    """Centipawns from a colour's point of view; mates are large."""
    if entry is None:
        return None
    cp = entry["cp"] if entry.get("mate") is None else (MATE_CP - abs(entry["mate"]) if entry["mate"] > 0 else -MATE_CP + abs(entry["mate"]))
    return cp if color == "white" else -cp


def win_pct(cp):
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * max(-MATE_CP, min(MATE_CP, cp)))) - 1)


def review(game):
    """Classify every analysed move. Returns {plies: {ply: {cls, loss, acc}}, players: {color: summary}}."""
    a = (game.d.get("analysis") or {}).get("plies", {})
    out, per = {}, {c: {"acc": [], "cpl": [], "counts": {k: 0 for k in CLASSES}} for c in COLORS}
    for m in game.d["moves"]:
        p, c = m["ply"], m["color"]
        before, after = a.get(str(p - 1)), a.get(str(p))
        if not before or not after:
            continue
        b, af = pov_cp(before, c), pov_cp(after, c)
        loss = max(0.0, win_pct(b) - win_pct(af))
        top = before["lines"][0]["uci"] if before["lines"] else None
        if top == m["uci"]:
            cls = "best"
        elif loss <= 2:
            cls = "excellent"
        elif loss <= 5:
            cls = "good"
        elif loss <= 10:
            cls = "inaccuracy"
        elif loss <= 20:
            cls = "mistake"
        else:
            cls = "blunder"
        acc = max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss) - 3.1669))
        out[p] = {"cls": cls, "loss": round(loss, 1), "acc": round(acc, 1)}
        per[c]["acc"].append(acc)
        per[c]["cpl"].append(min(1000, max(0, b - af)))
        per[c]["counts"][cls] += 1
    players = {}
    for c in COLORS:
        n = len(per[c]["acc"])
        players[c] = {"accuracy": round(sum(per[c]["acc"]) / n, 1) if n else None, "acpl": round(sum(per[c]["cpl"]) / n) if n else None,
                      "counts": per[c]["counts"], "moves": n}
    return {"plies": out, "players": players}


class Analyzer:
    def __init__(self):
        self.path = shutil.which("stockfish")
        self.engine = None
        self.cv = threading.Condition()
        self.queue = []
        self.games = {}
        self.thread = None

    @property
    def available(self):
        return bool(self.path)

    def consider(self, game):
        """Queue any unanalysed positions of an eligible game. Cheap; called on every game change."""
        if not self.available or not eligible(game):
            return
        with game.lock:
            n = len(game.d["moves"])
            have = (game.d.get("analysis") or {}).get("plies", {})
            missing = [p for p in range(n + 1) if str(p) not in have]
        if not missing:
            return
        with self.cv:
            self.games[game.d["id"]] = game
            for p in missing:
                if (game.d["id"], p) not in self.queue:
                    self.queue.append((game.d["id"], p))
            self.cv.notify()
            if not self.thread:
                self.thread = threading.Thread(target=self.run, daemon=True)
                self.thread.start()

    def pick(self):
        def score(job):
            gid, p = job
            g = self.games[gid]
            live = g.d["status"] == "active"
            return (live and p == len(g.d["moves"]), live, p)
        job = max(self.queue, key=score)
        self.queue.remove(job)
        return job

    def start_engine(self):
        eng = chess.engine.SimpleEngine.popen_uci(self.path)
        eng.configure({"Threads": max(1, (os.cpu_count() or 2) // 2), "Hash": 256})
        self.engine = eng
        return eng

    def run(self):
        while True:
            with self.cv:
                while not self.queue:
                    self.cv.wait()
                gid, p = self.pick()
                game = self.games[gid]
            try:
                self.analyse(game, p)
            except Exception as e:
                print("analysis failed:", repr(e), flush=True)
                try:
                    self.engine and self.engine.quit()
                except Exception:
                    pass
                self.engine = None

    def analyse(self, game, p):
        with game.lock:
            moves = game.d["moves"]
            if p > len(moves):
                return
            fen = moves[p - 1]["fen"] if p else game.d["start_fen"]
            c960 = game.d["settings"]["chess960"] is not None
        board = chess.Board(fen, chess960=c960)
        if board.is_game_over(claim_draw=False):
            res = board.result()
            entry = {"cp": 0 if res == "1/2-1/2" else None, "mate": None, "depth": 0, "lines": [], "terminal": True}
            if res != "1/2-1/2":
                entry["cp"] = MATE_CP if res == "1-0" else -MATE_CP
        else:
            eng = self.engine or self.start_engine()
            infos = eng.analyse(board, chess.engine.Limit(time=TIME), multipv=LINES)
            lines = []
            for info in infos:
                sc = info["score"].white()
                pv = info.get("pv", [])
                b2, sans = board.copy(), []
                for mv in pv[:8]:
                    sans.append(b2.san(mv))
                    b2.push(mv)
                lines.append({"uci": board.uci(pv[0]) if pv else None, "san": sans[0] if sans else None, "cp": sc.score() if not sc.is_mate() else None,
                              "mate": sc.mate() if sc.is_mate() else None, "pv": sans, "depth": info.get("depth")})
            top = lines[0]
            entry = {"cp": top["cp"], "mate": top["mate"], "depth": top["depth"], "lines": lines}
        with game.lock:
            an = game.d.setdefault("analysis", {"engine": "Stockfish", "time": TIME, "plies": {}})
            an["plies"][str(p)] = entry
            game._changed()

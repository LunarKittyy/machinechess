import json
import os
import threading
from pathlib import Path

from .game import Game

DIR = Path(__file__).resolve().parent.parent / "data" / "games"


class Store:
    def __init__(self):
        DIR.mkdir(parents=True, exist_ok=True)
        self.games = {}
        self.on_change = None
        self.lock = threading.Lock()
        for f in sorted(DIR.glob("*.json")):
            try:
                d = json.loads(f.read_text())
                g = Game(d, self.save)
                if g.d["status"] != "finished":
                    g.d["status"] = "finished"
                    g.d["result"] = {"winner": None, "reason": "abandoned (server restart)", "score": "*", "void": True}
                    g.d["ended"] = g.d["ended"] or g.d["created"]
                self.games[d["id"]] = g
            except Exception as e:
                print("skip", f, e)

    def save(self, game):
        tmp = DIR / f".{game.d['id']}.tmp"
        tmp.write_text(json.dumps(game.d))
        os.replace(tmp, DIR / f"{game.d['id']}.json")
        if self.on_change:
            self.on_change(game)

    def add(self, game):
        game.on_change = self.save
        with self.lock:
            self.games[game.d["id"]] = game
        self.save(game)

    def get(self, gid):
        return self.games.get(gid)

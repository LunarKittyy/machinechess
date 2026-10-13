import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from machinechess.game import Game
from machinechess import seatview as sv

def mk(**s):
    g = Game.create(s, {"white": {"kind": "agent"}, "black": {"kind": "agent"}})
    g.ready("white"); g.ready("black")
    return g

g = mk()
print(sv.view(g, "white")["text"]); print("----")
print(g.submit_move("white", "e4")); print(g.submit_move("white", "e5")["reason"])
print(sv.view(g, "black")["text"]); print("----")
for m in ["Qh5", "Nd2", "zz", "e7e5", "0-0"]:
    r = g.submit_move("black", m); print(m, r["code"], r.get("reason"))
    if r["ok"]: break
print(sv.reject_text(g, "black", {"reason":"illegal","input":"Qh5","illegal_n":1,"cap":3}))
# fool's mate
g = mk()
for c, m in [("white","f3"),("black","e5"),("white","g4"),("black","Qh4")]:
    r = g.submit_move(c, m)
print(r, g.d["result"]); print(sv.view(g, "white")["text"])
# cap
g = mk(max_illegal=2)
g.submit_move("white","Ke2"); r=g.submit_move("white","Ke3"); print(r["code"], g.d["result"])
# lawless
g = mk(rules="lawless", board_mode="never")
print(sv.view(g,"white")["text"])
print(g.submit_move("white","e1e8")["ok"], g.submit_move("white","e7e5")["reason"] if False else "")
r=g.submit_move("black","e8e1"); print(r)
print(g.d["result"]); print(sv.view(g,"black")["text"])
# clock
g = mk(clock={"base_s":1,"inc_s":0}); time.sleep(1.2); g.tick(); print(g.d["result"])
# reload
g = mk(); g.submit_move("white","e4"); g2 = Game(g.d); print(g2.board.fen())
g = mk(chess960="random"); print(g.d["start_fen"])

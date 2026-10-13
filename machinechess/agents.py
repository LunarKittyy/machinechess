"""Launching LLM CLIs as players."""
import json
import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import transcripts

ROOT = Path(__file__).resolve().parent.parent
GUIDE = (Path(__file__).parent / "guide.md").read_text()
BIN = ROOT / "bin"
GAMES = ROOT / "data" / "games"
GRACE = float(os.environ.get("MC_AGENT_GRACE", "120"))
PROCS = {}
TERMED = {}
_cache = {}


def cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        val = fn()
    except Exception:
        val = []
    _cache[key] = (time.time(), val)
    return val


def run_lines(cmd, timeout=20):
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    return [l for l in out.splitlines() if l.strip()]


def claude_models():
    return [{"id": i, "label": l} for i, l in (("fable", "Fable"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku"))]


def codex_models():
    def go():
        d = json.loads(subprocess.run(["codex", "debug", "models"], capture_output=True, text=True, timeout=20).stdout)
        ms = d.get("models", d) if isinstance(d, dict) else d
        out = []
        for m in ms:
            if m.get("visibility") != "list":
                continue
            ef = [e["effort"] for e in m.get("supported_reasoning_levels", []) if e["effort"] != "ultra"]
            out.append({"id": m["slug"], "label": m.get("display_name", m["slug"]), "efforts": ef})
        return out
    return cached("codex", 600, go)


def agy_models():
    def go():
        out = []
        for l in run_lines(["agy", "models"]):
            if "\t" in l:
                i, label = l.split("\t", 1)
                out.append({"id": i.strip(), "label": label.strip()})
        return out
    return cached("agy", 600, go)


def opencode_models():
    def go():
        return [{"id": l.strip(), "label": l.strip()} for l in run_lines(["opencode", "models"]) if "/" in l]
    return cached("opencode", 600, go)


AGENTS = {
    "claude": {"label": "Claude Code", "models": claude_models, "efforts": ["low", "medium", "high", "xhigh", "max"], "subagent_control": True, "custom_model": True},
    "codex": {"label": "Codex", "models": codex_models, "efforts": ["low", "medium", "high", "xhigh", "max"], "subagent_control": True, "custom_model": True},
    "agy": {"label": "Antigravity (agy)", "models": agy_models, "efforts": [], "subagent_control": False, "custom_model": True},
    "opencode": {"label": "opencode", "models": opencode_models, "efforts": ["minimal", "low", "medium", "high", "max"], "subagent_control": False, "custom_model": True},
}


def catalog():
    out = []
    for aid, a in AGENTS.items():
        if not shutil.which(aid):
            continue
        out.append({"id": aid, "label": a["label"], "models": a["models"](), "efforts": a["efforts"],
                    "subagent_control": a["subagent_control"], "custom_model": a["custom_model"]})
    return out


def identity(spec):
    """Stable display name, used for leaderboards."""
    model = spec.get("model") or "default"
    parts = [model] if model.startswith(spec["id"] + "/") else [spec["id"], model]
    if spec.get("effort"):
        parts.append(spec["effort"])
    if spec.get("subagents"):
        parts.append("subagents")
    return " / ".join(parts)


def prompt_for(spec, wait_s, cwd, rematch=False):
    guide = GUIDE
    if spec.get("subagents"):
        guide = guide.replace("- NO SUBAGENT SPAWNING ALLOWED. Do not delegate to other agents, models or sessions.\n",
                              "- Subagents are allowed for this game, as an explicit exception.\n")
    intro = "A NEW game starts now (a rematch). Your earlier game is over. Read the rules the command prints: they may differ from last time.\n\n" if rematch else ""
    return (
        intro
        + f"The chess command is `{cwd / 'chess'}`. Wherever the guide below says `chess`, run exactly that path, from any directory.\n"
        f"It may block up to {wait_s} seconds while waiting for the opponent: if your shell tool has a timeout, set it above {wait_s + 20} seconds.\n\n"
        + guide + "\nBegin now with `chess wait`.\n"
    )


def build_command(spec, cwd, prompt, session=None):
    """Return (argv, stdin_text). `session` resumes an earlier conversation of the same CLI."""
    aid, model, effort = spec["id"], spec.get("model"), spec.get("effort")
    sub = bool(spec.get("subagents"))
    if aid == "claude":
        argv = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
                "--tools", "Bash,Agent" if sub else "Bash", "--strict-mcp-config", "--disable-slash-commands"]
        if session:
            argv += ["--resume", session]
        if model:
            argv += ["--model", model]
        if effort:
            argv += ["--effort", effort]
        return argv, prompt
    if aid == "codex":
        net = ["-c", "sandbox_workspace_write.network_access=true", "-c", 'web_search="disabled"', "-c", f"features.multi_agent={'true' if sub else 'false'}"]
        if session:
            argv = ["codex", "exec", "resume", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"'] + net
        else:
            argv = ["codex", "exec", "--skip-git-repo-check", "-C", str(cwd), "-s", "workspace-write"] + net
        if model:
            argv += ["-m", model]
        if effort:
            argv += ["-c", f'model_reasoning_effort="{effort}"']
        return argv + ([session, "-"] if session else ["-"]), prompt
    if aid == "agy":
        argv = ["agy", "--dangerously-skip-permissions", "--print-timeout", "720h", "--output-format", "stream-json"]
        if session:
            argv += ["--conversation", session]
        if model:
            argv += ["--model", model]
        return argv + ["-p", prompt], None
    if aid == "opencode":
        argv = ["opencode", "run", "--auto", "--format", "json", "--dir", str(cwd)]
        if session:
            argv += ["--session", session]
        if model:
            argv += ["--model", model]
        if effort:
            argv += ["--variant", effort]
        return argv + [prompt], None
    raise ValueError(f"unknown agent {aid}")


def transcript_path(gid, color):
    return GAMES / f"{gid}.{color}.transcript.jsonl"


def read_transcript(gid, color, after=-1):
    p = transcript_path(gid, color)
    out = []
    if p.exists():
        for line in p.read_text().splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e["n"] > after:
                out.append(e)
    return out


def import_legacy_logs(game):
    """Games recorded before transcripts existed: rebuild transcript files from the raw CLI log."""
    for color in ("white", "black"):
        seat = game.d["seats"][color]
        raw = ROOT / "data" / "logs" / f"{game.d['id']}-{color}.log"
        if seat["kind"] != "agent" or transcript_path(game.d["id"], color).exists() or not raw.exists():
            continue
        parser = transcripts.for_cli(seat["agent"]["id"])
        entries = []
        for line in raw.read_text(errors="replace").splitlines():
            entries += parser.feed(line + "\n")
        entries += parser.flush()
        t0 = game.d["started"] or game.d["created"]
        with open(transcript_path(game.d["id"], color), "w") as f:
            for i, e in enumerate(entries):
                e.update(n=i, t=t0, ply=None)
                f.write(json.dumps(e) + "\n")
        if parser.session and seat.get("spawn"):
            seat["spawn"]["session"] = parser.session


def spawn(game, color, base_url, wait_s=100):
    """Start the agent process for a seat; its output is parsed into the seat's transcript."""
    seat = game.d["seats"][color]
    spec = seat["agent"]
    resume = seat.get("resume") or {}
    cwd = Path(resume["workdir"]) if resume.get("workdir") else ROOT / "runs" / game.d["id"] / color
    cwd.mkdir(parents=True, exist_ok=True)
    (cwd / ".chess").write_text(json.dumps({"url": base_url, "game": game.d["id"], "token": seat["token"], "wait_s": wait_s}))
    wrapper = cwd / "chess"
    wrapper.write_text(f'#!/bin/sh\nexec "{BIN / "chess"}" --conf "{cwd / ".chess"}" "$@"\n')
    wrapper.chmod(0o755)
    sp = seat.get("spawn") or {}
    session = sp.get("session") or resume.get("session")
    argv, stdin_text = build_command(spec, cwd, prompt_for(spec, wait_s, cwd, rematch=bool(session) and not sp), session)
    log = open(ROOT / "data" / "logs" / f"{game.d['id']}-{color}.log", "ab")
    env = dict(os.environ, PATH=f"{BIN}:{os.environ.get('PATH', '')}")
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    seat["spawn"] = {"status": "running", "exit_code": None, "restarts": sp.get("restarts", -1) + 1 if sp else 0, "pid": proc.pid,
                     "started": time.time(), "workdir": str(cwd), "session": session, "stopped_by": None}
    PROCS[(game.d["id"], color)] = proc
    if stdin_text is not None:
        try:
            proc.stdin.write(stdin_text.encode())
            proc.stdin.close()
        except BrokenPipeError:
            pass
    threading.Thread(target=pump, args=(game, color, proc, log), daemon=True).start()
    return proc


def pump(game, color, proc, log):
    seat = game.d["seats"][color]
    sp = seat["spawn"]
    parser = transcripts.for_cli(seat["agent"]["id"])
    path = transcript_path(game.d["id"], color)
    n = sum(1 for _ in open(path)) if path.exists() else 0

    def write(entries):
        nonlocal n
        if not entries:
            return
        with open(path, "a") as f:
            for e in entries:
                e.update(n=n, t=time.time(), ply=len(game.d["moves"]))
                f.write(json.dumps(e) + "\n")
                n += 1
        if parser.session and sp.get("session") != parser.session:
            with game.lock:
                sp["session"] = parser.session
                game._changed()

    for raw in iter(proc.stdout.readline, b""):
        log.write(raw)
        log.flush()
        write(parser.feed(raw.decode(errors="replace")))
    write(parser.flush())
    code = proc.wait()
    if PROCS.get((game.d["id"], color)) is proc:
        PROCS.pop((game.d["id"], color), None)
    with game.lock:
        sp["status"] = "stopped" if sp.get("stopped_by") else "exited"
        sp["exit_code"] = code
        game._log("agent_exit", by=None, color=color, code=code)
        game._changed()


def terminate(key, why):
    proc = PROCS.get(key)
    if not proc or proc.poll() is not None:
        return
    TERMED[key] = time.time()
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass


def kill(game, color, why="abandoned"):
    seat = game.d["seats"][color]
    if seat.get("spawn"):
        seat["spawn"]["stopped_by"] = why
    terminate((game.d["id"], color), why)


def kill_all():
    for key, proc in list(PROCS.items()):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def kill_orphans(game):
    """After a server restart: stop agent processes recorded by a previous run of this game."""
    for color in ("white", "black"):
        pid = ((game.d["seats"][color].get("spawn") or {}).get("pid"))
        if not pid:
            continue
        try:
            if str(ROOT / "runs") in os.readlink(f"/proc/{pid}/cwd"):
                os.killpg(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass


def reaper(get_game):
    """Close agent sessions that outlive their game. Most exit on their own within seconds; this catches the rest."""
    while True:
        time.sleep(3)
        now = time.time()
        for key, proc in list(PROCS.items()):
            game = get_game(key[0])
            if proc.poll() is not None or not game:
                continue
            if key in TERMED:
                if now - TERMED[key] > 8:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                continue
            if game.d["status"] == "finished" and now - (game.d["ended"] or now) > GRACE:
                game.d["seats"][key[1]]["spawn"]["stopped_by"] = "grace period"
                terminate(key, "grace")

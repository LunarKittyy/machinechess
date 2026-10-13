"""Turn each agent CLI's output into one normalised transcript.

Entry: {n, t, ply, kind, text, tool?, id?, code?, ms?}
kind: text (assistant prose) | thinking | tool (a command) | result (its output) | system | raw
"""
import json
import re

BOLD = re.compile(r"^\*\*(.+)\*\*\s*$")


def clean_cmd(cmd):
    m = re.match(r"^(?:/\S*/)?(?:ba|z)?sh -lc '(.*)'$", cmd.strip(), re.S)
    return m.group(1) if m else cmd.strip()


class Parser:
    """Feed lines; get back finished entries. `session` is filled in when the CLI reveals its session id."""

    def __init__(self):
        self.session = None

    def feed(self, line):
        return [{"kind": "raw", "text": line}] if line.strip() else []

    def flush(self):
        return []


class Plain(Parser):
    pass


class Claude(Parser):
    def feed(self, line):
        try:
            ev = json.loads(line)
        except ValueError:
            return Parser.feed(self, line)
        t, out = ev.get("type"), []
        if t == "system" and ev.get("subtype") == "init":
            self.session = ev.get("session_id")
            out.append({"kind": "system", "text": f"Claude Code session started ({ev.get('model', '')})".strip()})
        elif t == "assistant":
            for b in ev.get("message", {}).get("content", []):
                if b.get("type") == "text" and b.get("text", "").strip():
                    out.append({"kind": "text", "text": b["text"].strip()})
                elif b.get("type") == "thinking" and b.get("thinking", "").strip():
                    out.append({"kind": "thinking", "text": b["thinking"].strip()})
                elif b.get("type") == "tool_use":
                    inp = b.get("input", {})
                    out.append({"kind": "tool", "tool": b.get("name", "tool"), "id": b.get("id"), "text": inp.get("command") or json.dumps(inp)})
        elif t == "user":
            c = ev.get("message", {}).get("content", [])
            for b in c if isinstance(c, list) else []:
                if b.get("type") == "tool_result":
                    body = b.get("content")
                    if isinstance(body, list):
                        body = "\n".join(x.get("text", "") for x in body if isinstance(x, dict))
                    out.append({"kind": "result", "id": b.get("tool_use_id"), "text": str(body or "").strip(), "code": 1 if b.get("is_error") else 0})
        elif t == "result":
            self.session = ev.get("session_id") or self.session
            out.append({"kind": "system", "text": f"Finished: {ev.get('subtype', 'done')}, {ev.get('num_turns', '?')} turns" + (f", ${ev['total_cost_usd']:.3f}" if ev.get("total_cost_usd") else "")})
        return out


class OpenCode(Parser):
    def feed(self, line):
        try:
            ev = json.loads(line)
        except ValueError:
            return Parser.feed(self, line)
        self.session = ev.get("sessionID") or self.session
        part, t, out = ev.get("part", {}), ev.get("type"), []
        if t == "text" and part.get("text", "").strip():
            out.append({"kind": "text", "text": part["text"].strip()})
        elif t in ("reasoning", "thinking") and part.get("text", "").strip():
            out.append({"kind": "thinking", "text": part["text"].strip()})
        elif t == "tool_use":
            st = part.get("state", {})
            cid = part.get("callID")
            inp = st.get("input", {})
            out.append({"kind": "tool", "tool": part.get("tool", "tool"), "id": cid, "text": inp.get("command") or json.dumps(inp)})
            if st.get("status") in ("completed", "error"):
                out.append({"kind": "result", "id": cid, "text": str(st.get("output", "")).strip(), "code": 0 if st.get("status") == "completed" else 1})
        return out


class Agy(Parser):
    def feed(self, line):
        try:
            ev = json.loads(line)
        except ValueError:
            return [{"kind": "text", "text": line.strip()}] if line.strip() else []
        out = []
        if ev.get("event") == "init":
            self.session = ev.get("conversation_id")
            out.append({"kind": "system", "text": f"Antigravity session started ({ev.get('init', {}).get('model', '')})"})
        elif ev.get("event") == "step_update":
            s = ev["step_update"]
            if s.get("state") != "DONE":
                return out
            if s.get("step_type") == "agent_response" and s.get("text_delta", "").strip():
                out.append({"kind": "text", "text": s["text_delta"].strip()})
            elif s.get("step_type") == "tool":
                info = s.get("tool_info", {})
                params = info.get("parameters", {})
                cid = f"{s.get('step_index')}"
                out.append({"kind": "tool", "tool": info.get("name", "tool"), "id": cid, "text": params.get("CommandLine") or json.dumps(params)})
                out.append({"kind": "result", "id": cid, "text": str(info.get("output", "")).replace("\r\n", "\n").strip(), "code": 0})
        elif ev.get("event") == "result":
            r = ev["result"]
            self.session = r.get("conversation_id") or self.session
            out.append({"kind": "system", "text": f"Finished: {r.get('status', 'done')}, {r.get('num_turns', '?')} turns"})
        return out


class Codex(Parser):
    """Parses `codex exec` text output: header, `codex` / `exec` / `user` markers, bold reasoning titles."""
    MARKERS = ("user", "codex", "exec", "tokens used")

    def __init__(self):
        super().__init__()
        self.state, self.dashes, self.buf, self.meta, self.n = "header", 0, [], {}, 0

    def _emit(self):
        out, text = [], "\n".join(self.buf).strip()
        st = self.state
        if st == "codex" and text:
            out.append({"kind": "text", "text": text})
        elif st == "think" and text:
            out.append({"kind": "thinking", "text": text})
        elif st == "out":
            out.append({"kind": "result", "id": self.meta.get("id"), "text": text, "code": self.meta.get("code"), "ms": self.meta.get("ms")})
        self.buf = []
        return out

    def flush(self):
        out = self._emit()
        self.state = "idle"
        return out

    def feed(self, line):
        line = line.rstrip("\n")
        out = []
        if self.state == "header":
            if line.startswith("session id:"):
                self.session = line.split(":", 1)[1].strip()
            if line.strip() == "--------":
                self.dashes += 1
                if self.dashes == 2:
                    self.state = "idle"
                    out.append({"kind": "system", "text": "Codex session started" + (f" ({self.meta.get('model')})" if self.meta.get("model") else "")})
            elif line.startswith("model:"):
                self.meta["model"] = line.split(":", 1)[1].strip()
            return out
        if line in self.MARKERS:
            out += self._emit()
            self.state = {"user": "user", "codex": "codex", "exec": "cmd", "tokens used": "tokens"}[line]
            return out
        if self.state == "cmd":
            m = re.match(r"^(.*) in (/\S*)$", line)
            self.n += 1
            self.meta = {"id": f"c{self.n}"}
            out.append({"kind": "tool", "tool": "shell", "id": self.meta["id"], "text": clean_cmd(m.group(1) if m else line)})
            self.state = "wait"
            return out
        b = BOLD.match(line)
        if self.state == "wait" and b:
            return [{"kind": "thinking", "text": b.group(1)}]
        if self.state in ("out", "codex", "think", "idle") and b:
            out += self._emit()
            self.state = "think"
            self.buf = [b.group(1)]
            return out
        if self.state == "wait":
            m = re.match(r"^\s*(succeeded|exited (\d+)|failed)\s+in\s+(\d+)ms:?", line)
            if m:
                self.meta.update(code=0 if m.group(1) == "succeeded" else int(m.group(2) or 1), ms=int(m.group(3)))
                self.state = "out"
            return out
        if self.state in ("out", "codex", "think"):
            self.buf.append(line)
        return out


PARSERS = {"claude": Claude, "codex": Codex, "opencode": OpenCode, "agy": Agy}


def for_cli(cli):
    return PARSERS.get(cli, Plain)()

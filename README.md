# machine chess

A chess arena for benchmarking LLMs. Agents play through a bash CLI, people watch and play in a website. Nothing helps the players: no legal move lists, no hints, illegal moves are refused without a reason.

## Run

    ./run.sh            # http://127.0.0.1:8765, creates .venv on first run (needs the `chess` PyPI package)
    ln -s "$PWD/bin/chess" ~/.local/bin/chess    # optional, so agents can type `chess`

Open the site, press New game, pick who plays each side:

- **Human**: you play in the browser. No move highlighting.
- **LLM agent**: the server spawns an installed CLI (claude, codex, agy, opencode) with a prompt and a working directory. Model and effort are dropdowns, subagents are off unless ticked.
- **Open seat**: you get a `chess join <id> --color white` command to give any agent with a shell.

## Game options

| Option | Values |
| --- | --- |
| Rules | standard, or lawless (any move of your own piece is accepted, king capture ends the game) |
| Board feedback | every turn, on request (`chess board`), never (memory test) |
| Illegal move limit | -1 for no limit, otherwise that attempt forfeits |
| Clock | off by default; base minutes plus increment, thinking time counts |
| Messages | agents can `chess say` to each other, delivered with the next move |
| Start | standard, Chess960, custom FEN |

## The agent CLI

    chess wait                 block until it is your turn (exit 3 = timed out, call again)
    chess move Nf3 --say "hi"  play, then block for the reply: one call per turn
    chess board | history | say | draw offer|accept|decline|claim | resign

Exit codes: 0 ok, 1 illegal, 2 not understood, 3 timed out, 4 game over, 5 disabled, 6 other.

## Analysis (viewer only)

Stockfish analyses AI vs AI games while they are played and any finished game: an eval bar, the engine's top three lines drawn as arrows on the board, an eval graph, per-move classes (best, excellent, good, inaccuracy `?!`, mistake `?`, blunder `??`), accuracy and average centipawn loss per player, and a key moments list. The leaderboard gets accuracy and blunders per game from it.

Players never see any of it. While a human is playing the server refuses to serve analysis, and it unlocks when the game ends. Lawless games are not analysed. Needs `stockfish` on PATH (`dnf install stockfish`).

## Transcripts and sessions

Each agent's output is parsed into a transcript (reasoning, commands, command output) and saved next to the game as `data/games/<id>.<color>.transcript.jsonl`; the raw CLI output stays in `data/logs/`. The Transcript tab groups it by move, shows retries after illegal attempts, and jumps the board when you click a move.

Agent CLI processes are not kept open. Most exit by themselves when the game ends; anything left is closed after `MC_AGENT_GRACE` seconds (default 120), on abandon, when the server stops, and orphans from a crashed server are killed on the next start. The header shows how many agents are running, with a close button each. Each CLI's conversation stays saved on disk, so Rematch can either start agents fresh (default, fair) or continue their old conversation so they remember the game. There is no manual compaction: the CLIs compact their own context when it fills.

## Data

Every game is stored whole in `data/games/<id>.json` (settings, every move with FEN, think time and clocks, messages, illegal attempts, result). The site replays them, the leaderboard reads them, `/api/games/<id>/pgn` exports PGN.

## Limits worth knowing

- Agents run on your machine with shell access. The prompt forbids subagents, web, engines and scripts, and the claude/codex launchers also restrict tools where the CLI allows it, but a determined agent could still cheat.
- If an agent process exits mid-game, restart it from the Game tab: it resumes the same CLI conversation and the restart is counted in the stats.
- Restarting the server marks unfinished games as abandoned.

## Tailnet access

The server listens on `127.0.0.1` and, if `tailscale` is installed, on this machine's tailscale IPv4 as well, so the site opens at `http://<tailscale-ip>:8765` from any device on the tailnet. Set `MC_BIND` to a comma list of addresses to override (empty means localhost only). Anyone who can reach it can start agents with shell access.

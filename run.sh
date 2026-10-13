#!/usr/bin/env bash
# start the machine-chess server (creates the venv on first run)
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
exec .venv/bin/python -c "
import sys
from machinechess.server import main
main(port=int(sys.argv[1]) if len(sys.argv) > 1 else 8765)
" "$@"

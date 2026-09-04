#!/usr/bin/env python3
from __future__ import annotations

import faulthandler
import logging
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _bootstrap_windows_gui():
    """Run before importing Qt/qfluentwidgets so relative config is always writable."""
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return None
    state = Path(base) / "nai-terminal-gui"
    state.mkdir(parents=True, exist_ok=True)
    os.chdir(state)
    os.environ["NAI_GUI_STATE_DIR"] = str(state)
    log_path = state / "gui.log"
    stream = open(log_path, "a", encoding="utf-8", buffering=1)
    sys.stderr = stream
    logging.basicConfig(stream=stream, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", force=True)
    faulthandler.enable(stream)

    def excepthook(exc_type, exc, tb):
        logging.error("GUI 未捕获异常", exc_info=(exc_type, exc, tb))

    sys.excepthook = excepthook
    return stream


_LOG_STREAM = _bootstrap_windows_gui()

from nai_terminal.gui.app import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

"""python3 -m nai_terminal 入口：server(HTTP)+worker 双线程 + 单实例锁（SPEC §三）。

单实例锁 = fcntl.flock 独占 data/terminal/worker.lock（防两个 worker 同时写执行态）。
--once：起服务 + 自查一次 GET /v1/queue（真 HTTP）后干净退出（冒烟/测试用）。
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import signal
import sys
import threading
import urllib.request

from . import db as dbm
from . import server as srv
from . import worker as wk
from .gui_store import validate_gui_owner_lease


class SingleInstanceLock:
    def __init__(self, path):
        self.path = path
        self._fd = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fd = open(self.path, "w")
        try:
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            self._fd.close()
            self._fd = None
            return False

    def release(self) -> None:
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                self._fd.close()
                self._fd = None


def _self_check_queue(port: int, token: str) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/queue",
        headers={"Authorization": "Bearer " + token, "Host": f"127.0.0.1:{port}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python3 -m nai_terminal",
                                 description="NAI 出图终端 期一（队列内核）")
    ap.add_argument("--port", type=int, default=None, help="覆盖端口（默认 8747 / NAI_TERMINAL_PORT）")
    ap.add_argument("--config", default=None, help="nai_config.json 路径（可注入，测试用）")
    ap.add_argument("--data-dir", default=None, help="运行数据目录（默认 data/terminal，可注入）")
    ap.add_argument("--once", action="store_true", help="起服务+自查 GET /v1/queue 后干净退出（冒烟）")
    args = ap.parse_args(argv)

    if not args.once:
        owner_lease = os.environ.get("NAI_TERMINAL_GUI_OWNER_LEASE", "")
        owner_token = os.environ.get("NAI_TERMINAL_GUI_OWNER_TOKEN", "")
        if not validate_gui_owner_lease(owner_lease, owner_token):
            print("✗ 正式终端只能由 NAI 出图终端窗口的「启动」按钮创建", file=sys.stderr)
            return 2

    ctx = dbm.load_context(args.config, args.data_dir)

    lock = SingleInstanceLock(ctx.worker_lock)
    if not lock.acquire():
        print("✗ 已有终端实例在运行（worker.lock 被占）", file=sys.stderr)
        return 1

    httpd = srv.make_server(ctx, args.port)
    port = httpd.server_address[1]
    worker = wk.Worker(ctx)

    http_thread = threading.Thread(target=httpd.serve_forever, name="nai-terminal-http", daemon=True)

    stop_flag = threading.Event()

    def _shutdown(*_a):
        stop_flag.set()

    try:
        worker.start()
        http_thread.start()
        print(f"NAI 出图终端已启动 http://127.0.0.1:{port}  token={ctx.token_path}")

        if args.once:
            summary = _self_check_queue(port, httpd.token)
            print("GET /v1/queue ->", json.dumps(summary, ensure_ascii=False))
        else:
            signal.signal(signal.SIGINT, _shutdown)
            signal.signal(signal.SIGTERM, _shutdown)
            stop_flag.wait()
    finally:
        worker.stop()
        httpd.shutdown()
        httpd.server_close()
        worker.join(timeout=5)
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())

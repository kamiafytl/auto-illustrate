"""受管服务的 Linux 侧启动垫片（GUI 一键启动用，不经任何 shell）。

GUI 在 Windows 侧只做一件事：`wsl.exe -d <distro> -- python3 -u <本文件> <服务名> --root <仓库根>`。
其余全在 Linux 侧、纯 argv 完成，**没有一层 shell 引号**。

为什么要这个垫片（2026-07-14 实测根因，别再退回 shell 版）：
1. 旧版把服务包在 `bash -lc "... exec setsid bash -c 'printf $$ ...'"` 里。跨 wsl.exe 传递时
   引号边界会移位，`$$` 实际被**外层 bash** 展开——GUI 记下的是 setsid 自己的 PID，而真正的
   服务被 setsid fork 到**另一个进程组**。按 PID 停止因此从来打不到服务。
2. 旧版用的是 `setsid`（无 -w）：父进程立刻退出 → wsl.exe 秒退 → QProcess 以为服务"已结束"，
   日志管道断、退出码丢失、探活重试又拉起第二份撞端口。

垫片的做法：先 setsid 自立门户（本进程 = 会话/进程组组长），把自己的 PID 报给 GUI，再
作为守护父进程启动服务。守护进程与服务同组，日志与退出码沿 wsl.exe 直通，停止按组精确
命中；同时持续检查 GUI 心跳租约。即使 Windows GUI 原生崩溃、来不及走 closeEvent，租约
超时后也会主动停止服务，不留下占端口的孤儿后台。
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time

# 直接执行本文件时（GUI 正是如此），仓库根不在 sys.path 里。
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nai_terminal.gui_store import (MANAGED_PID_PREFIX, managed_service_spec,
                                    stop_managed_group, validate_gui_owner_lease)


def _run_owned_service(service: str, root: str, owner_lease: str,
                       owner_token: str) -> int:
    """Run a service under a lease-watching process-group guardian."""
    if not validate_gui_owner_lease(owner_lease, owner_token):
        sys.stderr.write("GUI ownership lease is missing, stale, or invalid\n")
        return 6

    spec = managed_service_spec(service, root)
    try:
        os.chdir(spec["cwd"])
    except OSError as error:
        sys.stderr.write(f"无法进入工作目录 {spec['cwd']}：{error}\n")
        return 3

    env = dict(os.environ)
    env.update(spec["env"])
    env["NAI_TERMINAL_GUI_OWNER_LEASE"] = owner_lease
    env["NAI_TERMINAL_GUI_OWNER_TOKEN"] = owner_token
    try:
        child = subprocess.Popen(spec["argv"], env=env)
    except OSError as error:
        sys.stderr.write(f"无法启动 {spec['argv'][0]}：{error}\n")
        return 4

    requested_signal: int | None = None

    def request_stop(signum, _frame):
        nonlocal requested_signal
        requested_signal = signum
        if child.poll() is None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass

    previous_handlers = {
        signal.SIGINT: signal.getsignal(signal.SIGINT),
        signal.SIGTERM: signal.getsignal(signal.SIGTERM),
    }
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        lease_failed_at: float | None = None
        while child.poll() is None:
            if not validate_gui_owner_lease(owner_lease, owner_token):
                if lease_failed_at is None:
                    lease_failed_at = time.monotonic()
                    sys.stderr.write("GUI owner disappeared; stopping managed service\n")
                    sys.stderr.flush()
                    request_stop(signal.SIGTERM, None)
                elif time.monotonic() - lease_failed_at >= 5.0:
                    child.kill()
            elif requested_signal is None:
                lease_failed_at = None
            time.sleep(0.25)
        return int(child.returncode or 0)
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NAI 出图终端受管服务启动垫片")
    sub = parser.add_subparsers(dest="mode", required=True)
    run = sub.add_parser("run", help="启动一个受管服务")
    run.add_argument("service", choices=("worker", "vite"))
    run.add_argument("--root", required=True, help="仓库根（WSL 路径）")
    run.add_argument("--owner-lease", required=True, help="GUI 所有权租约路径")
    run.add_argument("--owner-token", required=True, help="GUI 所有权会话标识")
    stop = sub.add_parser("stop", help="按进程组精确停止一个受管服务")
    stop.add_argument("--pid", type=int, required=True)
    stop.add_argument("--signature", required=True)
    stop.add_argument("--signal", choices=("TERM", "KILL"), default="TERM")
    args = parser.parse_args(argv)

    if args.mode == "stop":
        code = stop_managed_group(args.pid, args.signature, args.signal)
        if code == 3:
            sys.stderr.write("managed process identity mismatch\n")
        return code

    # 不变式：pgid == pid（本进程 = 进程组组长），停止才能按组精确终止且不误伤别人。
    # wsl.exe 起的进程通常已经是会话/组长（此时 setsid 会 EPERM），那就什么都不用做。
    if os.getpgid(0) != os.getpid():
        try:
            os.setsid()
        except OSError:
            os.setpgrp()
    if os.getpgid(0) != os.getpid():
        sys.stderr.write("无法成为进程组组长，拒绝以不可精确停止的方式启动服务\n")
        return 5

    sys.stdout.write(f"{MANAGED_PID_PREFIX}{os.getpid()}\n")
    sys.stdout.flush()
    return _run_owned_service(args.service, args.root,
                              args.owner_lease, args.owner_token)


if __name__ == "__main__":
    raise SystemExit(main())

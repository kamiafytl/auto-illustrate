"""一键启动的 Windows 侧回归验证：无窗口跑一遍「一键启动 → 就绪 → 停止」。

走的正是 Owner 点按钮时的代码路径（QProcess → wsl.exe → `nai_terminal/managed_launch.py`
垫片 → HTTP 探活 → 按进程组精确停止），只是不开窗口。**改动 gui_store 的受管命令、
process_supervisor 或启动垫片后必须跑它**——WSL 里 Qt 测试全部 skip，这是唯一能自动验证
启动器真能起来、也真能停掉的手段。不读私密数据，不提交 NAI。

用法（Windows Python；仓库经 UNC 可见）：
    $env:PYTHONUTF8='1'; python tools\\verify_terminal_launcher.py
退出码 0 = 启动与停止都成功。
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from PySide6.QtCore import QCoreApplication, QTimer  # noqa: E402

from nai_terminal.gui.background import BackgroundExecutor  # noqa: E402
from nai_terminal.gui.process_supervisor import ProcessSupervisor  # noqa: E402
from nai_terminal.gui_store import (GuiOwnerLease, QueueClient,  # noqa: E402
                                    managed_process_commands, win_to_wsl_path)

app = QCoreApplication(sys.argv)
executor = BackgroundExecutor()
wsl_root = win_to_wsl_path(str(ROOT))
print(f"仓库(Windows) = {ROOT}\n仓库(WSL)     = {wsl_root}\n")

lease_temp = tempfile.TemporaryDirectory(prefix="nai-terminal-owner-")
lease = GuiOwnerLease.create(lease_temp.name)
lease_timer = QTimer()
lease_timer.setInterval(1000)
lease_timer.timeout.connect(lease.heartbeat)
lease_timer.start()
supervisor = ProcessSupervisor(managed_process_commands(
    wsl_root, owner_lease=win_to_wsl_path(str(lease.path)), owner_token=lease.token),
    QueueClient(ROOT), executor)
supervisor.logReceived.connect(lambda key, line: print(f"  [{key}] {line}"))
supervisor.serviceStateChanged.connect(lambda key, state: print(f"  >> {key} = {state}"))
supervisor.overallStateChanged.connect(lambda text: print(f"总状态: {text}"))

result = {"ready": False, "stopped": False}
started = time.monotonic()


def on_ready():
    result["ready"] = True
    print(f"\n✅ 两个后台都就绪，用时 {time.monotonic() - started:.1f}s")
    for key, service in supervisor.services.items():
        print(f"   {key}: state={service.state} owned={service.owned} pid={service.linux_pid}")
    print("\n--- 现在测停止 ---")
    QTimer.singleShot(500, supervisor.stop_all)


def on_stopped():
    if not result["ready"]:
        return
    result["stopped"] = True
    print("\n✅ 停止完成")
    for key, service in supervisor.services.items():
        print(f"   {key}: state={service.state} owned={service.owned}")
    QTimer.singleShot(300, app.quit)


supervisor.allReady.connect(on_ready)
supervisor.allStopped.connect(on_stopped)

print("--- 点「一键启动创作环境」---")
supervisor.start_all()
QTimer.singleShot(90_000, app.quit)
app.exec()
lease_timer.stop()
lease.close()
lease_temp.cleanup()
executor.shutdown()
print(f"\n结果: 启动={'成功' if result['ready'] else '失败'} 停止={'成功' if result['stopped'] else '失败'}")
sys.exit(0 if result["ready"] and result["stopped"] else 1)

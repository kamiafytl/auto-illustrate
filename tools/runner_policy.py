#!/usr/bin/env python3
"""Small cross-runner policy checks shared by every public drawing entry."""
from __future__ import annotations


CLEAN_CLI_RETIRED_MESSAGE = (
    "✗ --clean 已废止：Clean 只服从 NAI 出图终端 App 的二态开关。"
    "请在终端“设置”页开启 Clean 模式；公开成品位置仍由 project 决定。"
)

DIRECT_CLI_RETIRED_MESSAGE = (
    "✗ --legacy-direct 已废止：所有实际跑图只能投递到 NAI 出图终端统一工单。"
    "请先启动终端；终端不可达时本命令会明确失败，不会回退直连 NAI。"
)


def reject_retired_clean_flag(argv) -> None:
    """Recognise the old flag but fail loudly instead of silently ignoring it."""
    if "--clean" in argv:
        raise SystemExit(CLEAN_CLI_RETIRED_MESSAGE)


def reject_retired_direct_flag(argv) -> None:
    """拒绝已退役的 NAI 直连旁路，避免旧命令被 runner 静默忽略。"""
    if "--legacy-direct" in argv:
        raise SystemExit(DIRECT_CLI_RETIRED_MESSAGE)

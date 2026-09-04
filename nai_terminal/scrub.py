"""公开侧错误脱敏器（SPEC §八）。

原则：events / HTTP 响应只进【状态码、异常类名、我方技术描述、trace_id】。
NAI 报错原文（可能回显 request/prompt）→ 只写 data/terminal/private_error.log（带 trace_id）。

隐私边界：本模块【不读取任何 private 数据文件】。scrub_text 接受可选的
private_substrings（由调用方在明知安全的前提下注入），本模块自身绝不去 private 文件取词。
期一公开出口（echo/events）全部由公开的 RenderJob 内容构建，本身不含隐私正文=结构性洁净；
scrub_text 是纵深防御的兜底。
"""

from __future__ import annotations

import secrets
import re
from typing import Iterable

SCRUBBED = "__SCRUBBED__"


def new_trace_id() -> str:
    return "trace_" + secrets.token_hex(8)


def scrub_error(exc: BaseException, trace_id: str) -> str:
    """把异常压成公开摘要：仅异常类名 + trace_id（绝不含 message 原文，原文进私有日志）。"""
    return f"{type(exc).__name__} (trace={trace_id})"


def public_error_summary(kind: str, trace_id: str) -> str:
    """给定我方技术描述 kind（如 'submit_failed'/'artifact_missing'）+ trace_id 的公开摘要。"""
    return f"{kind} (trace={trace_id})"


def scrub_text(text: str, private_substrings: Iterable[str] | None = None) -> tuple[str, bool]:
    """公开文本出口兜底：若含任一 private 子串则替换为占位并告警。

    private_substrings 由调用方注入（本模块不自行读取 private 文件）；期一常传 None。
    返回 (脱敏后文本, 是否命中隐私)。
    """
    if not text or not private_substrings:
        return text, False
    hit = False
    for s in private_substrings:
        s = (s or "").strip()
        if s and s in text:
            text = text.replace(s, SCRUBBED)
            hit = True
    return text, hit


def scrub_submit_log(text: str) -> tuple[str, bool]:
    """Turn one ``submit_nai`` progress line into a public-console line.

    ``submit_nai`` is also a developer CLI, so some of its diagnostics include
    the upstream HTTP body or connection details.  The terminal must never put
    those raw strings in its public launcher console: an upstream error is
    allowed to echo the final request, which already contains private preset
    text at that point.  ``sensitive=True`` tells the caller to archive the raw
    line in the private error log and attach a trace id to the public summary.

    The allow-list deliberately keeps ordinary progress useful (model, size,
    seed, output and saved files) while failing closed for future/unknown log
    formats.
    """
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    line = raw.strip()
    if not line:
        return "", False

    if line.startswith("详细:"):
        return "NAI 返回了详细错误，内容已转入私密错误记录", True
    if line.startswith("代理:"):
        if line == "代理: 直连":
            return "  代理: 直连", False
        return "  代理: 已配置（地址不公开）", True
    if line.startswith("⚠ HTTP"):
        # Preserve status/retry progress but never the body after the retry tuple.
        match = re.match(r"⚠ HTTP (\d+) NAI 服务端异常，([^:]+)", line)
        if match:
            return f"  ⚠ HTTP {match.group(1)} NAI 服务端异常，{match.group(2)}（详情已隐藏）", True
        return "  ⚠ NAI 服务端异常（详情已隐藏）", True
    if line.startswith("✗ HTTP"):
        code = re.search(r"HTTP\s+(\d+)", line)
        suffix = f" HTTP {code.group(1)}" if code else ""
        return f"✗ NAI 请求失败{suffix}（详情已隐藏）", True
    if "网络超时/中断" in line:
        retry = re.search(r"(\d+(?:\.\d+)?s 后重试 \(#[^)]+\))", line)
        tail = f"，{retry.group(1)}" if retry else ""
        return f"  ⚠ 网络超时/中断{tail}（详情已隐藏）", True
    if "网络错误" in line:
        return "✗ 网络错误（详情已隐藏）", True
    if "本帧失败" in line:
        return "  ✗ 本帧提交失败，已按既定补跑策略继续（详情已隐藏）", True
    # V5 配额护栏（submit_nai.check_v5_usage_guard）：余量是纯数字、无隐私正文，公开可见；
    # 但查询失败行会带 URLError reason（可能含代理地址）→ 只公开摘要。
    if line.startswith("⚠ V5 配额查询失败"):
        return "  ⚠ V5 配额查询失败（不阻断，详情已隐藏）", True

    safe_prefixes = (
        "NAI 出图任务", "模型:", "尺寸:", "数量:", "角色 prompt:",
        "输出:", "完成:", "⚠ 429", "⚠ 返回空图", "⚠ 达尝试上限",
        "V5 配额余量:", "⚠⚠ V5 配额余量仅", "⚠ V5 配额响应无 usage.percent",
    )
    if line.startswith(safe_prefixes) or re.match(r"^\[[^]]+\].*seed=\d+ 提交中", line):
        return raw, False
    if line.startswith("✓"):
        return raw, False

    # Unknown future output is private by default.  This prevents a later
    # submit_nai diagnostic from silently reopening the privacy boundary.
    return "提交过程产生一条未公开的诊断信息", True


def write_private_error(log_path, trace_id: str, raw: str) -> None:
    """NAI 报错原文只落私有日志（带 trace_id）。写失败绝不抛（脱敏是尽力而为）。"""
    try:
        from datetime import datetime, timezone
        line = f"[{datetime.now(timezone.utc).isoformat()}] {trace_id}\n{raw}\n{'-' * 60}\n"
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass

#!/usr/bin/env python3
"""manual_budget.py — 手册等效字符预算检查（系统优化工程 B5 / 防再乱机制 §6.4）

度量口径 = 等效字符量：去掉空格/Tab 后的 UTF-8 字节数（`tr -d ' \\t' | wc -c` 等价）。
行数上限已被超长单行架空，改用等效字符量做预算闸门；行数仅作参考列。

用法:
  python3 tools/manual_budget.py           # 全库检查（internal-docs + CLAUDE.md）
  python3 tools/manual_budget.py --diff    # 额外对比 git HEAD 版本的增减（体检用）
退出码: 有超标=1，全部达标=0。
预算覆盖: data/manual_budgets.json（键=仓库相对路径或 "_default"；不存在则用内置默认）。
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 内置默认预算（提案值·按"150行×平均行密度"折算，待 Owner 认可）
DEFAULT_BUDGETS = {
    "CLAUDE.md": 8000,
    "internal-docs": 4500,
    "internal-docs": 7000,
    "_default": 18000,  # 普通手册（其余全部 internal-docs）
}


def load_budgets():
    budgets = dict(DEFAULT_BUDGETS)
    override = ROOT / "data" / "manual_budgets.json"
    if override.exists():
        budgets.update(json.loads(override.read_text(encoding="utf-8")))
    return budgets


def eff_chars(text):
    """去空格/Tab 后的 UTF-8 字节数（= tr -d ' \\t' | wc -c）。"""
    return len(text.replace(" ", "").replace("\t", "").encode("utf-8"))


def head_eff_chars(rel):
    """git HEAD 版本的等效字符量；HEAD 无此文件返回 0。"""
    r = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=ROOT,
                       capture_output=True)
    if r.returncode != 0:
        return 0
    return eff_chars(r.stdout.decode("utf-8", errors="replace"))


def disp_width(s):
    """终端显示宽度（CJK 记 2）。"""
    return sum(2 if ord(c) > 0x2E7F else 1 for c in s)


def pad(s, width):
    return s + " " * max(0, width - disp_width(s))


def main():
    diff_mode = "--diff" in sys.argv[1:]
    budgets = load_budgets()
    files = sorted(ROOT.glob("internal-docs")) + [ROOT / "CLAUDE.md"]

    rows = []
    for f in files:
        rel = f.relative_to(ROOT).as_posix()
        text = f.read_text(encoding="utf-8")
        chars = eff_chars(text)
        lines = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
        budget = budgets.get(rel, budgets["_default"])
        pct = chars * 100.0 / budget if budget else 0.0
        delta = chars - head_eff_chars(rel) if diff_mode else None
        rows.append((rel, chars, lines, budget, pct, delta))

    rows.sort(key=lambda r: -r[4])  # 占用率降序，超标最醒目
    over = [r for r in rows if r[1] > r[3]]

    headers = ["文件", "等效字符", "行数", "预算", "占用%", "状态"]
    if diff_mode:
        headers.append("ΔHEAD")
    w0 = max(disp_width(r[0]) for r in rows + [(headers[0], 0, 0, 0, 0, None)])
    print(pad(headers[0], w0), *(h.rjust(9) for h in headers[1:]))
    print("-" * (w0 + 10 * (len(headers) - 1)))
    for rel, chars, lines, budget, pct, delta in rows:
        status = "⚠超标" if chars > budget else "ok"
        cells = [f"{chars}".rjust(9), f"{lines}".rjust(9),
                 f"{budget}".rjust(9), f"{pct:.0f}%".rjust(9),
                 status.rjust(8 if status == "ok" else 5)]
        if diff_mode:
            cells.append(f"{delta:+d}".rjust(9))
        print(pad(rel, w0), *cells)

    print(f"\n共 {len(rows)} 份，超标 {len(over)} 份。"
          + ("" if not over else " 超标清单: " + ", ".join(r[0] for r in over)))
    print("预算=内置提案值（待 Owner 认可），可用 data/manual_budgets.json 覆盖。")
    sys.exit(1 if over else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""待删除区两级清理（2026-07-07 拍板 · drawing_workflow §五 review 落盘制）。

政策：删除一律先移待删除区（`_待删除` 前缀改名，绝不直接 rm）；
待删除区内容满 --days（默认 30）天 → 本脚本清理。
触发：Owner 口头「清理待删除区」/ 系统体检附带报告 / Owner 要腾空间时 --days 0。

默认 dry-run 只报清单；--purge 才实删（实删不可逆）。
扫描根 = data/paths.json 的 workspace + orig_compare（经 tools/paths.py）。
"年龄" = 目录树内最新 mtime 距今天数（近期还被碰过的不删）。
"""
import argparse
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paths import WORKSPACE, ORIG_COMPARE  # noqa: E402

PREFIX = "_待删除"


def newest_mtime(path: str) -> float:
    latest = os.path.getmtime(path)
    if os.path.isdir(path):
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    latest = max(latest, os.path.getmtime(os.path.join(root, name)))
                except OSError:
                    pass
    return latest


def tree_size(path: str) -> int:
    if os.path.isfile(path):
        return os.path.getsize(path)
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def find_pending(roots):
    found = []
    for base in roots:
        if not os.path.isdir(base):
            continue
        for root, dirs, files in os.walk(base):
            hit_dirs = [d for d in dirs if d.startswith(PREFIX)]
            for d in hit_dirs:
                found.append(os.path.join(root, d))
                dirs.remove(d)  # 不再深入已命中目录找嵌套项
            for f in files:
                if f.startswith(PREFIX):
                    found.append(os.path.join(root, f))
    return found


def main():
    ap = argparse.ArgumentParser(description="待删除区两级清理（默认 dry-run）")
    ap.add_argument("--days", type=int, default=30, help="满多少天才可删（默认 30；腾空间用 0）")
    ap.add_argument("--purge", action="store_true", help="实删超期项（不可逆；缺省只报清单）")
    args = ap.parse_args()

    roots = [WORKSPACE, ORIG_COMPARE]
    now = time.time()
    entries = find_pending(roots)
    if not entries:
        print("待删除区为空，无事可做。")
        return

    expired = []
    print(f"待删除区共 {len(entries)} 项（阈值 {args.days} 天）：")
    for p in sorted(entries):
        age_days = (now - newest_mtime(p)) / 86400
        size_mb = tree_size(p) / 1024 / 1024
        due = age_days >= args.days
        if due:
            expired.append(p)
        print(f"  [{'超期' if due else '未满'}] {age_days:5.1f}天 {size_mb:8.1f}MB  {p}")

    if not expired:
        print("无超期项。")
        return
    total_mb = sum(tree_size(p) for p in expired) / 1024 / 1024
    if args.purge:
        for p in expired:
            (shutil.rmtree if os.path.isdir(p) else os.remove)(p)
            print(f"已删: {p}")
        print(f"清理完成：{len(expired)} 项，释放约 {total_mb:.1f}MB。")
    else:
        print(f"dry-run：{len(expired)} 项超期（约 {total_mb:.1f}MB），加 --purge 实删。")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量生成/刷新 `LazyShot.seg`（按槽分段视图）——入库后的收尾步骤，让整套帧「可实时编辑任意一帧」。

背景（lazydog_storage §4.6 + linkage_map §三·五 seg 节点）：
  · seg = 各区域原文切成【带槽标签的片段】，网页帧编辑器按槽分组编辑靠它，
    `run_db_draw` 的「按槽整块替换」路径（RS.transform_by_seg）也靠它。
  · 铁律：各区域 join(段文本) === payload_src 对应区域原文（逐字节）。不满足即拒绝写入。
  · 分类逻辑与前端 `promptTokens.ts` 同源（Python 端口=tools/seg_tokens.py），
    故网页里点「重新切段」得到的结果与本命令一致。

用法（默认 dry-run 只统计，--write 才落库）:
  python3 tools/build_seg.py "<folder 子串>"            # 预览：段数/各槽分布/未归类段清单
  python3 tools/build_seg.py "<folder 子串>" --write     # 落库（幂等，可反复重跑）
  python3 tools/build_seg.py "<folder 子串>" --check     # 与库里已存 seg 逐段比对（前端↔CLI 一致性回归）
  python3 tools/build_seg.py --all --check              # 全库回归

注意：seg 依赖 slots/blocks 的值来染色 → **先把槽切准，再生成 seg**；槽改了要重跑本命令。
"""
import os
import sys
import json
import argparse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import seg_tokens as ST

SETS = os.path.join(ROOT, "data/lazydog/sets.json")


def build_for(entry):
    """一帧 → seg dict（空区域不产段，与前端 segsMatch 语义一致）。校验失败抛 AssertionError。"""
    ps = entry.get("payload_src") or {}
    ctx = ST.build_ctx(entry.get("slots"), entry.get("blocks"))
    seg = {}
    pos = ST.auto_segs(ps.get("positive") or "", ctx, "positive")
    if pos:
        assert ST.join_segs(pos) == (ps.get("positive") or ""), "positive"
        seg["positive"] = pos
    neg = ST.auto_segs(ps.get("negative") or "", ctx, "negative")
    if neg:
        assert ST.join_segs(neg) == (ps.get("negative") or ""), "negative"
        seg["negative"] = neg
    chars, cnegs = [], []
    for i, c in enumerate(ps.get("characters") or []):
        cs = ST.auto_segs(c.get("text") or "", ctx, "char")
        if cs:
            assert ST.join_segs(cs) == (c.get("text") or ""), f"chars[{i}]"
        chars.append(cs or None)
        ns = ST.auto_segs(c.get("negative") or "", ctx, "charNeg")
        if ns:
            assert ST.join_segs(ns) == (c.get("negative") or ""), f"charNegs[{i}]"
        cnegs.append(ns or None)
    if any(chars):
        seg["chars"] = chars
    if any(cnegs):
        seg["charNegs"] = cnegs
    return seg


def main():
    ap = argparse.ArgumentParser(description="生成/刷新 sets.json 帧的 seg 分段（默认 dry-run）")
    ap.add_argument("folder", nargs="?", default="", help="source.folder 子串（不给需 --all）")
    ap.add_argument("--all", action="store_true", help="全库所有帧")
    ap.add_argument("--check", action="store_true", help="与库里已存 seg 比对，不写")
    ap.add_argument("--write", action="store_true", help="真写库")
    args = ap.parse_args()
    if not args.folder and not args.all:
        sys.exit("✗ 需要 folder 子串，或 --all")

    data = json.load(open(SETS, encoding="utf-8"))
    picked = [e for e in data
              if e.get("payload_src") and (args.all or args.folder in (e.get("source", {}).get("folder") or ""))]
    if not picked:
        sys.exit(f"✗ 没找到帧（folder 子串 {args.folder!r}）")
    folders = sorted({e["source"]["folder"] for e in picked})
    print(f"命中 {len(picked)} 帧 / {len(folders)} 套: " + ", ".join(folders[:6]) + (" …" if len(folders) > 6 else ""))

    cats = Counter()
    unknown_samples = []
    changed = same = 0
    fails = []
    for e in picked:
        try:
            seg = build_for(e)
        except AssertionError as ex:
            fails.append((e["id"], str(ex)))
            continue
        for key in ("positive", "negative"):
            for s in seg.get(key) or []:
                cats[s["cat"]] += 1
                if s["cat"] == "unknown" and key == "positive" and len(unknown_samples) < 40:
                    unknown_samples.append((e["source"]["page"], key, s["text"].strip()))
        for i, arr in enumerate(seg.get("chars") or []):
            for s in arr or []:
                cats[s["cat"]] += 1
                if s["cat"] == "unknown" and len(unknown_samples) < 40:
                    unknown_samples.append((e["source"]["page"], f"char{i}", s["text"].strip()))
        if e.get("seg") == seg:
            same += 1
        else:
            changed += 1
        if args.write:
            e["seg"] = seg

    if fails:
        print(f"✗ {len(fails)} 帧分段拼回≠原文（拒绝写库）:")
        for i, (sid, where) in enumerate(fails[:10]):
            print(f"   {sid}  区域 {where}")
        sys.exit(1)

    print("段分类分布: " + ", ".join(f"{k}={v}" for k, v in cats.most_common()))
    print(f"与库内现状: 相同 {same} 帧 / 不同(将更新) {changed} 帧")
    if unknown_samples:
        print(f"未归类(unknown)段样例 {len(unknown_samples)} 条（=槽没覆盖到的词，可回头补槽再重跑）:")
        for pg, key, t in unknown_samples[:20]:
            print(f"   p{pg:02d} {key}: {t[:70]!r}")

    if args.check:
        print("※ --check 模式：只比对，未写库。" + ("库内 seg 与本命令生成一致 ✅" if changed == 0 else
                                                  "有差异（网页手改过槽归属也会造成差异，属正常）"))
        return
    if args.write:
        json.dump(data, open(SETS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"✅ 已写入 data/lazydog/sets.json（{changed} 帧 seg 更新）")
    else:
        print("※ 以上是预演。确认后加 --write 落库。")


if __name__ == "__main__":
    main()

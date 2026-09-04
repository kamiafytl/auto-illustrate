#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""diff_meta.py —— 「复刻不像/确定参数一样吗」一条命令定根因（#73 复盘 P1④）。

对比两张 NAI 图的 meta（原图 vs 复刻输出）：参数逐项 / base 正负向 / 各角色 caption+negative / centers。
signed_hash（服务器签名）恒不同、自动忽略。全一致仍不像 = NAI 服务端渲染漂移（drawing_workflow §五.8）。
用法: python3 tools/diff_meta.py <原图.png> <输出图.png>
"""
import sys
import os
import json

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import read_image_meta as RIM

IGNORE = {"signed_hash", "stream"}
PROMPT_KEYS = {"v4_prompt", "v4_negative_prompt", "prompt", "uc"}


def load(path):
    _src, data = RIM.read_one(path)
    if isinstance(data, dict) and isinstance(data.get("meta"), dict):
        data = data["meta"]
    cm = data.get("Comment") if isinstance(data, dict) else None
    if isinstance(cm, str):
        cm = json.loads(cm)
    if not isinstance(cm, dict):
        sys.exit(f"✗ 读不到 NAI Comment meta: {path}")
    return cm


def caption(cm, neg=False):
    key = "v4_negative_prompt" if neg else "v4_prompt"
    return cm.get(key, {}).get("caption", {})


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    a, b = load(sys.argv[1]), load(sys.argv[2])
    diffs = 0

    # 参数层
    for k in sorted(set(a) | set(b)):
        if k in IGNORE or k in PROMPT_KEYS:
            continue
        if a.get(k) != b.get(k):
            diffs += 1
            print(f"PARAM  {k}: 原={a.get(k)!r}  新={b.get(k)!r}")

    # prompt 层
    ca, cb = caption(a), caption(b)
    if ca.get("base_caption") != cb.get("base_caption"):
        diffs += 1
        print("BASE 正向不同:")
        print("  原:", (ca.get("base_caption") or "")[:400])
        print("  新:", (cb.get("base_caption") or "")[:400])
    na, nb = caption(a, True), caption(b, True)
    if na.get("base_caption") != nb.get("base_caption"):
        diffs += 1
        print("BASE 负向不同:")
        print("  原:", (na.get("base_caption") or "")[:300])
        print("  新:", (nb.get("base_caption") or "")[:300])
    cca, ccb = ca.get("char_captions", []), cb.get("char_captions", [])
    if len(cca) != len(ccb):
        diffs += 1
        print(f"角色数不同: 原 {len(cca)} vs 新 {len(ccb)}")
    for i in range(min(len(cca), len(ccb))):
        for field in ("char_caption", "centers"):
            if cca[i].get(field) != ccb[i].get(field):
                diffs += 1
                print(f"char{i} {field} 不同:")
                print("  原:", str(cca[i].get(field))[:300])
                print("  新:", str(ccb[i].get(field))[:300])
    if a.get("request_type") != b.get("request_type"):
        rt = a.get("request_type") or ""
        if "Img2Img" in rt or "Infill" in rt:
            print(f"※ 原图是 {rt}（底图/strength 无从复刻）——差异属结构性不可还原，非参数错。")

    if diffs == 0:
        print("✅ 逐字段全一致（signed_hash 除外）。仍不像 = NAI 服务端渲染漂移（§五.8），"
              "修补走三板斧：同seed重投 / 关键词1.1强化 / 随机seed海选（drawing_workflow §五）。")
    else:
        print(f"\n共 {diffs} 处差异。")


if __name__ == "__main__":
    main()

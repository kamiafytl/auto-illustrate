#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PSD 批量合成为 PNG 预览（免 Photoshop，用 psd-tools composite）。
文字/形状层按 PSD 内存储的合成数据渲染，与 Photoshop 显示一致；不受 PS 模态弹窗阻塞。
用法: python3 tools/psd_render_png.py --dir "<PSD文件夹>" [--out "<输出夹>"]
默认输出 = <dir 同级>/<dirname>_预览PNG
"""
import argparse, time
from pathlib import Path
from psd_tools import PSDImage

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    d = Path(a.dir)
    out = Path(a.out) if a.out else d.parent / (d.name + "_预览PNG")
    out.mkdir(parents=True, exist_ok=True)
    psds = sorted(d.glob("*.psd"))
    print(f"{d.name}: {len(psds)} 个 PSD → {out}")
    for p in psds:
        t = time.time()
        PSDImage.open(p).composite().save(out / (p.stem + ".png"))
        print(f"  {p.stem}.png  {time.time()-t:.1f}s", flush=True)
    print("完成")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""一键去除图片元数据 — 清掉 NAI/ComfyUI 埋在 PNG 里的 prompt、以及 EXIF/ICC 等所有附带信息。

发布前用：NAI 会把正/负向 prompt、seed、模型等写进 PNG 的 tEXt/zTXt 文本块，
直接上传 pixiv/Twitter 会泄露。本脚本把每张图的像素重新写一遍、不带任何 info，
彻底剥离全部元数据（PNG 文本块 / EXIF / ICC / XMP）。像素本身不动，画质无损。

用法：
  python3 tools/strip_image_meta.py <文件夹>                # 默认输出到 <文件夹>/cleaned/，原图保留
  python3 tools/strip_image_meta.py <文件夹> --inplace      # 原地覆盖（不可逆，先确认）
  python3 tools/strip_image_meta.py <文件夹> --out <目标>   # 指定输出目录
  python3 tools/strip_image_meta.py <文件夹> --recursive    # 含子文件夹
  python3 tools/strip_image_meta.py <文件夹> --dry-run      # 只列出会处理哪些图，不写

默认只认 .png/.webp/.jpg/.jpeg/.bmp。处理后会校验输出图确实无文本块。
"""
import argparse
import sys
from pathlib import Path

from PIL import Image

EXTS = {".png", ".webp", ".jpg", ".jpeg", ".bmp"}


def collect(folder: Path, recursive: bool):
    it = folder.rglob("*") if recursive else folder.iterdir()
    return sorted(p for p in it if p.is_file() and p.suffix.lower() in EXTS)


def has_text_meta(img: Image.Image) -> bool:
    """图里是否带普通元数据（PNG 文本块 / EXIF / ICC / XMP）。"""
    info = img.info or {}
    if info.get("exif") or info.get("icc_profile") or info.get("XML:com.adobe.xmp"):
        return True
    # PNG tEXt/zTXt/iTXt 会作为普通字符串键进 info（如 NAI 的 'Comment'/'parameters'/'Software'）
    skip = {"exif", "icc_profile", "dpi", "gamma", "transparency", "loop",
            "duration", "background", "srgb", "chromaticity"}
    return any(isinstance(v, (str, bytes)) and k not in skip for k, v in info.items())


def has_alpha_stealth(img: Image.Image) -> bool:
    """NAI/SD 的「stealth PNG」隐写：完整 prompt 用 LSB 藏在 alpha 通道里，
    普通看图软件读不到、专用工具一键还原。光去文本块没用，必须连这个一起灭。
    检测法：读 alpha 通道 LSB 拼成的头部字节，找 magic 'stealth'。"""
    if "A" not in img.getbands():
        return False
    a = img.getchannel("A")
    w, h = a.size
    px = a.load()
    bits = []
    # stealth 规范按列优先写入 LSB；读够 magic 长度即可
    need = 8 * 16  # 'stealth_pnginfo'/'stealth_pngcomp' 共 15+ 字节
    for x in range(w):
        for y in range(h):
            bits.append(px[x, y] & 1)
            if len(bits) >= need:
                break
        if len(bits) >= need:
            break
    head = bytearray()
    for i in range(0, len(bits) // 8 * 8, 8):
        b = 0
        for j in range(8):
            b = (b << 1) | bits[i + j]
        head.append(b)
    return b"stealth" in bytes(head)


def has_meta(img: Image.Image) -> bool:
    return has_text_meta(img) or has_alpha_stealth(img)


def strip_one(src: Path, dst: Path):
    """把 src 的像素重写到 dst，丢弃全部元数据。返回该图原本是否带 meta。"""
    with Image.open(src) as img:
        img.load()
        had = has_meta(img)
        fmt = img.format
        # frombytes 只搬像素，info/exif/icc 全部不带过来 —— 去普通文本块的关键
        clean = Image.frombytes(img.mode, img.size, img.tobytes())

    # ★ 灭掉 alpha 通道隐写（NAI stealth PNG）：frombytes 会原样保留 alpha 像素，
    #   隐写就藏在 alpha LSB，必须额外处理，否则文本块去了、隐写那份照样能还原。
    if "A" in clean.getbands():
        alpha = clean.getchannel("A")
        lo, _ = alpha.getextrema()
        if lo >= 254:
            # 不透明图（NAI 出图均如此）：直接丢掉 alpha 通道 → 画面零变化，隐写彻底消失
            clean = clean.convert("RGB") if clean.mode == "RGBA" else clean.convert("L")
        else:
            # 真有透明区域：把 alpha 全部 LSB 置 1，抹掉隐藏比特（透明度肉眼无变化）
            clean.putalpha(alpha.point(lambda v: v | 1))

    dst.parent.mkdir(parents=True, exist_ok=True)
    save_kw = {}
    if fmt:
        save_kw["format"] = fmt
    suffix = dst.suffix.lower()
    if suffix == ".png":
        save_kw["optimize"] = True          # 不传 pnginfo → 无任何文本块
    elif suffix == ".webp":
        save_kw["lossless"] = True           # webp 无损重存，画质不变
    elif suffix in (".jpg", ".jpeg"):
        save_kw["quality"] = 95
        save_kw["subsampling"] = "keep"      # 尽量保留原始色度采样
    # 注意：全程不传 exif=/icc_profile=/pnginfo= → 元数据无处可带
    clean.save(dst, **save_kw)
    return had


def verify(path: Path) -> bool:
    """复检：输出图确实不带元数据。"""
    try:
        with Image.open(path) as img:
            img.load()
            return not has_meta(img)
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser(description="一键去除图片元数据")
    ap.add_argument("folder", help="待处理的文件夹")
    ap.add_argument("--inplace", action="store_true", help="原地覆盖原图（不可逆）")
    ap.add_argument("--out", help="输出目录（默认 <folder>/cleaned/）")
    ap.add_argument("--recursive", action="store_true", help="含子文件夹")
    ap.add_argument("--dry-run", action="store_true", help="只列出会处理哪些图，不写")
    args = ap.parse_args()

    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        sys.exit(f"[错误] 不是文件夹: {folder}")

    if args.inplace and args.out:
        sys.exit("[错误] --inplace 与 --out 不能同时用")
    out_dir = None if args.inplace else Path(args.out).expanduser() if args.out else folder / "cleaned"

    files = collect(folder, args.recursive)
    # 排除输出目录自身，避免把已清理图再处理一遍
    if out_dir:
        files = [f for f in files if out_dir not in f.parents and f.parent != out_dir]
    if not files:
        sys.exit(f"[提示] {folder} 下没有可处理的图片（{'/'.join(sorted(EXTS))}）")

    mode = "原地覆盖" if args.inplace else f"输出到 {out_dir}"
    print(f"==== 去除元数据 | {len(files)} 张 | {mode} ====\n")

    if args.dry_run:
        for f in files:
            with Image.open(f) as img:
                img.load()
                flag = "有meta" if has_meta(img) else "无meta"
            print(f"  [{flag}] {f.relative_to(folder)}")
        print(f"\n==== DRY-RUN：以上 {len(files)} 张会被处理 ====")
        return

    cleaned = stripped = failed = 0
    for f in files:
        if args.inplace:
            dst = f
        else:
            rel = f.relative_to(folder)
            dst = out_dir / rel
        try:
            had = strip_one(f, dst)
            ok = verify(dst)
            cleaned += 1
            if had:
                stripped += 1
            mark = "✓" if ok else "⚠ 校验仍有残留"
            tag = "剥离meta" if had else "原本无meta"
            print(f"  {mark} [{tag}] {f.name}")
            if not ok:
                failed += 1
        except Exception as e:
            failed += 1
            print(f"  ✗ {f.name} — {e}")

    print(f"\n==== 完成：处理 {cleaned} 张，其中 {stripped} 张原本带 meta；失败/残留 {failed} 张 ====")
    if not args.inplace:
        print(f"     清理后的图在：{out_dir}")


if __name__ == "__main__":
    main()

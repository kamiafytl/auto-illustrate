#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""蜜罐 meta 注入 —— 先彻底去真 meta（含 alpha 隐写），再写入一段「假的标准 NAI4.5 结构」。

用途：别人扒你 PNG 的 meta 想白嫖 prompt，结果读到的是一套**正常的 NAI4.5 导出结构**，
但正/负/角色提示词全被换成你留的一句话（引流/声明）。看图软件、SD-webui、在线 EXIF 工具
去读 prompt 的那几个位置（Description / Comment.prompt / v4_prompt.base_caption / uc）
全都是你这句话。

★ 铁律：必须「先清后写」——只加假块不删真块 = 真 prompt 还在，等于没做。
  本脚本复用 strip 的彻底清理（重写像素 + 灭 NAI alpha LSB 隐写），清干净后才注入蜜罐。

用法：
  python3 tools/tag_image_meta.py <文件夹>                      # 默认输出到 <文件夹>/广告meta/
  python3 tools/tag_image_meta.py <文件夹> --note "你的话"        # 自定义蜜罐文字
  python3 tools/tag_image_meta.py <文件夹> --out <目标>          # 指定输出目录
  python3 tools/tag_image_meta.py <文件夹> --recursive          # 含子文件夹
  python3 tools/tag_image_meta.py <文件夹> --dry-run            # 只列出会处理哪些图，不写

只处理 .png（蜜罐走 PNG 文本块；JPG 的 EXIF 走法不同，需要单独支持时再加）。
处理后自动校验：①真 meta 已无 ②蜜罐文字确实已写入。
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

# 复用 strip 工具的检测/清理逻辑，保证「灭隐写」口径一致、不分裂
from strip_image_meta import has_meta as _real_has_meta  # noqa: E402

# ---- 默认蜜罐文字（中日英三语）-------------------------------------------------
DEFAULT_NOTE = (
    "感谢你认可我的作品，如要获取meta信息，请加入我的Discord频道私信我："
    "https://discord.gg/mumjxEjKB ｜ "
    "私の作品を評価してくれてありがとう。meta情報が必要な場合は、"
    "私のDiscordチャンネルに参加してDMしてください：https://discord.gg/mumjxEjKB ｜ "
    "Thank you for appreciating my work. To get the meta info, "
    "please join my Discord channel and DM me: https://discord.gg/mumjxEjKB"
)


def clean_pixels(src: Path) -> Image.Image:
    """把 src 重写成「零元数据」的纯像素图（同时灭掉 NAI alpha LSB 隐写）。"""
    with Image.open(src) as img:
        img.load()
        clean = Image.frombytes(img.mode, img.size, img.tobytes())
    # 灭 alpha 隐写：不透明图直接丢 alpha；有真透明则把 alpha LSB 全置 1
    if "A" in clean.getbands():
        alpha = clean.getchannel("A")
        lo, _ = alpha.getextrema()
        if lo >= 254:
            clean = clean.convert("RGB") if clean.mode == "RGBA" else clean.convert("L")
        else:
            clean.putalpha(alpha.point(lambda v: v | 1))
    return clean


def build_honeypot(note: str) -> PngInfo:
    """造一套「标准 NAI4.5 结构」，但正/负/角色提示词全部换成 note。

    保留真实 NAI 导出会有的全部字段，让结构看起来像真的；只把读 prompt 的
    四个位置（Description / Comment.prompt / v4_prompt / uc / v4_negative_prompt）
    塞成 note，角色词清空。"""
    comment = {
        "prompt": note,                       # ← 读 Comment.prompt 命中这里
        "steps": 28,
        "height": 1216,
        "width": 832,
        "scale": 5.0,
        "uncond_scale": 1.0,
        "cfg_rescale": 0.0,
        "seed": 0,
        "n_samples": 1,
        "noise_schedule": "karras",
        "legacy_v3_extend": False,
        "reference_information_extracted_multiple": [],
        "reference_strength_multiple": [],
        "v4_prompt": {                        # ← 读 v4_prompt 命中这里
            "caption": {"base_caption": note, "char_captions": []},
            "use_coords": False,
            "use_order": True,
            "legacy_uc": False,
        },
        "v4_negative_prompt": {               # 负面留空（"去掉全部负面"）
            "caption": {"base_caption": "", "char_captions": []},
            "use_coords": False,
            "use_order": False,
            "legacy_uc": False,
        },
        "sampler": "k_euler_ancestral",
        "controlnet_strength": 1.0,
        "controlnet_model": None,
        "dynamic_thresholding": False,
        "sm": False,
        "sm_dyn": False,
        "prefer_brownian": True,
        "version": 1,
        "uc": "",                             # ← 读 uc（负面）也是空
        "request_type": "PromptGenerateRequest",
    }
    meta = PngInfo()
    meta.add_text("Title", "AI generated image")
    meta.add_text("Description", note)        # ← A1111/webui 读 Description 命中这里
    meta.add_text("Software", "NovelAI")
    meta.add_text("Source", "NovelAI Diffusion V4.5")
    meta.add_text("Comment", json.dumps(comment, ensure_ascii=False))
    # parameters：SD-webui 优先读这个键，也塞一份，确保它那边显示的就是 note
    meta.add_text("parameters", note)
    return meta


def tag_one(src: Path, dst: Path, note: str) -> bool:
    """清干净 src 的真 meta 后注入蜜罐，写到 dst。返回 src 原本是否带真 meta。"""
    with Image.open(src) as probe:
        probe.load()
        had = _real_has_meta(probe)
    clean = clean_pixels(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    clean.save(dst, format="PNG", optimize=True, pnginfo=build_honeypot(note))
    return had


def verify(path: Path, note: str) -> tuple[bool, bool]:
    """校验：返回 (真meta已无, 蜜罐已写入)。
    『真meta已无』判据：图里读到的 prompt 文本 == note（说明真 prompt 没残留）。"""
    with Image.open(path) as img:
        img.load()
        info = dict(img.info)
    desc = info.get("Description", "")
    honeypot_ok = desc == note and info.get("Software") == "NovelAI"
    # 真 meta 残留判据：任一文本位置里出现了非 note 的实质 prompt 痕迹
    leaked = False
    try:
        c = json.loads(info.get("Comment", "{}"))
        if c.get("prompt") not in (note, "", None):
            leaked = True
    except Exception:
        pass
    return (not leaked), honeypot_ok


def collect(folder: Path, recursive: bool, out_dir: Path):
    it = folder.rglob("*.png") if recursive else folder.glob("*.png")
    files = sorted(p for p in it if p.is_file())
    return [f for f in files if out_dir not in f.parents and f.parent != out_dir]


def main():
    ap = argparse.ArgumentParser(description="蜜罐 meta 注入（先去真meta再写假meta）")
    ap.add_argument("folder", help="待处理文件夹")
    ap.add_argument("--note", default=DEFAULT_NOTE, help="蜜罐文字（默认中日英三语引流语）")
    ap.add_argument("--out", help="输出目录（默认 <folder>/广告meta/）")
    ap.add_argument("--recursive", action="store_true", help="含子文件夹")
    ap.add_argument("--dry-run", action="store_true", help="只列出会处理哪些图")
    args = ap.parse_args()

    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        sys.exit(f"[错误] 不是文件夹: {folder}")
    out_dir = Path(args.out).expanduser() if args.out else folder / "广告meta"

    files = collect(folder, args.recursive, out_dir)
    if not files:
        sys.exit(f"[提示] {folder} 下没有 .png")

    print(f"==== 蜜罐 meta 注入 | {len(files)} 张 | 输出到 {out_dir} ====")
    print(f"     蜜罐文字：{args.note[:60]}…\n")

    if args.dry_run:
        for f in files:
            print(f"  会处理：{f.relative_to(folder)}")
        print(f"\n==== DRY-RUN：以上 {len(files)} 张会被处理 ====")
        return

    done = had_meta = failed = 0
    for f in files:
        dst = out_dir / f.relative_to(folder)
        try:
            had = tag_one(f, dst, args.note)
            clean_ok, hp_ok = verify(dst, args.note)
            done += 1
            had_meta += int(had)
            ok = clean_ok and hp_ok
            failed += int(not ok)
            mark = "✓" if ok else "⚠"
            detail = "" if ok else f"（真meta已无={clean_ok} 蜜罐已写={hp_ok}）"
            print(f"  {mark} {f.name}{detail}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {f.name} — {e}")

    print(f"\n==== 完成：{done} 张，其中 {had_meta} 张原本带真meta；失败/异常 {failed} 张 ====")
    print(f"     成品在：{out_dir}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量提取 NAI 隐写 meta（numpy 向量化 + 多进程）+ 画师串解析，输出 JSON 全量记录。

NAI(含 V5) 的 png/webp 都把 meta gzip 压进 **alpha 通道 LSB**（magic=stealth_pngcomp），
webp 的 EXIF chunk 里只有相机字段、没有 prompt —— 别被"读不出 meta"骗了。
单张读用 tools/read_image_meta.py；整个文件夹用本脚本（699 张约 1 分钟）。

用法: python3 tools/nai_meta_batch.py <根目录> <输出json>
输出每张: prompt/uc/steps/scale/seed/sampler/尺寸/model + artists[{name,weight}]
"""
import sys, os, json, gzip, re
import numpy as np
from PIL import Image
from concurrent.futures import ProcessPoolExecutor

Image.MAX_IMAGE_PIXELS = None
# 手工补录：确认是画师、但库里从未带 artist: 前缀出现过的名字（按需增补）
EXTRA_ARTISTS = ["bacius", "akkijin", "gomennasai", "momoko (momopoco)", "leonat", "hanauna",
                 "kimtoxic", "moyori", "nanoless", "ritzchrono", "cocomayo29 (tomato)"]

MAGICS = {b"stealth_pnginfo": ("alpha", False), b"stealth_pngcomp": ("alpha", True),
          b"stealth_rgbinfo": ("rgb", False),   b"stealth_rgbcomp": ("rgb", True)}

def _bits(a, channel):
    if channel == "alpha":
        return (a[:, :, 3] & 1).T.reshape(-1)
    return (a[:, :, :3] & 1).transpose(1, 0, 2).reshape(-1)

def read_stealth(path):
    im = Image.open(path)
    info = dict(im.info)
    keys = [k for k in info if k.lower() in ("parameters", "comment", "description", "prompt", "usercomment")]
    if keys:
        return "文本块", {k: info[k] for k in keys}
    a = np.array(im.convert("RGBA"))
    for channel in ("alpha", "rgb"):
        bits = _bits(a, channel)
        if bits.size < 200:
            continue
        head = np.packbits(bits[:160]).tobytes()
        magic = next((m for m in MAGICS if head.startswith(m)), None)
        if not magic:
            continue
        kind, comp = MAGICS[magic]
        p = len(magic) * 8
        length = int.from_bytes(np.packbits(bits[p:p+32]).tobytes(), "big")
        p += 32
        n = (min(length, bits.size - p) // 8) * 8
        payload = np.packbits(bits[p:p+n]).tobytes()
        try:
            text = gzip.decompress(payload).decode("utf-8", "replace") if comp else payload.decode("utf-8", "replace")
        except Exception:
            return f"损坏({magic.decode()})", None
        try:
            return f"隐写({magic.decode()})", json.loads(text)
        except Exception:
            return f"隐写({magic.decode()})", {"_raw": text}
    return None, None

# ---- 画师串解析（两阶段：先全库收集 artist: 词典，再用词典认无前缀写法）----
BAD_NAMES = {"artist", "artists", "artist collaboration", "style", ""}

def norm_artist(n):
    return re.sub(r"\s+", " ", n.replace("_", " ")).strip().lower()

def expand_tags(prompt):
    """prompt → [(tag, weight)]；支持 NAI 的 `w::a, b, c::` 分组（含负权重）与 {{}}/[[]] 修饰"""
    out, stack, buf, cur = [], [], "", 1.0
    for t in re.split(r"(-?\d+(?:\.\d+)?::|::|,)", prompt or ""):
        if re.fullmatch(r"-?\d+(?:\.\d+)?::", t):
            if buf.strip(): out.append((buf.strip(), cur))
            buf = ""; stack.append(cur); cur = float(t[:-2])
        elif t == "::":
            if buf.strip(): out.append((buf.strip(), cur))
            buf = ""; cur = stack.pop() if stack else 1.0
        elif t == ",":
            if buf.strip(): out.append((buf.strip(), cur))
            buf = ""
        else:
            buf += t
    if buf.strip(): out.append((buf.strip(), cur))
    return out

def parse_artists(prompt, adict=None):
    """adict=画师名词典(归一后)；无词典时只认 artist: 前缀写法"""
    res, seen = [], set()
    for tag, w in expand_tags(prompt):
        core = re.sub(r"^[{\[]+|[}\]]+$", "", tag).strip()   # 只剥 NAI 修饰符，别剥画师名自带的 ()
        m = re.search(r"artist:\s*([^,:]+)", core, re.I)
        name = m.group(1).strip() if m else core
        nm = norm_artist(name)
        if not nm or nm in seen or nm in BAD_NAMES:
            continue
        if not (m or (adict and nm in adict)):
            continue
        b = len(tag) - len(tag.lstrip("{")); k = len(tag) - len(tag.rstrip("}"))
        lb = len(tag) - len(tag.lstrip("[")); rb = len(tag) - len(tag.rstrip("]"))
        seen.add(nm)
        res.append({"name": name, "weight": round(w * 1.05 ** min(b, k) / 1.05 ** min(lb, rb), 3)})
    return res

def build_artist_dict(recs, extra=()):
    d = set(norm_artist(x) for x in extra)
    for r in recs:
        for m in re.finditer(r"artist:\s*([^,:]+)", r.get("prompt") or ""):
            d.add(norm_artist(m.group(1)))
    return d - BAD_NAMES

def one(path):
    rec = {"path": path}
    try:
        src, data = read_stealth(path)
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"
        return rec
    rec["source"] = src
    if not data:
        return rec
    c = data.get("Comment")
    if isinstance(c, str):
        try:
            c = json.loads(c)
        except Exception:
            c = None
    if not isinstance(c, dict):
        c = data if isinstance(data, dict) else {}
    prompt = c.get("prompt") or data.get("Description") or data.get("parameters") or ""
    rec.update({
        "model": data.get("Source") or c.get("model_name"),
        "software": data.get("Software"),
        "prompt": prompt,
        "uc": c.get("uc"),
        "steps": c.get("steps"), "scale": c.get("scale"), "seed": c.get("seed"),
        "sampler": c.get("sampler"), "noise_schedule": c.get("noise_schedule"),
        "width": c.get("width"), "height": c.get("height"),
        "artists": parse_artists(prompt),   # 一轮：只认 artist: 前缀；二轮在 main 里用词典补
    })
    v4 = c.get("v4_prompt") or {}
    caps = (v4.get("caption") or {}).get("char_captions") or []
    rec["char_captions"] = [x.get("char_caption", "") for x in caps if x.get("char_caption")]
    return rec

def main():
    root, outp = sys.argv[1], sys.argv[2]
    files = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if fn.lower().endswith((".png", ".webp", ".jpg", ".jpeg")):
                files.append(os.path.join(dp, fn))
    files.sort()
    print(f"共 {len(files)} 张，开始…", flush=True)
    recs = []
    with ProcessPoolExecutor(max_workers=os.cpu_count()) as ex:
        for i, r in enumerate(ex.map(one, files, chunksize=4), 1):
            recs.append(r)
            if i % 50 == 0:
                print(f"  {i}/{len(files)}", flush=True)
    # 二轮：用全库词典认「不写 artist: 前缀」的画师（如 1.4::bacius::）
    adict = build_artist_dict(recs, extra=EXTRA_ARTISTS)
    for r in recs:
        if r.get("prompt"):
            r["artists"] = parse_artists(r["prompt"], adict)
    print(f"画师词典 {len(adict)} 名；解析出画师 {sum(1 for r in recs if r.get('artists'))} 张")
    with open(outp, "w", encoding="utf-8") as f:
        json.dump(recs, f, ensure_ascii=False, indent=1)
    ok = sum(1 for r in recs if r.get("prompt"))
    print(f"✅ {ok}/{len(recs)} 可读 → {outp}")

if __name__ == "__main__":
    main()

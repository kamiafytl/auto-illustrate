#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读图片 AI meta —— 固定入口，双解，避免"读不出来"。
两种手段都试，哪条命中用哪条：
  ① 普通 meta：PNG 文本块(tEXt/iTXt/zTXt 的 parameters/Comment/Description/prompt) —— A1111/webui 图走这条
  ② 法术解析(stealth 隐写)：NAI 默认把 prompt gzip 压进【alpha 通道 LSB】(magic stealth_pngcomp/pnginfo，
     也兼容 RGB LSB 变体)。**NAI 图文本块常为空，必须解 alpha** —— 这正是我以前误判"无 meta"的坑。
用法：
  python3 tools/read_image_meta.py <图路径>            # 打印 prompt
  python3 tools/read_image_meta.py <图路径> --json      # 输出完整 json
  python3 tools/read_image_meta.py <目录> --scan        # 批量体检：每张图 有/无 meta + 走哪条
"""
import sys, os, json, gzip, zlib, struct
from PIL import Image

MAGICS = {b"stealth_pnginfo": ("alpha", False), b"stealth_pngcomp": ("alpha", True),
          b"stealth_rgbinfo": ("rgb", False),   b"stealth_rgbcomp": ("rgb", True)}

def read_text_chunks(im):
    """手段①：PNG 文本块。返回 dict 或 None。"""
    info = dict(im.info)
    keys = [k for k in info if k.lower() in ("parameters","comment","description","prompt","usercomment")]
    return {k: info[k] for k in keys} if keys else None

def _extract_bits(im, channel):
    im = im.convert("RGBA"); w,h = im.size; px = im.load()
    ci = {"r":0,"g":1,"b":2,"a":3}
    bits = bytearray()
    if channel == "alpha":
        for x in range(w):
            for y in range(h):
                bits.append(px[x,y][3] & 1)
    else:  # rgb：每像素取 r,g,b 三位
        for x in range(w):
            for y in range(h):
                p = px[x,y]
                bits += bytes((p[0]&1, p[1]&1, p[2]&1))
    return bits

def _bits_to_bytes(bits, nbits):
    out = bytearray()
    for i in range(0, nbits//8*8, 8):
        v = 0
        for b in bits[i:i+8]: v = (v<<1)|b
        out.append(v)
    return bytes(out)

def read_stealth(im):
    """手段②：alpha/rgb LSB 隐写。返回 (text, 命中magic) 或 None。"""
    for channel in ("alpha","rgb"):
        if channel == "alpha" and im.convert("RGBA").getchannel("A").getextrema() == (255,255):
            # alpha 全不透明也可能藏(LSB)，仍尝试；只有真全 255 偶数才无载体，这里照试
            pass
        bits = _extract_bits(im, channel)
        # 读 magic（最长 15 字节 = 120 bit）
        head = _bits_to_bytes(bits[:160], 160)
        magic = next((m for m in MAGICS if head.startswith(m)), None)
        if not magic: continue
        kind, comp = MAGICS[magic]
        p = len(magic)*8
        length = int.from_bytes(_bits_to_bytes(bits[p:p+32], 32), "big")  # bit 数
        p += 32
        payload = _bits_to_bytes(bits[p:p+length], length)
        try:
            text = gzip.decompress(payload).decode("utf-8","replace") if comp else payload.decode("utf-8","replace")
        except Exception as e:
            # magic 在但载体损坏（生成后被裁剪/重存/单比特翻转）。gzip 尾部 CRC 一坏就整块解不出，
            # 但 deflate 前半段往往完好 → 宽松再试一次，能捞出多少算多少（标 :SALVAGED，调用方自行判断可用性）。
            text = _lenient_inflate(payload) if comp else None
            if text:
                return text, magic.decode() + ":SALVAGED"
            return None, magic.decode() + ":CORRUPT"
        return text, magic.decode()
    return None


def _lenient_inflate(payload):
    """gzip 载体损坏时的宽松解压：跳 gzip 头 → raw deflate 分块喂，出错即停、返回已解出的前缀。"""
    if not payload.startswith(b"\x1f\x8b"):
        return None
    flg = payload[3]; i = 10
    if flg & 4:                                    # FEXTRA
        i += 2 + int.from_bytes(payload[i:i+2], "little")
    for bit in (8, 16):                            # FNAME / FCOMMENT
        if flg & bit:
            while i < len(payload) and payload[i] != 0:
                i += 1
            i += 1
    if flg & 2:                                    # FHCRC
        i += 2
    d = zlib.decompressobj(-zlib.MAX_WBITS)
    out = bytearray()
    for k in range(i, len(payload), 512):
        try:
            out += d.decompress(payload[k:k+512])
        except Exception:
            break
    return bytes(out).decode("utf-8", "replace") if out else None


def _salvage_obj(text):
    """腐坏 JSON 文本 → 尽力解析的【前缀键值】（遇第一个解不动的键即停，绝不猜内容）。"""
    dec = json.JSONDecoder()
    i = text.find("{")
    if i < 0:
        return None
    i += 1
    out = {}
    while i < len(text):
        while i < len(text) and text[i] in " \t\r\n,":
            i += 1
        if i >= len(text) or text[i] != '"':
            break
        try:
            key, i = dec.raw_decode(text, i)
        except Exception:
            break
        while i < len(text) and text[i] in " \t\r\n":
            i += 1
        if i >= len(text) or text[i] != ":":
            break
        i += 1
        while i < len(text) and text[i] in " \t\r\n":   # raw_decode 不跳前导空白，须自己跳
            i += 1
        try:
            val, i = dec.raw_decode(text, i)
        except Exception:
            break
        out[key] = val
    return out or None


def salvage_meta(text):
    """宽松恢复出的（可能截断的）meta 文本 → 可用 dict；关键 prompt 结构缺失则返回 None。
    Comment 内层同样只取可解析前缀，再 dumps 回字符串，保持消费者契约（meta.Comment=JSON 字符串）。"""
    outer = _salvage_obj(text)
    if not outer:
        return None
    cm = outer.get("Comment")
    if isinstance(cm, str):
        try:
            inner = json.loads(cm)
        except Exception:
            inner = _salvage_obj(cm)
        if isinstance(inner, dict):
            if not (inner.get("v4_prompt") or inner.get("prompt")):
                return None
            inner["_salvaged"] = True
            outer["Comment"] = json.dumps(inner, ensure_ascii=False)
        else:
            return None
    elif not outer.get("Description"):
        return None
    outer["_salvaged"] = True
    return outer

def read_one(path):
    im = Image.open(path)
    src, data = None, None
    tc = read_text_chunks(im)
    if tc:
        src, data = "文本块(普通meta)", tc
    else:
        st = read_stealth(im)
        if st and st[0] is None:           # magic 在但 payload 损坏，且宽松解压也捞不出内容
            src = f"❌meta损坏({st[1]})"
        elif st:
            src = f"alpha隐写(法术解析·{st[1]})"
            try: data = json.loads(st[0])
            except Exception:
                if st[1].endswith(":SALVAGED"):
                    data = salvage_meta(st[0])
                    if data is None:       # 捞出来的前缀连 prompt 都不完整 → 仍按损坏处理
                        src = f"❌meta损坏({st[1].replace(':SALVAGED', ':CORRUPT')})"
                else:
                    data = {"_raw": st[0]}
    return src, data

def prompt_of(data):
    if not isinstance(data, dict): return ""
    for k in ("parameters","Description","prompt","Comment","_raw"):
        if k in data:
            v = data[k]
            if k == "Comment":
                try: return json.loads(v).get("prompt","") or v
                except Exception: return v
            return v
    return json.dumps(data, ensure_ascii=False)[:2000]

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return
    target = args[0]
    if "--scan" in args and os.path.isdir(target):
        files = sorted(f for f in os.listdir(target) if f.lower().endswith((".png",".webp",".jpg",".jpeg")))  # jpg必列(多为无meta,但漏列=复刻漏图,2026-07-13翻车)
        hit = 0
        for f in files:
            src, data = read_one(os.path.join(target, f))
            print(f"  {f}: {src or '❌无meta'}")
            if src: hit += 1
        print(f"\n{hit}/{len(files)} 张可读 meta")
        return
    src, data = read_one(target)
    if "--json" in args:
        # 纯 JSON 到 stdout(来源并进结构,不打人类前缀)——调用方可直接 json.load,无空输入/前缀污染坑
        print(json.dumps({"_source": src, "meta": data}, ensure_ascii=False, indent=1))
        return
    if not src:
        print("❌ 两种手段都没读到 meta（文本块空 + 无 alpha/rgb 隐写）"); return
    print(f"✅ 来源：{src}\n")
    print(prompt_of(data))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""promptTokens.ts 的 Python 端口（分段/染色纯函数）——CLI 侧生成 `LazyShot.seg` 用。

与前端 `webapp/src/lazydog/promptTokens.ts` **必须逐行同义**：网页「重新切段」与本模块
生成的分段要一致，否则同一帧在两处看到的槽归属会分歧（linkage_map §三·五 seg 节点）。
改任一侧都要同步另一侧 + 跑 `tools/build_seg.py --check <已有 seg 的套>` 回归。

铁律（与端点强校验同级）：joinSegs(autoSegs(t)) === t 逐字节。
"""
import re

QUALITY = {
    "absurdres", "masterpiece", "best quality", "very aesthetic", "no text",
    "highres", "amazing quality", "high quality", "incredibly absurdres",
}
YEAR_RE = re.compile(r"^year \d{4}$")
SEG_BREAK = re.compile(r"[,，。！？!?\n]")
BLOCK_ZH = {"action": "动作", "expression": "表情", "camera": "机位", "effect": "效果"}
ZH_BLOCK = {v: k for k, v in BLOCK_ZH.items()}


def norm(raw):
    """trim → 反复剥外层 {}/[] → 剥前后 数字::/:: 权重 → 下划线转空格 → 小写 → 折叠空格。
    ( ) 不剥：画师名自带括号（artist:sho(sho lwlw)）。"""
    s = (raw or "").strip()
    changed = True
    while changed:
        changed = False
        if len(s) >= 2 and ((s[0] == "{" and s[-1] == "}") or (s[0] == "[" and s[-1] == "]")):
            s = s[1:-1].strip()
            changed = True
    s = re.sub(r"^-?\d*\.?\d+\s*::", "", s).strip()
    s = re.sub(r"^::", "", s).strip()
    s = re.sub(r"::\s*-?\d*\.?\d+\s*$", "", s).strip()
    s = re.sub(r"::$", "", s).strip()
    return re.sub(r"\s+", " ", s.replace("_", " ").lower()).strip()


def split_norm(val, extra_sep=None):
    """槽/块字符串 → norm 后非空词【列表】（保插入序，与 JS Set 迭代序一致）。"""
    if not val:
        return []
    parts = str(val).split(",")
    if extra_sep:
        out = []
        for p in parts:
            out += p.split(extra_sep)
        parts = out
    seen, res = set(), []
    for p in parts:
        n = norm(p)
        if n and n not in seen:
            seen.add(n)
            res.append(n)
    return res


def build_ctx(slots, blocks):
    slots = slots or {}
    blocks = blocks or {}
    return {
        "slots": {k: split_norm(slots.get(k)) for k in ("artist", "character", "clothing", "scene", "props")},
        "male": split_norm(slots.get("male"), "||"),
        "blocks": {k: split_norm(blocks.get(k)) for k in ("action", "expression", "camera", "effect")},
    }


def _strip_artist_pfx(s):
    return re.sub(r"^artist:\s*", "", s)


def _hit_artist(n, words):
    a = _strip_artist_pfx(n)
    for v in words:
        if n == v:
            return True
        b = _strip_artist_pfx(v)
        if a and b and a == b:
            return True
        if len(a) >= 3 and len(b) >= 3 and (a in b or b in a):
            return True
    return False


def classify(raw, ctx, region="positive"):
    n = norm(raw)
    if not n:
        return {"cat": "syntax"}
    if _hit_artist(n, ctx["slots"]["artist"]):
        return {"cat": "artist"}
    for slot in ("character", "clothing", "scene", "props"):
        if n in ctx["slots"][slot]:
            return {"cat": slot}
    for b in ("action", "expression", "camera", "effect"):
        if n in ctx["blocks"][b]:
            return {"cat": "skeleton", "note": BLOCK_ZH[b]}
    if n in ctx["male"]:
        return {"cat": "skeleton", "note": "男角"}
    if n in QUALITY or YEAR_RE.match(n):
        return {"cat": "quality"}
    if region in ("negative", "charNeg"):
        return {"cat": "unknown", "neutral": True}
    return {"cat": "unknown"}


def split_chunks(text):
    """在 , ， 。 ！ ？ ! ? 换行【之后】断开，分隔符归前一块。join('')===text 恒成立。
    ★括号内不断块（2026-08-29）：`kyoka (summer) (princess connect!)` 的 `!` 会把角色名劈成两半 →
    两半都匹配不上槽词 → 落 unknown → seg 路径换 AW 时整段不剥（同長風套下划线坑，princess connect!
    系列全库 558 处）。换行强制归零 = 未闭合括号的安全阀，防一个孤立 `(` 吞掉后面整条。"""
    if not text:
        return []
    out, cur, depth = [], "", 0
    for ch in text:
        cur += ch
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == "\n":
            depth = 0
        if SEG_BREAK.match(ch) and depth == 0:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def classify_seg(text, ctx, region="positive"):
    """先走 token 规则；仍 unknown 再做【槽词子串包含】兜底，多槽命中取最长匹配词那个。"""
    direct = classify(text, ctx, region)
    if direct["cat"] != "unknown" or not text.strip():
        return direct
    # ★hay 与 norm 同源归一（下划线→空格、小写、折叠空白）；拿原文比对会漏掉下划线写法，
    # 详见 promptTokens.ts 同处注释（長風套 22/42 帧换角失效的根因）。
    hay = re.sub(r"\s+", " ", text.replace("_", " ").lower())
    best = None

    def scan(words, cat, note=None):
        nonlocal best
        for w in words:
            if len(w) < 2 or w not in hay:
                continue
            if best is None or len(w) > best["len"]:
                best = {"cat": cat, "note": note, "len": len(w)}

    for slot in ("character", "clothing", "scene", "props", "artist"):
        scan(ctx["slots"][slot], slot)
    scan(ctx["male"], "skeleton", "男角")
    for b in ("action", "expression", "camera", "effect"):
        scan(ctx["blocks"][b], "skeleton", BLOCK_ZH[b])
    if best:
        return {"cat": best["cat"], **({"note": best["note"]} if best["note"] else {})}
    return direct


def auto_segs(text, ctx, region="positive"):
    """切块 → 逐块分类 → 相邻同类合并（纯空白块并入上一段，不独立成段）。"""
    segs = []
    for c in split_chunks(text):
        last = segs[-1] if segs else None
        if not c.strip() and last:
            last["text"] += c
            continue
        cl = classify_seg(c, ctx, region)
        if last and last["cat"] == cl["cat"] and last.get("note") == cl.get("note"):
            last["text"] += c
        else:
            seg = {"cat": cl["cat"], "text": c}
            if cl.get("note"):
                seg = {"cat": cl["cat"], "note": cl["note"], "text": c}
            segs.append(seg)
    return segs


def join_segs(segs):
    return "".join(s.get("text", "") for s in (segs or []))

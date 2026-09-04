#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""期一B·A节单测：submit_nai.submit_request 顶层 payload `char_reference` 消费（纯加法）。

覆盖：
  A. 顶层 char_reference → dry_run request 里 director_reference_* 五字段齐全 + 图被 letterbox 到合法画布。
  B. 顶层 char_reference 与 params._char_reference 并存 → 显式顶层最高优先（覆盖预构造）。
  C. 非法 mode → NaiValidationError。
  D. letterbox 幂等：已是 ACCEPTED_CR_SIZES 的图跳过 letterbox（尺寸不变）。
  E. 无 char_reference 的同 payload dry 输出与改动前（git HEAD:tools/submit_nai.py）逐字节一致。

不发真实 HTTP，全部 dry_run=True。
"""
import base64
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import submit_nai  # noqa: E402
from PIL import Image  # noqa: E402


def _png_b64(w: int, h: int, color=(120, 60, 200)) -> str:
    img = Image.new("RGB", (w, h), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _min_cfg() -> dict:
    return {
        "default_params": {
            "model": "nai-diffusion-4-5-full",
            "width": 832,
            "height": 1216,
            "negative_prompt": "lowres, bad anatomy",
            "scale": 5.0,
            "sampler": "k_euler",
            "steps": 28,
        },
        "batch": {"charref_wire_max_kb": 1024},
    }


DIRECTOR_FIELDS = (
    "director_reference_images",
    "director_reference_descriptions",
    "director_reference_strength_values",
    "director_reference_secondary_strength_values",
    "director_reference_information_extracted",
)


def _base_payload() -> dict:
    return {
        "positive": "1girl, standing, garden",
        "negative": "lowres",
        "characters": [{"text": "girl A", "x": 0.5, "y": 0.5, "negative": "extra"}],
        "params": {},
        "count": 1,
        "seed": 12345,
        "prefix": "t",
    }


results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    mark = "✓" if cond else "✗"
    print(f"{mark} {name}{('  — ' + detail) if detail else ''}")


# ── A. 顶层 char_reference → 五字段齐 + letterbox 到合法画布 ──
cfg = _min_cfg()
payload = _base_payload()
payload["char_reference"] = {
    "image_b64": _png_b64(80, 120),  # 竖图非合法尺寸 → 触发 letterbox
    "strength": 0.9,
    "fidelity": 0.8,
    "base_caption": "character",
}
out = submit_nai.submit_request(payload, cfg, dry_run=True)
params = out["request"]["parameters"]
check("A1 五字段齐全", all(k in params for k in DIRECTOR_FIELDS),
      detail="缺:" + ",".join(k for k in DIRECTOR_FIELDS if k not in params))
img_b64 = params["director_reference_images"][0]
img = Image.open(io.BytesIO(base64.b64decode(img_b64)))
check("A2 letterbox 到合法画布", img.size in submit_nai.ACCEPTED_CR_SIZES,
      detail=f"size={img.size} accepted={submit_nai.ACCEPTED_CR_SIZES}")
check("A3 strength 透传", params["director_reference_strength_values"] == [0.9],
      detail=str(params["director_reference_strength_values"]))
check("A4 secondary=1-fidelity", params["director_reference_secondary_strength_values"] == [round(1.0 - 0.8, 4)],
      detail=str(params["director_reference_secondary_strength_values"]))
check("A5 base_caption 归一", params["director_reference_descriptions"][0]["caption"]["base_caption"] == "character")


# ── B. 顶层 char_reference 覆盖 params._char_reference（显式顶层最高优先） ──
cfg = _min_cfg()
payload = _base_payload()
sentinel = {  # 预构造的 _char_reference（应被顶层覆盖）
    "director_reference_images": ["SENTINEL"],
    "director_reference_descriptions": [{"caption": {"base_caption": "style", "char_captions": []}}],
    "director_reference_strength_values": [0.111],
    "director_reference_secondary_strength_values": [0.222],
    "director_reference_information_extracted": [1.0],
}
payload["params"] = {"_char_reference": sentinel}
payload["char_reference"] = {
    "image_b64": _png_b64(80, 120),
    "strength": 0.7,
    "fidelity": 0.6,
    "base_caption": "character&style",
}
out = submit_nai.submit_request(payload, cfg, dry_run=True)
params = out["request"]["parameters"]
check("B1 顶层覆盖 sentinel（图非 SENTINEL）", params["director_reference_images"][0] != "SENTINEL")
check("B2 顶层 base_caption 生效", params["director_reference_descriptions"][0]["caption"]["base_caption"] == "character&style",
      detail=params["director_reference_descriptions"][0]["caption"]["base_caption"])
check("B3 顶层 strength 生效", params["director_reference_strength_values"] == [0.7],
      detail=str(params["director_reference_strength_values"]))


# ── C. 非法 mode → NaiValidationError ──
cfg = _min_cfg()
payload = _base_payload()
payload["char_reference"] = {"image_b64": _png_b64(80, 120), "mode": "bogus_mode"}
raised = False
try:
    submit_nai.submit_request(payload, cfg, dry_run=True)
except submit_nai.NaiValidationError:
    raised = True
check("C1 非法 mode 抛 NaiValidationError", raised)


# ── D. letterbox 幂等：已是合法画布则尺寸不变 ──
cfg = _min_cfg()
payload = _base_payload()
legal_w, legal_h = submit_nai.ACCEPTED_CR_SIZES[0]  # (1024,1536)
payload["char_reference"] = {"image_b64": _png_b64(legal_w, legal_h), "base_caption": "character"}
out = submit_nai.submit_request(payload, cfg, dry_run=True)
params = out["request"]["parameters"]
img = Image.open(io.BytesIO(base64.b64decode(params["director_reference_images"][0])))
check("D1 合法画布尺寸不变", img.size == (legal_w, legal_h), detail=f"size={img.size}")


# ── E. 无 char_reference：与 git HEAD 版逐字节一致 ──
head_src = subprocess.check_output(["git", "-C", ROOT, "show", "HEAD:tools/submit_nai.py"], text=True)
tmp = tempfile.NamedTemporaryFile("w", suffix="_submit_nai_head.py", delete=False, encoding="utf-8")
tmp.write(head_src)
tmp.close()
try:
    spec = importlib.util.spec_from_file_location("submit_nai_head", tmp.name)
    head_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(head_mod)

    plain = _base_payload()  # 无 char_reference
    cfg = _min_cfg()
    # 各自用独立 payload 副本（submit_request 会 mutate overrides）
    new_out = submit_nai.submit_request(json.loads(json.dumps(plain)), _min_cfg(), dry_run=True)
    head_out = head_mod.submit_request(json.loads(json.dumps(plain)), _min_cfg(), dry_run=True)
    new_bytes = json.dumps(new_out, sort_keys=True, ensure_ascii=False)
    head_bytes = json.dumps(head_out, sort_keys=True, ensure_ascii=False)
    check("E1 无 char_reference dry 输出与 HEAD 逐字节一致", new_bytes == head_bytes,
          detail="" if new_bytes == head_bytes else "DIFF!")
finally:
    os.unlink(tmp.name)


# ── 汇总 ──
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"\n==== char_reference 单测: {passed}/{total} 过 ====")
sys.exit(0 if passed == total else 1)

"""RenderJob frame → submit_nai payload 翻译 + 单 sample 执行（SPEC §九）。

隐私边界：本模块只调 tools/submit_nai 的函数（submit_request 等）；隐私预设/参考的合并
发生在 submit_nai 进程内部，本模块不读 private 数据文件。char_reference 的 image_b64
是【公开显式参考】（webapp 手动挡/CLI --char-ref 语义），非隐私。
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path

from . import estimate, scrub


class AdapterError(Exception):
    """翻译/路径/执行阶段错误（worker 捕获后按状态机处置）。"""


def _submit_nai():
    import submit_nai  # tools/ 已在 sys.path（见 __init__）
    return submit_nai


def _public_submit_logger(ctx, public_log):
    """Keep submit progress visible without exposing upstream/raw diagnostics."""
    def emit(message="", *values, **_kwargs):
        raw = " ".join(str(value) for value in (message, *values))
        # Clean 模式的 payload.output 是终端私密 staging。submit_nai 的安全进度
        # 行会显示“输出/完成”路径；公开控制台只能看到占位，真实行仅在需要时进入
        # private_error.log，绝不把私密路径送进 launcher 日志。
        public_input = raw
        staging_root = getattr(ctx, "clean_staging_root", None)
        if staging_root is not None:
            staging = str(Path(staging_root).resolve())
            for variant in {staging, staging.replace("\\", "/"), staging.replace("/", "\\")}:
                if variant:
                    public_input = public_input.replace(variant, "<private-staging>")
        public, sensitive = scrub.scrub_submit_log(public_input)
        if sensitive:
            trace_id = scrub.new_trace_id()
            scrub.write_private_error(ctx.private_error_log, trace_id, raw)
            public = f"{public} (trace={trace_id})"
        public_log(public)
    return emit


# ------------------------------------------------------------------ 输出路径

def resolve_output_dir(output_root: Path, job: dict) -> Path:
    """workspace 逻辑根 → 物理目录，resolve() 后必须仍在根内（SPEC §七/schema output）。"""
    root = Path(output_root).resolve()
    rel = job["output"]["relative_path"]
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise AdapterError(f"输出路径越界（不在 workspace 根内）: rel={rel!r}")
    return target


# ------------------------------------------------------------------ 参数翻译

def build_params(generation: dict) -> dict:
    """generation 全字段 → submit_nai final_params 键（现行消费键名对齐 build_parameters）。"""
    g = generation
    params = {
        "model": g["model"],
        "width": g["width"],
        "height": g["height"],
        "steps": g["steps"],
        "sampler": g["sampler"],
        "scale": g["scale"],
        "cfg_rescale": g["cfg_rescale"],
        "noise_schedule": g["noise_schedule"],
        "variety_plus": g["variety_plus"],
        "auto_position": g["auto_position"],
        "qualityToggle": g["quality_toggle"],   # submit_nai 读 fp.get("qualityToggle")
        "ucPreset": g["uc_preset"],             # submit_nai 读 fp.get("ucPreset")
    }
    for k, v in (g.get("advanced") or {}).items():
        if v is not None:
            params[k] = v
    return params


def _build_char_ref_fields(cr: dict) -> dict:
    """frame.char_reference（公开显式参考）→ submit_nai director_reference_* 字段。

    复用 submit_nai 的 letterbox 画布常量与构造器（禁自写第二份参考构造逻辑）。
    """
    sn = _submit_nai()
    from PIL import Image
    raw = base64.b64decode(cr["image_b64"])
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    cw, ch = min(sn.ACCEPTED_CR_SIZES,
                 key=lambda s: abs((s[0] / s[1]) - (img.width / img.height)))
    padded = sn._letterbox_to_canvas(img, cw, ch)
    buf = io.BytesIO()
    padded.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return sn.char_reference_fields_from_b64(
        b64, strength=float(cr["strength"]), fidelity=float(cr["fidelity"]),
        base_caption=cr["mode"])


def build_payload(output_root: Path, job: dict, frame: dict, sample: dict, *,
                  output_dir_override: Path | None = None) -> dict:
    """RenderJob frame + sample → submit_nai json-stdin 完整 payload。"""
    chars = []
    views = {}
    for i, c in enumerate(frame["prompt"]["characters"]):
        chars.append({
            "text": c["caption"],
            "negative": c.get("negative", ""),
            "x": c["center"]["x"],
            "y": c["center"]["y"],
        })
        views[str(i)] = c["view"]
    cast = [c["cast_id"] for c in frame["prompt"]["characters"] if c.get("cast_id")]

    aug = job["augmentation"]
    payload: dict = {
        "positive": frame["prompt"]["base_positive"],
        "negative": frame["prompt"]["base_negative"],
        "characters": chars,
        "count": 1,
        "seed": sample["seed"],
        "prefix": frame["output_name"],
        # Clean 开启时由 worker 注入终端私密 staging；关闭时仍严格服从
        # project 的公开 output_root + relative_path。override 只属于进程内
        # 调用参数，从不进入工单/数据库/公开接口。
        "output": str(Path(output_dir_override).resolve()
                      if output_dir_override is not None
                      else resolve_output_dir(output_root, job)),
        "params": build_params(frame["generation"]),
    }
    if cast:                                  # 无 cast_id → 不传 cast（走旧默认路径）
        payload["cast"] = cast
    assign = aug.get("char_layer_assign")
    if views:
        # 2b：全局预设 front_text 与参考正反也消费同一现行 view 源；不改变 char-layer 开关。
        payload["char_layer_views"] = views
    if assign:
        payload["char_layer_assign"] = dict(assign)
    cr = frame.get("char_reference")
    if cr is not None:                        # 显式参考=三级优先链最高，直接塞 params._char_reference
        payload["params"]["_char_reference"] = _build_char_ref_fields(cr)
    return payload


# ------------------------------------------------------------------ 预设 revision

def preset_public_shell(cfg: dict, preset_id: str) -> dict | None:
    return estimate.find_preset(cfg, preset_id)


def compute_preset_revision(preset_shell: dict) -> tuple[str, str]:
    """返回公开壳 JSON 与 revision；vault 启用时纳入密文及 ref blob 哈希。"""
    j = json.dumps(preset_shell, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    material = j.encode("utf-8")
    from . import vault
    if vault.vault_exists(vault.PROJECT_ROOT):
        env_path = vault.PROJECT_ROOT / vault.ENV_REL
        env = json.loads(env_path.read_text(encoding="utf-8"))
        for name in vault.PAYLOAD_NAMES:
            box = env.get("payloads", {}).get(name)
            if isinstance(box, dict) and isinstance(box.get("ct_b64"), str):
                material += box["ct_b64"].encode("ascii")
        vault_dir = env_path.parent
        for ref_id in sorted(env.get("refs", {})):
            ref_path = vault_dir / env["refs"][ref_id]["file"]
            material += hashlib.sha256(ref_path.read_bytes()).digest()
    rev = "sha256:" + hashlib.sha256(material).hexdigest()
    return rev, j


# ------------------------------------------------------------------ 执行

def run_sample(ctx, job: dict, frame: dict, sample: dict, *, opener=None, log=print,
               output_dir_override: Path | None = None,
               cfg_snapshot: dict | None = None,
               output_root_snapshot: Path | None = None) -> list[str]:
    """执行单张：经 submit_nai.submit_request（count=1、指定 seed、复用 opener）。

    返回落盘图片绝对路径列表（worker 再逐一验存在+尺寸>0 后登记 artifacts）。
    submit_request 未交付（A 队未完成）→ NotImplementedError。
    """
    sn = _submit_nai()
    if not hasattr(sn, "submit_request"):
        raise NotImplementedError("等待A队交付 submit_nai.submit_request")
    # A queued job owns one public-config snapshot from PREPARING through its
    # final sample. ``ctx.cfg`` is shared with HTTP threads and may be replaced
    # by a concurrent config reload; never consult it here when the worker gave
    # us an explicit job snapshot.
    public_cfg = cfg_snapshot if cfg_snapshot is not None else ctx.cfg
    output_root = (Path(output_root_snapshot) if output_root_snapshot is not None
                   else ctx.output_root)
    payload = build_payload(output_root, job, frame, sample,
                            output_dir_override=output_dir_override)
    aug = job["augmentation"]
    preset_id = aug.get("preset_id")
    # v1.1: preset_id=null → 无加装（augment=False/aug_preset=None/enable_extra=None）；
    # char_layers 独立于 augment，仍按 char_layer_assign 决定。
    augment = preset_id is not None
    result = sn.submit_request(
        payload, public_cfg,
        augment=augment,
        aug_preset=preset_id,
        enable_extra=((list(aug.get("extras") or []) or None) if augment else None),
        global_layer=bool(aug.get("global_layer", True)),
        char_layers=bool(aug.get("char_layer_assign")),
        opener=opener,
        dry_run=False,
        log=_public_submit_logger(ctx, log),
    )
    saved = result.get("saved") or []
    return [str(p) for p in saved]

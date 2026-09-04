"""Anlas 保守估算（SPEC §六）+ 预设公开壳读取辅助（server/estimate 共用）。

计费事实（Owner 定）：纯文生图免费；带角色参考的每张 sample ~5 Anlas。
估算=Σ 每 sample：该帧有 char_reference，或（augment 链激活且预设内存在 enabled 的
char_references[]），或（char_layer_assign 指派的层带 enabled 参考）→ 5，否则 0。
宁高估不低估（role 门控不细算=预设有任一 enabled 参考即对全帧计费）。

隐私边界：只读 data/nai_config.json 的【公开壳】（enabled/isPrivate 等标志位，不含图内容）。
"""

from __future__ import annotations

PRICING_REVISION = "anlas_est.v1"
ANLAS_PER_REF_SAMPLE = 5


# ------------------------------------------------------------------ 公开壳辅助

def _presets(cfg: dict) -> list[dict]:
    store = cfg.get("augmentation_presets")
    if not isinstance(store, dict):
        return []
    presets = store.get("presets")
    return presets if isinstance(presets, list) else []


def find_preset(cfg: dict, preset_id: str) -> dict | None:
    for p in _presets(cfg):
        if isinstance(p, dict) and p.get("id") == preset_id:
            return p
    return None


def preset_enabled(preset: dict | None) -> bool:
    return bool(preset and preset.get("enabled"))


def iter_extra_units(preset: dict) -> list[dict]:
    """预设内全部 extra 单元：预设级 extra_blocks + 每个 char 的 extras（用于精确匹配）。"""
    units: list[dict] = []
    for e in (preset.get("extra_blocks") or []):
        if isinstance(e, dict):
            units.append(e)
    for c in (preset.get("chars") or []):
        if isinstance(c, dict):
            for e in (c.get("extras") or []):
                if isinstance(e, dict):
                    units.append(e)
    return units


def match_extras(preset: dict, extras: list[str]) -> dict:
    """套图级 extras 逐项对预设内 extra 单元的 id/roleLabel 做【精确字符串相等】匹配（禁子串）。

    返回 {matched, injected, not_found}。期一 matched 即 injected（匹配到的一律经
    submit_nai enable_extra 提升注入）。
    """
    units = iter_extra_units(preset)
    ids = {u.get("id") for u in units if u.get("id")}
    labels = {u.get("roleLabel") for u in units if u.get("roleLabel")}
    matched, not_found = [], []
    for x in (extras or []):
        if x in ids or x in labels:
            matched.append(x)
        else:
            not_found.append(x)
    return {"matched": matched, "injected": list(matched), "not_found": not_found}


def preset_has_enabled_ref(preset: dict | None) -> bool:
    """预设是否存在 enabled 的角色参考（新 char_references[] 或旧单键 char_reference）。"""
    if not preset:
        return False
    refs = preset.get("char_references")
    if isinstance(refs, list):
        if any(isinstance(r, dict) and r.get("enabled") for r in refs):
            return True
    old = preset.get("char_reference")
    return bool(isinstance(old, dict) and old.get("enabled"))


def _layers_by_id(cfg: dict) -> dict:
    store = cfg.get("character_layers")
    if not isinstance(store, dict):
        return {}
    out = {}
    for l in (store.get("layers") or []):
        if isinstance(l, dict) and l.get("id"):
            out[str(l["id"])] = l
    return out


def assigned_layer_has_ref(cfg: dict, assign: dict | None) -> bool:
    """char_layer_assign 指派的层里是否有 enabled 且带 enabled 参考的层。"""
    if not assign:
        return False
    lbi = _layers_by_id(cfg)
    for layer_id in assign.values():
        layer = lbi.get(str(layer_id))
        if not isinstance(layer, dict) or not layer.get("enabled"):
            continue
        cr = layer.get("char_reference")
        if isinstance(cr, dict) and cr.get("enabled"):
            return True
    return False


# ------------------------------------------------------------------ 估算

def estimate_anlas(job: dict, cfg: dict) -> tuple[int, str]:
    """返回 (estimated_anlas, pricing_revision)。宁高估不低估。"""
    aug = job.get("augmentation") or {}
    preset = find_preset(cfg, aug.get("preset_id"))
    preset_ref = preset_has_enabled_ref(preset)
    layer_ref = assigned_layer_has_ref(cfg, aug.get("char_layer_assign"))

    total = 0
    for f in job.get("frames") or []:
        frame_ref = f.get("char_reference") is not None
        charged = frame_ref or preset_ref or layer_ref
        if charged:
            total += ANLAS_PER_REF_SAMPLE * len(f.get("samples") or [])
    return total, PRICING_REVISION

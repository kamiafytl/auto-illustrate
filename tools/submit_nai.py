#!/usr/bin/env python3
"""NovelAI API 内部引擎 — 只由 NAI 出图终端进程 import 调用。

读取 data/nai_config.json (API Token、代理、默认参数)，POST 到 NAI API
下载返回的 ZIP，解出 PNG 保存到输出目录。

安全边界：直接 CLI 实际提交已禁用，所有跑图必须投递终端统一工单。
CLI 仅保留不加载任何私密层的安全 dry-run，供公开 payload 调试；不会输出私密最终 prompt。

以下历史用法只作 payload 形状说明，不再可用于实跑：

  1) 命令行参数模式（简单单提交）:
     python3 tools/submit_nai.py "1girl, smile, masterpiece"               # 单张
     python3 tools/submit_nai.py "1girl, ..." --count 10                   # 跑 10 张
     python3 tools/submit_nai.py "1girl, ..." --negative "bad anatomy"     # 覆盖负向
     python3 tools/submit_nai.py "1girl, ..." --width 1024 --height 1024   # 覆盖尺寸
     python3 tools/submit_nai.py "1girl, ..." --model nai-diffusion-3      # 覆盖模型
     python3 tools/submit_nai.py "1girl, ..." --seed 12345                 # 指定 seed
     python3 tools/submit_nai.py "1girl, ..." --prefix test_run            # 文件名前缀

  2) JSON stdin 模式（完整 payload，webapp 用）:
     echo '{"positive": "...", "characters": [...], "params": {...}}' \\
        | python3 tools/submit_nai.py --json-stdin

     JSON 结构:
     {
       "positive": "基础正向 prompt（合并 baseBlocks 后的文本）",
       "negative": "负向 prompt（可选，不传则用 nai_config 默认）",
       "characters": [                              // 可选
         {"text": "角色 prompt", "x": 0.5, "y": 0.5}
       ],
       "params": {                                  // 可选，覆盖默认参数
         "model": "nai-diffusion-4-5-full",
         "width": 832, "height": 1216,
         "steps": 28, "scale": 5.0, ...
       },
       "count": 1,                                  // 默认 1
       "prefix": "...",                             // 文件名前缀
       "seed": 12345                                // 可选指定 seed
     }
"""
import argparse
import contextlib
import io
import json
import os
import random
import re
import sys
import time
import urllib.request
import urllib.error
import zipfile
from datetime import datetime
from pathlib import Path

try:
    import fcntl  # POSIX 文件锁（全局生成锁·物理串行防 429）；非 POSIX 平台优雅降级
except ImportError:  # pragma: no cover
    fcntl = None

TOOLS_DIR = Path(__file__).parent
PROJECT_ROOT = TOOLS_DIR.parent
CONFIG_PATH = PROJECT_ROOT / "data" / "nai_config.json"

NAI_API_URL = "https://image.novelai.net/ai/generate-image"

# ── 异常体系（worker 模块调用面用；CLI 入口 catch 后打印原文案+原退出码，行为逐字节不变） ──
class NaiError(Exception):
    """NAI 提交业务异常基类。"""


class NaiConfigError(NaiError):
    """配置缺失/损坏（原 load_config 的 sys.exit(1) 场景）。"""


class NaiValidationError(NaiError):
    """请求构建期的语义校验失败（原 build_parameters 的 SystemExit 场景）。"""


# ── NAI 全局生成锁（429 根治·过渡保险）：所有进程/线程共用此文件锁=物理串行 ──
# 临界区=单次 post_nai + save_images_from_zip；重试的 sleep 在锁外（不抱锁睡觉挡别人）。
GEN_LOCK_PATH = PROJECT_ROOT / "data" / "nai_gen.lock"


@contextlib.contextmanager
def _gen_lock():
    """独占 data/nai_gen.lock（阻塞等待）。fcntl 不可用时降级为空上下文（非 POSIX）。"""
    if fcntl is None:
        yield
        return
    GEN_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    f = open(GEN_LOCK_PATH, "w")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        finally:
            f.close()

# V4 系列模型识别（强制 noise_schedule=karras，移除 sm/sm_dyn）
V4_MODEL_PREFIXES = ("nai-diffusion-4",)
# V5 系列（2026-08-21 发布）：沿用 v4_prompt/v4_negative_prompt/characterPrompts 结构，
# 但 params_version 3→4；尚未上线 Precise Reference / Vibe Transfer。
V5_MODEL_PREFIXES = ("nai-diffusion-5",)

# params_version 与模型的对应关系（联动登记见 internal-docs §六·五）：
#   V5 = 4；V4.5 及更早 = 3。final_params 显式给 params_version 时以显式值为准。
PARAMS_VERSION_V5 = 4
PARAMS_VERSION_DEFAULT = 3

# V5 配额（"充电电池"池）查询端点：只读，不消耗额度、不产生费用。
NAI_SUBSCRIPTION_URL = "https://image.novelai.net/user/subscription"

# 本地污染检测：以下 token 不应出现在 NAI prompt 里
LOCAL_POLLUTION_TOKENS = [
    "BREAK",
    "awa画师", "awa下新画师",
    "<lora:",
]


def check_pollution(label: str, text: str) -> list[str]:
    """扫文本里有没有本地污染 token，返回命中的列表。"""
    if not text:
        return []
    hits = []
    for tok in LOCAL_POLLUTION_TOKENS:
        if tok in text:
            hits.append(tok)
    return hits


def sanity_check_json_stdin(positive: str, negative: str, characters: list[dict]):
    """json-stdin 模式入口处守门：发现本地污染立即 warning 到 stderr（不拒绝，可能用户有意）。"""
    warnings = []
    for hit in check_pollution("positive", positive):
        warnings.append(f"positive 含 {hit!r}")
    for hit in check_pollution("negative", negative):
        warnings.append(f"negative 含 {hit!r}")
    for i, c in enumerate(characters or []):
        for hit in check_pollution(f"char[{i}]", c.get("text", "")):
            warnings.append(f"char[{i}] 含 {hit!r}")
    if warnings:
        print("⚠ NAI 本地污染告警（NAI 不识别以下 token，会变成噪声）:", file=sys.stderr)
        for w in warnings:
            print(f"    - {w}", file=sys.stderr)
        print("  如果是有意为之，忽略本告警；否则改成 NAI 原生语法。", file=sys.stderr)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        # 不再 sys.exit：抛 NaiConfigError，CLI 入口 catch 后打印原两行文案+退出码 1（byte 一致）。
        raise NaiConfigError(f"config missing: {CONFIG_PATH}")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


PRIVATE_BLOCKS_PATH = PROJECT_ROOT / "data" / "private_blocks.json"


def _comma_join(a: str, b: str) -> str:
    """把两段 tag 文本用 ', ' 拼接（去掉相邻的尾逗号），任一为空则返回另一段。"""
    a = (a or "").strip()
    b = (b or "").strip()
    if not a:
        return b
    if not b:
        return a
    return a.rstrip(",").rstrip() + ", " + b


def _read_private_blocks() -> dict:
    """读取 private_blocks.json（脚本读，AI 本体不读）。"""
    if PRIVATE_BLOCKS_PATH.exists():
        try:
            return json.loads(PRIVATE_BLOCKS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


# ★加装层 persona 独立文件(2026-06-16 从 private_blocks 物理分离,根除组装棚覆盖写抹掉 persona 的 bug)
AUGMENT_PRIVATE_PATH = PROJECT_ROOT / "data" / "nai_augment_private.json"


def _read_augment_private() -> dict:
    """读取加装层 persona { <presetId>: blob }（脚本读，AI 本体不读）。"""
    from nai_terminal import vault
    if vault.vault_exists(PROJECT_ROOT):
        if AUGMENT_PRIVATE_PATH.exists():
            raise NaiConfigError("vault 与明文私有配置同时存在：必须先完成迁移收尾")
        dek = getattr(vault, "_process_dek", None)
        if dek is None:
            dek = vault.load_dek_from_dpapi()
            if dek is None:
                raise NaiConfigError("vault 已启用但 DEK 未解锁：先跑 python3 tools/vault_migrate.py --unlock 输密码")
            vault._process_dek = dek
        return vault.read_payload_cached("aug_private", dek, PROJECT_ROOT)
    if AUGMENT_PRIVATE_PATH.exists():
        try:
            return json.loads(AUGMENT_PRIVATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


# 角色加装层 persona 独立隐私文件（与 nai_augment_private 物理隔离·脚本读、AI 本体不读）
CHAR_LAYERS_PRIVATE_PATH = PROJECT_ROOT / "data" / "nai_character_layers_private.json"


def _read_character_layers_private() -> dict:
    """读取角色加装层 persona { <layerId>: blob }（脚本读，AI 本体不读）。"""
    from nai_terminal import vault
    if vault.vault_exists(PROJECT_ROOT):
        if CHAR_LAYERS_PRIVATE_PATH.exists():
            raise NaiConfigError("vault 与明文私有配置同时存在：必须先完成迁移收尾")
        dek = getattr(vault, "_process_dek", None)
        if dek is None:
            dek = vault.load_dek_from_dpapi()
            if dek is None:
                raise NaiConfigError("vault 已启用但 DEK 未解锁：先跑 python3 tools/vault_migrate.py --unlock 输密码")
            vault._process_dek = dek
        return vault.read_payload_cached("char_layers_private", dek, PROJECT_ROOT)
    if CHAR_LAYERS_PRIVATE_PATH.exists():
        try:
            return json.loads(CHAR_LAYERS_PRIVATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


# 全局加装层正文独立隐私文件（公开壳只保留 id/kind/scope/enabled）
GLOBAL_LAYER_PRIVATE_PATH = PROJECT_ROOT / "data" / "nai_global_layer_private.json"


def _read_global_layer_private() -> dict:
    """读取全局层正文；vault/明文双轨及互斥规则与两套既有私库一致。"""
    from nai_terminal import vault
    if vault.vault_exists(PROJECT_ROOT):
        if GLOBAL_LAYER_PRIVATE_PATH.exists():
            raise NaiConfigError("vault 与明文私有配置同时存在：必须先完成迁移收尾")
        dek = getattr(vault, "_process_dek", None)
        if dek is None:
            dek = vault.load_dek_from_dpapi()
            if dek is None:
                raise NaiConfigError("vault 已启用但 DEK 未解锁：先跑 python3 tools/vault_migrate.py --unlock 输密码")
            vault._process_dek = dek
        return vault.read_payload_cached("global_layer", dek, PROJECT_ROOT)
    if GLOBAL_LAYER_PRIVATE_PATH.exists():
        try:
            value = json.loads(GLOBAL_LAYER_PRIVATE_PATH.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except Exception:
            return {}
    return {}


def _active_preset(cfg: dict, override_id: str | None = None) -> dict | None:
    """取「加装预设」里当前激活的那一套，并把隐私内容（明文/图）从 private_blocks 合并回来。

    private 命名空间：每套预设一个 blob `nai_augpreset:<presetId>`，内含
      {base_positive, base_negative, chars:{<charId>:{text,negative}}, char_extras:{<extraId>:text},
       extra:{<id>:text}, charref_images:{<refId>:b64}(多参考·新), charref_image(旧单键·读兼容), repl:{<ruleId>:{from,to}}}
    无预设结构时返回 None（旧 augmentation/replacements 字段已不再使用，用户已清空重来）。
    """
    store = cfg.get("augmentation_presets")
    if not isinstance(store, dict):
        return None
    presets = store.get("presets")
    if not isinstance(presets, list) or not presets:
        return None
    active_id = override_id or store.get("activeId")   # --aug-preset 覆盖,不改全局 activeId(并行安全)
    preset = next((p for p in presets if isinstance(p, dict) and p.get("id") == active_id), None)
    if preset is None:
        preset = presets[0]
    if not isinstance(preset, dict):
        return None

    augp = _read_augment_private()
    blob = augp.get(str(preset.get("id")), {})
    if not isinstance(blob, dict):
        blob = {}

    out = dict(preset)
    # base 正/负：隐私则用 blob 里的明文
    for bk in ("base_positive", "base_negative"):
        b = preset.get(bk)
        if isinstance(b, dict):
            text = b.get("text") or ""
            if b.get("isPrivate"):
                text = blob.get(bk, "") or ""
            out[bk] = {**b, "text": text}
    # 多角色：隐私角色的 text/negative/front_text 从 blob.chars[<id>] 取回。
    # front_text 永远是隐私正文，即使父角色本身公开也只从 blob 回填。
    blob_chars = blob.get("chars", {}) if isinstance(blob.get("chars"), dict) else {}
    # 角色额外框 extras：隐私块 text 从 blob.char_extras[<extraId>] 取回（镜像 nai.ts·扁平按 extraId·各框按自身 isPrivate）
    blob_char_extras = blob.get("char_extras", {}) if isinstance(blob.get("char_extras"), dict) else {}
    chars_out = []
    for c in (preset.get("chars") or []):
        if not isinstance(c, dict):
            continue
        cc = dict(c)
        pv = blob_chars.get(c.get("id"), {})
        if not isinstance(pv, dict):
            pv = {}
        if c.get("isPrivate"):
            cc["text"] = pv.get("text", "") or ""
            cc["negative"] = pv.get("negative", "") or ""
        if "front_text" in c or "front_text" in pv:
            cc["front_text"] = pv.get("front_text", "") or ""
        if isinstance(c.get("extras"), list):
            cc["extras"] = [
                ({**e, "text": blob_char_extras.get(e.get("id"), "") or ""}
                 if isinstance(e, dict) and e.get("isPrivate") else e)
                for e in c["extras"]
            ]
        chars_out.append(cc)
    out["chars"] = chars_out
    # 提示词加装·额外框：隐私块 text 从 blob.extra[<id>] 取回（镜像 chars）
    blob_extra = blob.get("extra", {}) if isinstance(blob.get("extra"), dict) else {}
    extra_out = []
    for b in (preset.get("extra_blocks") or []):
        if not isinstance(b, dict):
            continue
        bb = dict(b)
        if b.get("isPrivate"):
            bb["text"] = blob_extra.get(b.get("id"), "") or ""
        extra_out.append(bb)
    out["extra_blocks"] = extra_out
    # 角色参考（多张·2026-07-12 多参考化）：隐私图从 blob.charref_images[<refId>] 取回（镜像 char_extras 多键模式）。
    # 旧单键兼容（读旧写新）：无 char_references 列表时回落旧 char_reference + blob.charref_image。
    blob_crs = blob.get("charref_images", {}) if isinstance(blob.get("charref_images"), dict) else {}
    refs = preset.get("char_references")
    legacy_cr = not isinstance(refs, list)
    if legacy_cr:
        old_cr = preset.get("char_reference")
        refs = [old_cr] if isinstance(old_cr, dict) else []
    refs_out = []
    for cr in refs:
        if not isinstance(cr, dict):
            continue
        img = cr.get("image_b64") or ""
        if cr.get("isPrivate"):
            # 旧单键条目只认旧 blob.charref_image；新条目只认多键（防止旧单图误配给新参考）
            img = ((blob.get("charref_image", "") or "") if legacy_cr
                   else (blob_crs.get(str(cr.get("id") or ""), "") or ""))
        refs_out.append({**cr, "image_b64": img})
    out["char_references"] = refs_out
    # 替换规则：隐私规则的 from/to 从 blob.repl[<id>] 取回
    rep = preset.get("replacements")
    if isinstance(rep, dict):
        blob_repl = blob.get("repl", {}) if isinstance(blob.get("repl"), dict) else {}
        rules_out = []
        for r in (rep.get("rules") or []):
            if not isinstance(r, dict):
                continue
            rr = dict(r)
            if r.get("isPrivate"):
                pv = blob_repl.get(r.get("id"), {})
                if isinstance(pv, dict):
                    rr["from"] = pv.get("from", "") or ""
                    rr["to"] = pv.get("to", "") or ""
                    if r.get("kind") == "delete":
                        rr["word"] = pv.get("word", pv.get("from", "")) or ""
            rules_out.append(rr)
        out["replacements"] = {**rep, "rules": rules_out}
    return out


def load_augmentation(cfg: dict, override_id: str | None = None,
                      enable_extra: list[str] | None = None) -> dict | None:
    """取当前激活预设的固定加装层（含多角色 + 角色参考），隐私内容已合并。

    返回 {base_positive, base_negative, chars:[...], char_references:[...]}；预设未启用 / 无预设时 None。
    注意：本函数经 _active_preset 由脚本读取 private_blocks.json，AI（Claude）本体不读该文件。
    """
    preset = _active_preset(cfg, override_id)
    if not preset or not preset.get("enabled"):
        return None
    aug = {
        "base_positive": preset.get("base_positive"),
        "base_negative": preset.get("base_negative"),
        "extra_blocks": preset.get("extra_blocks") or [],
        "chars": preset.get("chars") or [],
        "char_references": preset.get("char_references") or [],
    }
    # --enable-extra <id或roleLabel子串>：点名放行 role=other 的指定单元（改 role→main 过门控；
    # 只影响本次进程内副本，不写回配置）。多值逗号分隔。
    # enable_extra=None → 沿用 argv 嗅探（CLI 兼容）；显式传入 list → 以参数为准（worker 调用面）。
    if enable_extra is None:
        matches = [m.strip() for m in
                   (sys.argv[sys.argv.index("--enable-extra") + 1] if "--enable-extra" in sys.argv else "").split(",")
                   if m.strip()]
    else:
        matches = [m.strip() for m in enable_extra if m and m.strip()]
    if matches:
        def _hit(u):
            return isinstance(u, dict) and any(
                m == u.get("id") or m in (u.get("roleLabel") or "") or m in (u.get("name") or "")
                for m in matches)
        hits = []
        def _promote(units):
            out = []
            for u in units:
                if _hit(u):
                    hits.append(u.get("roleLabel") or u.get("id"))
                    u = {**u, "role": "main"}
                out.append(u)
            return out
        aug["extra_blocks"] = _promote(aug["extra_blocks"])
        aug["chars"] = [{**c, "extras": _promote(c.get("extras") or [])} if isinstance(c, dict) else c
                        for c in aug["chars"]]
        print(f"  --enable-extra 点名放行: {hits or '（无匹配!检查名称/id）'}")
    return aug


def augmentation_char_reference(aug: dict | None, cast: list | None = None,
                                cfg: dict | None = None,
                                view: str = "front_full") -> dict | None:
    """收集加装层里全部过 role/cast 门控的角色参考，合并成 director_reference_* 多元素字段（无则 None）。

    NAI 官方语义（docs.novelai.net precisereference）：多张 character reference =【整图级 blend】、
    非逐槽绑定——role 门控只决定「该帧附哪几张」，附上的多张一律整图混合（双女同框帧可能互相污染）。
    门控与 apply_augmentation 同源（_unit_on）：main=无 cast 全量/有 cast 无条件；f1/f2=cast 含该编号才附；
    other=默认关、cast 显式点名女3+ 才附。每张参考 ~5 Anlas、成本按张数叠加。
    旧单键兼容（读旧写新）：无 char_references 时回落旧 char_reference 单字段。
    """
    if not aug:
        return None
    refs = aug.get("char_references")
    if not isinstance(refs, list):          # 旧单键兜底（迁移期）
        old = aug.get("char_reference")
        refs = [old] if isinstance(old, dict) else []
    eligible = [r for r in refs
                if isinstance(r, dict) and r.get("enabled") and r.get("image_b64")
                and _unit_on(r.get("role"), cast)]
    wanted = "back" if str(view or "front_full").startswith("back_") else "front"
    picked = [r for r in eligible if (r.get("side") or "front") == wanted]
    if wanted == "back" and not picked:
        picked = [r for r in eligible if (r.get("side") or "front") == "front"]
    return char_reference_fields_from_multi(picked, cfg)


def _role_active(role, cast) -> bool:
    """按 role 判内容单元是否激活：main/空=无条件；f1/f2/fN=在 cast 里才装；other=cast 含女3+编号才装。
    other 分支两路径都会被 _unit_on 调用（特殊默认关，cast=None→[]→False）；main/f1/f2 的旧路径全量由 _unit_on 处理。"""
    r = str(role or "main")
    if r == "main":
        return True
    if r == "other":
        return any(str(x) not in ("f1", "f2") for x in (cast or []))
    return r in (cast or [])


def _unit_on(role, cast) -> bool:
    """内容单元（base 正/负、extra_blocks、char.extras、角色参考）的统一 role 门控（模块级共享·勿再各处内联）。

    ★特殊/other 一律默认关（两条路径都关·2026-07-12 实跑反馈：normal 预设女1挂的 role=other「特殊效果」
      在没标 cast 的旧路径也漏装）。仅 cast 显式点名女3+（cast 含非 f1/f2 编号）才装。
      main/f1/f2：旧路径（cast=None）全量套=向后兼容、cast 模式按编号门控。"""
    if str(role or "main") == "other":
        return _role_active("other", cast)   # cast=None→[]→False=特殊关
    return cast is None or _role_active(role, cast)


def apply_augmentation(
    positive: str,
    negative: str,
    characters: list[dict] | None,
    aug: dict | None,
    cast: list | None = None,
    views: dict | None = None,
    global_rules: list[dict] | None = None,
) -> tuple[str, str, list[dict]]:
    """把固定加装层套到 (positive, negative, characters) 上。

    - base_positive / base_negative：按 position（prefix/suffix）拼接（逗号分隔，不用 BREAK）
    - chars（双路径 gate·详见 internal-docs §2.4）：
      · cast=None（旧路径/bare CLI）→ 逐个启用角色按各自 char_index（1-based）插入（向后兼容零改）。
      · cast=list（新路径，该帧出场女角编号如 ['f1','f2']；[]=无女角）→ 忽略 char_index，
        按 role 门控紧凑落槽：chars 前 len(cast) 个=出场女角(females-first)，cast[k]=第k个女角编号；
        role=f1/f2/other 按编号命中才装、role=main 无条件装首个出场女角(slot0)；非首槽女角无 persona→orange 兜底。
    """
    chars = list(characters or [])
    # 2b 固定执行序：全局 delete→replace（load_global_layer 已稳定排序）→预设加装。
    positive, negative, chars = apply_replacements(
        positive, negative, chars, global_rules)
    if not aug:
        return positive, negative, chars

    # base/extra 的 role 门控：cast 模式按 role 过滤(f2 内容仅 f2 出场才装)；无 cast=全量套(旧行为·向后兼容)
    # 门控实现=模块级 _unit_on（与 augmentation_char_reference 共用一份，防两处漂移）

    bp = aug.get("base_positive")
    if bp and bp.get("enabled") and (bp.get("text") or "").strip() and _unit_on(bp.get("role"), cast):
        t = bp["text"].strip()
        if bp.get("position") == "suffix":
            positive = _comma_join(positive, t)
        else:
            positive = _comma_join(t, positive)

    bn = aug.get("base_negative")
    if bn and bn.get("enabled") and (bn.get("text") or "").strip() and _unit_on(bn.get("role"), cast):
        t = bn["text"].strip()
        if bn.get("position") == "suffix":
            negative = _comma_join(negative, t)
        else:
            negative = _comma_join(t, negative)

    # 提示词加装·额外框（extra_blocks）：按 kind 拼到正/负、按 position 前后缀。cast 模式按 role 门控(采纳 UI 线 2026-07-12 建议)。
    for b in (aug.get("extra_blocks") or []):
        if not isinstance(b, dict) or not b.get("enabled") or not _unit_on(b.get("role"), cast):
            continue
        t = (b.get("text") or "").strip()
        if not t:
            continue
        suffix = b.get("position", "suffix") == "suffix"
        if b.get("kind") == "negative":
            negative = _comma_join(negative, t) if suffix else _comma_join(t, negative)
        else:
            positive = _comma_join(positive, t) if suffix else _comma_join(t, positive)

    views = views or {}
    front_views = {"front_full", "front_cowboy", "front_upper", "front_mid"}

    def _slot_view(slot: int) -> str:
        return str(views.get(str(slot)) or views.get(slot) or "front_full")

    def _char_positive(c: dict, slot: int) -> str:
        text = (c.get("text") or "").strip()
        front = (c.get("front_text") or "").strip()
        if front and _slot_view(slot) in front_views:
            text = _comma_join(text, front)
        return text

    FILLER_ANCHORS = {"orange hair", "orange girl"}   # 女2 充数锚（无 persona 时的区分占位）

    def _strip_filler(text: str) -> str:
        """persona 进场=该槽身份被正式接管 → 先剥充数锚再注（2026-07-14 拍板：「换 adult woman」
        语义下充数词也该被换掉；追加式注入曾致舞萌女2 persona+橙发同槽互搏）。
        只对 AW 占位形态的槽剥（含 adult woman 段、或首段即充数锚），真·橙发原角色（保留原角色+加装流程）不误伤。"""
        segs = [s.strip() for s in text.split(",") if s.strip()]
        norm = [s.lower().replace("_", " ") for s in segs]
        if not ("adult woman" in norm or (norm and norm[0] in FILLER_ANCHORS)):
            return text
        return ", ".join(s for s, t in zip(segs, norm) if t not in FILLER_ANCHORS)

    def _inject(tgt: dict, cp_text: str, cn_text: str, cp_pos: str) -> None:
        """把 persona 文本拼进目标角色槽（正向按 prefix/suffix、先剥充数锚，负向去重追加）。"""
        base_text = _strip_filler((tgt.get("text") or "").strip())
        tgt["text"] = (_comma_join(cp_text, base_text) if cp_pos == "prefix"
                       else _comma_join(base_text, cp_text))
        if cn_text:
            base_neg = (tgt.get("negative") or "").strip()
            tgt["negative"] = _comma_join(base_neg, cn_text) if base_neg else cn_text

    def _apply_char_extras(tgt: dict, c: dict) -> None:
        """把角色额外框 extras 拼进【同一角色槽】（加装层线 char.extras·2026-07-12 整合）：
        正向 extra 按 position 拼 text、负向 extra(kind=negative) 拼 negative；随父角色一起注入(父角色已过 role/cast 门控)。
        ★extra 自身 role 须再过一次门控（2026-07-12 修·同 extra_blocks 的 _unit_on 惯例）：
        否则 f1 persona 挂的 role=other「特殊效果」extra 在 cast=['f1'] 时也糊进 slot0；无 cast 保持旧行为全量套。"""
        for e in (c.get("extras") or []):
            if not isinstance(e, dict) or not e.get("enabled") or not _unit_on(e.get("role"), cast):
                continue
            et = (e.get("text") or "").strip()
            if not et:
                continue
            if e.get("kind") == "negative":
                base_neg = (tgt.get("negative") or "").strip()
                tgt["negative"] = _comma_join(base_neg, et) if base_neg else et
            else:
                base_text = (tgt.get("text") or "").strip()
                tgt["text"] = (_comma_join(et, base_text) if e.get("position") == "prefix"
                               else _comma_join(base_text, et))

    def _has_char_content(c: dict, slot: int) -> bool:
        if _char_positive(c, slot) or (c.get("negative") or "").strip():
            return True
        return any(isinstance(e, dict) and e.get("enabled") and (e.get("text") or "").strip()
                   and _unit_on(e.get("role"), cast) for e in (c.get("extras") or []))

    aug_chars = [c for c in (aug.get("chars") or [])
                 if isinstance(c, dict) and c.get("enabled")
                 and ((c.get("text") or "").strip() or (c.get("front_text") or "").strip())]

    if cast is not None:
        # ── 新路径：按 cast 门控 role + 紧凑落槽 ──（无 persona 也不新增女角槽；无女角=不注）
        by_role: dict[str, dict] = {}
        for c in aug_chars:
            by_role.setdefault(str(c.get("role") or "main"), c)   # 每 role 取首个启用者
        main_c = by_role.get("main")
        n = min(len(cast), len(chars))
        for k in range(n):
            ident = str(cast[k] or "")
            # f1/f2 直接按编号匹配 role；女3+（非 f1/f2）落 role=other（首个）
            c = by_role.get(ident)
            if c is None and ident not in ("f1", "f2"):
                c = by_role.get("other")
            got = False
            if c is not None and _has_char_content(c, k):
                _inject(chars[k], _char_positive(c, k), (c.get("negative") or "").strip(),
                        c.get("position", "suffix"))
                _apply_char_extras(chars[k], c)      # 该角色额外框随其一起注入
                got = True
            if (k == 0 and main_c is not None and main_c is not c
                    and _has_char_content(main_c, 0)):   # main 无条件装 slot0
                _inject(chars[0], _char_positive(main_c, 0), (main_c.get("negative") or "").strip(),
                        main_c.get("position", "suffix"))
                _apply_char_extras(chars[0], main_c)
                got = True
            if k > 0 and not got:   # orange 兜底（Owner 隐患4：女2+ 无 persona → 橙发充数区分）
                base_text = (chars[k].get("text") or "").strip()
                chars[k]["text"] = _comma_join(base_text, "orange hair")
        return positive, negative, chars

    # ── 旧路径：按 char_index（1-based）插入，越界新建 ──（bare CLI / 无 cast 帧·零改）
    for c in aug_chars:
        cn_text = (c.get("negative") or "").strip()
        try:
            idx = int(c.get("char_index", 1))
        except (TypeError, ValueError):
            idx = 1
        pos = max(0, idx - 1)
        cp_text = _char_positive(c, pos)
        if not _has_char_content(c, pos):
            continue
        cp_pos = c.get("position", "suffix")
        # 目标槽已有角色 → 拼进其 prompt（不新增，避免双角色）；无现成角色 → 按 x/y 新建
        if pos < len(chars):
            _inject(chars[pos], cp_text, cn_text, cp_pos)
            _apply_char_extras(chars[pos], c)
        else:
            chars.append({
                "text": cp_text,
                "negative": cn_text,
                "x": float(c.get("x", 0.5)),
                "y": float(c.get("y", 0.5)),
            })
            _apply_char_extras(chars[-1], c)

    return positive, negative, chars


def load_replacements(cfg: dict, override_id: str | None = None) -> list[dict] | None:
    """读取当前激活预设的替换规则（隐私规则的 from/to 已由 _active_preset 合并）。

    每条规则 {id, from(每行一个源词), to, enabled, wholeWord, isPrivate}。
    返回已启用且解析后的规则列表，无有效规则时返回 None。
    """
    preset = _active_preset(cfg, override_id)
    if not preset:
        return None
    rep = preset.get("replacements")
    if not isinstance(rep, dict) or not rep.get("enabled"):
        return None
    rules = rep.get("rules")
    if not isinstance(rules, list):
        return None

    resolved: list[dict] = []
    for r in rules:
        if not isinstance(r, dict) or not r.get("enabled"):
            continue
        frm = r.get("word") or r.get("from") or ""
        to = r.get("to") or ""
        if not frm.strip():
            continue
        resolved.append({"from": frm, "to": to,
                         "wholeWord": bool(r.get("wholeWord", True)),
                         "kind": r.get("kind") or "replace",
                         "scope": r.get("scope") or "all",
                         "asciiBoundary": (r.get("kind") == "delete")})
    return resolved or None


def _apply_one_replace(text: str, sources: list[str], to: str, whole: bool,
                       ascii_boundary: bool = False) -> str:
    """把 text 中所有 sources（每个独立源词）替换为 to。whole=整词（词边界），否则子串。"""
    if not text:
        return text
    for s in sources:
        s = s.strip()
        if not s:
            continue
        if whole:
            try:
                boundary = r"[a-z0-9]" if ascii_boundary else r"\w"
                text = re.sub(r"(?<!" + boundary + r")" + re.escape(s) +
                              r"(?!" + boundary + r")", to, text)
            except re.error:
                text = text.replace(s, to)
        else:
            text = text.replace(s, to)
    return text


def _normalize_deleted_prompt(text: str) -> str:
    """删除后按逗号分段剔空并清理段首尾；非删除路径不调用以保持旧输出。"""
    return ", ".join(part.strip() for part in (text or "").split(",") if part.strip())


def _scope_targets(scope: str) -> tuple[bool, bool]:
    return scope in ("all", "positive"), scope in ("all", "negative")


def apply_replacements(
    positive: str,
    negative: str,
    characters: list[dict] | None,
    rules: list[dict] | None,
) -> tuple[str, str, list[dict]]:
    """对最终送 NAI 的 positive/negative/角色文本做替换（注入加装层之后的最后一道）。"""
    chars = list(characters or [])
    if not rules:
        return positive, negative, chars
    for r in rules:
        sources = [ln for ln in r["from"].split("\n") if ln.strip()]
        if not sources:
            continue
        deleting = r.get("kind", "replace") == "delete"
        ascii_boundary = bool(r.get("asciiBoundary"))
        to, whole = ("" if deleting else r["to"]), r["wholeWord"]
        do_pos, do_neg = _scope_targets(r.get("scope", "all"))
        if do_pos:
            positive = _apply_one_replace(positive, sources, to, whole, ascii_boundary)
            if deleting:
                positive = _normalize_deleted_prompt(positive)
        if do_neg:
            negative = _apply_one_replace(negative, sources, to, whole, ascii_boundary)
            if deleting:
                negative = _normalize_deleted_prompt(negative)
        for c in chars:
            if do_pos and c.get("text"):
                c["text"] = _apply_one_replace(c["text"], sources, to, whole, ascii_boundary)
                if deleting:
                    c["text"] = _normalize_deleted_prompt(c["text"])
            if do_neg and c.get("negative"):
                c["negative"] = _apply_one_replace(c["negative"], sources, to, whole, ascii_boundary)
                if deleting:
                    c["negative"] = _normalize_deleted_prompt(c["negative"])
    return positive, negative, chars


def load_global_layer(cfg: dict) -> list[dict] | None:
    """合并全局层公开壳与私有正文，返回按 delete→replace 排序的规则。"""
    shell = cfg.get("global_layer")
    if not isinstance(shell, dict) or not shell.get("enabled"):
        return None
    private = _read_global_layer_private()
    bodies = private.get("rules") if isinstance(private.get("rules"), dict) else private
    if not isinstance(bodies, dict):
        bodies = {}
    rules = []
    for rule in shell.get("rules") or []:
        if not isinstance(rule, dict) or not rule.get("enabled") or not rule.get("id"):
            continue
        body = bodies.get(str(rule["id"]), {})
        if not isinstance(body, dict):
            body = {}
        kind = rule.get("kind") or "replace"
        source = body.get("word") if kind == "delete" else body.get("from")
        if not isinstance(source, str) or not source.strip():
            continue
        rules.append({"from": source, "to": body.get("to") or "", "wholeWord": True,
                      "kind": kind, "scope": rule.get("scope") or "all",
                      "asciiBoundary": True})
    return sorted(rules, key=lambda r: 0 if r["kind"] == "delete" else 1) or None


# ── 角色加装层（character_layers）：可复用单角色私设，按槽指派 ──
# 与 augmentation_presets 独立并存；隐私 persona 在 CHAR_LAYERS_PRIVATE_PATH，脚本内合并、AI 本体不读。

def load_character_layers(cfg: dict) -> dict:
    """读 character_layers 并把隐私（persona/参考图/替换）从独立文件合并回来，返回 {layerId: layer}。"""
    store = cfg.get("character_layers")
    if not isinstance(store, dict):
        return {}
    layers = store.get("layers")
    if not isinstance(layers, list):
        return {}
    priv = _read_character_layers_private()
    out: dict = {}
    for l in layers:
        if not isinstance(l, dict) or not l.get("id"):
            continue
        blob = priv.get(str(l.get("id")), {})
        if not isinstance(blob, dict):
            blob = {}
        resolved = dict(l)
        # persona：隐私则取明文
        p = l.get("persona")
        if isinstance(p, dict):
            pp = dict(p)
            if p.get("isPrivate"):
                bp = blob.get("persona", {}) if isinstance(blob.get("persona"), dict) else {}
                pp["text"] = bp.get("text") or {}        # text=ViewVariantTexts dict（10 视角变体）
                pp["negative"] = bp.get("negative", "") or ""
            resolved["persona"] = pp
        # 角色参考：隐私图取回
        cr = l.get("char_reference")
        if isinstance(cr, dict):
            img = cr.get("image_b64") or ""
            if cr.get("isPrivate"):
                img = blob.get("charref_image", "") or ""
            resolved["char_reference"] = {**cr, "image_b64": img}
        # 替换：隐私规则 from/to 取回
        rep = l.get("replacements")
        if isinstance(rep, dict):
            blob_repl = blob.get("repl", {}) if isinstance(blob.get("repl"), dict) else {}
            rules_out = []
            for r in (rep.get("rules") or []):
                if not isinstance(r, dict):
                    continue
                rr = dict(r)
                if r.get("isPrivate"):
                    pv = blob_repl.get(r.get("id"), {})
                    if isinstance(pv, dict):
                        rr["from"] = pv.get("from", "") or ""
                        rr["to"] = pv.get("to", "") or ""
                rules_out.append(rr)
            resolved["replacements"] = {**rep, "rules": rules_out}
        out[str(l.get("id"))] = resolved
    return out


def apply_character_layers(
    positive: str,
    negative: str,
    characters: list[dict] | None,
    assign: dict | None,
    layers_by_id: dict,
    views: dict | None = None,
) -> tuple[str, str, list[dict]]:
    """把角色加装层按指派（{slotIndex(0-based): layerId}）套到对应角色槽。

    - persona.text=ViewVariantTexts，按该槽 view（views[slot]，缺=front_full）选变体注入（blue eyes 只进 front 帧）。
    - persona：按 position（prefix/suffix）拼进 characters[slotIndex]（已有角色拼接、无则按坐标新建）。
    - 替换：汇总所有被指派层的启用规则，跑最后一道全文替换（复用 apply_replacements）。
    - 参考图：见 character_layers_char_reference（整图级·NAI 多图为整图 blend·非逐槽绑定；本层现只取第一张 enabled，多张聚合=可选未来项）。
    """
    import clothing_variant as CV  # 同 tools/ 目录·按 view 选 persona 变体的权威回落
    chars = list(characters or [])
    if not assign or not layers_by_id:
        return positive, negative, chars
    views = views or {}

    # 槽序稳定：按 slotIndex 升序应用
    try:
        items = sorted(assign.items(), key=lambda kv: int(kv[0]))
    except (TypeError, ValueError):
        items = list(assign.items())

    repl_rules: list[dict] = []
    for slot_str, layer_id in items:
        layer = layers_by_id.get(layer_id)
        if not isinstance(layer, dict) or not layer.get("enabled"):
            continue
        try:
            slot = int(slot_str)
        except (TypeError, ValueError):
            continue
        if slot < 0:
            continue
        persona = layer.get("persona") or {}
        view = views.get(slot_str) or views.get(str(slot)) or "front_full"
        text_field = persona.get("text")
        if isinstance(text_field, str):          # 迁移容错：旧扁平 persona.text=字符串
            cp_text = text_field.strip()
        else:
            cp_text = (CV.pick_view_variant(text_field, view) or "").strip()
        cn_text = (persona.get("negative") or "").strip()
        cp_pos = persona.get("position", "suffix")
        if cp_text or cn_text:
            if slot < len(chars):
                existing = chars[slot]
                if cp_text:
                    base_text = (existing.get("text") or "").strip()
                    existing["text"] = (
                        _comma_join(cp_text, base_text) if cp_pos == "prefix"
                        else _comma_join(base_text, cp_text)
                    )
                if cn_text:
                    base_neg = (existing.get("negative") or "").strip()
                    existing["negative"] = _comma_join(base_neg, cn_text) if base_neg else cn_text
            elif cp_text:
                chars.append({"text": cp_text, "negative": cn_text, "x": 0.5, "y": 0.5})
        # 汇总该层启用替换规则
        rep = layer.get("replacements")
        if isinstance(rep, dict) and rep.get("enabled"):
            for r in (rep.get("rules") or []):
                if not isinstance(r, dict) or not r.get("enabled"):
                    continue
                frm = r.get("from") or ""
                if not frm.strip():
                    continue
                repl_rules.append({"from": frm, "to": r.get("to") or "", "wholeWord": bool(r.get("wholeWord", True))})

    if repl_rules:
        positive, negative, chars = apply_replacements(positive, negative, chars, repl_rules)
    return positive, negative, chars


def character_layers_char_reference(assign: dict | None, layers_by_id: dict,
                                    cfg: dict | None = None) -> dict | None:
    """取第一张 enabled 且有图的角色加装层参考图作【整图级】director_reference_*。
    NAI 多图合法但为整图 blend·非逐槽绑定（docs precisereference）；本层多张聚合=可选未来项，现仍只取第一张。"""
    if not assign or not layers_by_id:
        return None
    try:
        items = sorted(assign.items(), key=lambda kv: int(kv[0]))
    except (TypeError, ValueError):
        items = list(assign.items())
    for _slot, layer_id in items:
        layer = layers_by_id.get(layer_id)
        if not isinstance(layer, dict) or not layer.get("enabled"):
            continue
        cr = layer.get("char_reference")
        if isinstance(cr, dict) and cr.get("enabled") and cr.get("image_b64"):
            return char_reference_fields_from_b64(
                cr["image_b64"],
                strength=float(cr.get("strength", 1.0)),
                fidelity=float(cr.get("fidelity", 1.0)),
                base_caption=cr.get("base_caption", "character"),
                cfg=cfg,
            )
    return None


def is_v4_model(model: str) -> bool:
    """严格 V4 系列（nai-diffusion-4*）。语义保持不变，勿扩到 V5。"""
    return any(model.startswith(p) for p in V4_MODEL_PREFIXES)


def is_v45_model(model: str) -> bool:
    """Precise Reference 仅 V4.5 支持（V5 尚未上线该功能，故此处不含 V5）。"""
    return model.startswith("nai-diffusion-4-5")


def is_v5_model(model: str) -> bool:
    """V5 系列（nai-diffusion-5*）。"""
    return any(model.startswith(p) for p in V5_MODEL_PREFIXES)


def is_v4plus_model(model: str) -> bool:
    """V4 及以上：使用 v4_prompt/v4_negative_prompt 结构 + 强制 karras + 不发 sm/sm_dyn。

    这是 build_parameters 的分支判据（V5 沿用 V4 的 prompt 结构）；
    「是不是 V4 系」「支不支持 char-ref」另有 is_v4_model / is_v45_model，勿混用。
    """
    return is_v4_model(model) or is_v5_model(model)


def params_version_for(model: str) -> int:
    """按模型返回 params_version（V5=4，其余=3）。"""
    return PARAMS_VERSION_V5 if is_v5_model(model) else PARAMS_VERSION_DEFAULT


# Precise Reference（角色参考）允许的画布尺寸 —— **NAI 官方硬规格，不是我方约定**：
# docs.novelai.net/en/image/precisereference 原文「prepare a reference image in one of our three
# large resolutions (1024x1536, 1472x1472, or 1536x1024)…smaller image will be upscaled and padded
# …bigger image downscaled and padded」。**官网 UI 替用户做这步、API 直调不做** ⇒ 我方必须自己 pad
# （=_ensure_cr_canvas_b64）；非法画布直送 NAI = 每张 HTTP 400（2026-08-29 实测 832×1216 全灭）。
# 参考图按长宽比就近选一个 + 黑边 letterbox（不裁剪、画面不丢；官方 padding 填充色未公开）
ACCEPTED_CR_SIZES = [(1024, 1536), (1536, 1024), (1472, 1472)]


def _letterbox_to_canvas(img, target_w: int, target_h: int):
    """保持长宽比缩放后黑边填充到 (target_w, target_h)。"""
    from PIL import Image
    src_w, src_h = img.size
    scale = min(target_w / src_w, target_h / src_h)
    new_w, new_h = max(1, round(src_w * scale)), max(1, round(src_h * scale))
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGB", (target_w, target_h), (0, 0, 0))
    canvas.paste(resized, ((target_w - new_w) // 2, (target_h - new_h) // 2))
    return canvas


# Director Reference 三种参考模式（官网 Reference Type）；直接是 NAI base_caption 值。
CHAR_REF_MODES = ("character&style", "character", "style")


def _ensure_cr_canvas_b64(b64: str) -> str:
    """参考图画布归一（幂等）：转 RGB 去 alpha + letterbox 到 ACCEPTED_CR_SIZES。

    ★2026-08-29 收口到 char_reference_fields_from_b64（别再各路径各写一份）：
    加装预设的参考图是 GUI 存的【源文件原始字节】——`nai_terminal/gui/preset_page.py
    import_reference` 只 base64 原文件，不做尺寸/通道归一——直送 NAI 会 HTTP 400
    `Error encoding v4 director references: non-200 response: 400`（生成不开始、Anlas 不扣）。
    webapp 顶层与 CLI --char-ref 各自 letterbox 过、唯独预设路径没有，故归一做在最内层公共收口点。
    已是合法画布的 RGB 图原样透传（字节不动=幂等，不重编码）。
    """
    import base64
    from PIL import Image
    raw = base64.b64decode(b64)
    img = Image.open(io.BytesIO(raw))
    if img.size in ACCEPTED_CR_SIZES and img.mode == "RGB":
        return b64
    img = img.convert("RGB")
    if img.size not in ACCEPTED_CR_SIZES:
        cw, ch = min(ACCEPTED_CR_SIZES,
                     key=lambda s: abs((s[0] / s[1]) - (img.width / img.height)))
        img = _letterbox_to_canvas(img, cw, ch)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _shrink_ref_b64(b64: str, cfg: dict | None = None) -> str:
    """参考图线上体积护栏（2026-07-12 本机上行降级实锤）。

    blob/webapp 存的是 Canvas letterbox 后重编码的真彩 PNG（~2-3MB），源图缩小也没用；
    慢上行时 body 传不完 → NAI 网关读超时 500。超过 batch.charref_wire_max_kb
    （默认 1024，0=关闭）时降 JPEG q90，仍超再降 q75。

    ★禁用量化 256 色 PNG（2026-08-29 实锤，别改回去）：NAI 的 v4 director reference
    编码端点不接受调色板（P 模式）PNG，一律 HTTP 400
    "Error encoding v4 director references: non-200 response: 400"，生成根本没开始。
    真彩 JPEG 可过（同图关压缩真彩 PNG 也过 → 元凶是量化不是体积）。
    缘起/实证=creation_env.md「char-ref 参考图 400」条。

    cfg 传入则复用（消重复读盘）；cfg=None 才自读 config。
    """
    import base64
    env_kb = os.environ.get("CHARREF_WIRE_MAX_KB")  # 临时开关: 0=本次关压缩; 优先于 nai_config
    if env_kb is not None and env_kb.strip().lstrip("-").isdigit():
        max_kb = int(env_kb)
    elif cfg is not None:
        max_kb = cfg.get("batch", {}).get("charref_wire_max_kb", 1024)
    else:
        try:
            max_kb = load_config().get("batch", {}).get("charref_wire_max_kb", 1024)
        except Exception:
            max_kb = 1024
    if not max_kb:
        return b64
    raw = base64.b64decode(b64)
    if len(raw) <= max_kb * 1024:
        return b64
    from PIL import Image
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    fmt = "JPEG q90"
    if buf.tell() > max_kb * 1024:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75)
        fmt = "JPEG q75"
    print(f"  参考图线上压缩: {len(raw) // 1024}KB → {buf.tell() // 1024}KB ({fmt}; batch.charref_wire_max_kb={max_kb})")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def char_reference_fields_from_b64(b64: str, *, strength: float, fidelity: float,
                                   base_caption: str = "character",
                                   cfg: dict | None = None) -> dict:
    """由已 letterbox 的 PNG base64 直接构造 director_reference_* 字段。

    base_caption: 三选一 'character&style' / 'character' / 'style'（非法值回退 'character'）
    cfg: 透传给 _shrink_ref_b64 消重复读盘（None=自读）。
    """
    if base_caption not in CHAR_REF_MODES:
        base_caption = "character"
    b64 = _ensure_cr_canvas_b64(b64)      # 画布/通道归一（幂等）——预设路径唯一护栏
    b64 = _shrink_ref_b64(b64, cfg)
    return {
        "director_reference_images": [b64],
        "director_reference_descriptions": [{
            "use_coords": False,
            "use_order": False,
            "legacy_uc": False,
            "caption": {"base_caption": base_caption, "char_captions": []},
        }],
        "director_reference_strength_values": [round(float(strength), 4)],
        "director_reference_secondary_strength_values": [round(1.0 - float(fidelity), 4)],
        "director_reference_information_extracted": [1.0],
    }


def char_ref_fields_from_payload(cr: dict, cfg: dict | None = None) -> dict:
    """顶层 payload ``char_reference``（webapp 直投·公开显式参考）→ director_reference_* 字段。

    镜像 nai_terminal.adapter._build_char_ref_fields：
      letterbox（已是 ACCEPTED_CR_SIZES 则跳过=幂等）
      → char_reference_fields_from_b64（自带 _shrink_ref_b64 压缩护栏，webapp 直投从此也吃到该护栏）。
    ``base_caption`` 与 ``mode`` 二名归一到 CHAR_REF_MODES 三值；非法值抛 NaiValidationError。
    """
    import base64
    b64 = cr.get("image_b64") or ""
    if not b64:
        raise NaiValidationError("✗ char_reference 缺少 image_b64")
    mode = cr.get("base_caption")
    if mode is None:
        mode = cr.get("mode")
    if mode is None:
        mode = "character"
    if mode not in CHAR_REF_MODES:
        raise NaiValidationError(
            f"✗ char_reference mode 非法：{mode!r}（须为 {CHAR_REF_MODES} 之一）")
    b64 = _ensure_cr_canvas_b64(b64)      # 幂等归一；收口点会再调一次=空转
    return char_reference_fields_from_b64(
        b64, strength=float(cr.get("strength", 1.0)),
        fidelity=float(cr.get("fidelity", 1.0)),
        base_caption=mode, cfg=cfg)


def char_reference_fields_from_multi(refs: list[dict], cfg: dict | None = None) -> dict | None:
    """把 N 张参考合并为 director_reference_* 平行数组（5 数组锁步 extend·必等长）。空列表→None。

    每张 refs[i] = {image_b64, strength?, fidelity?, base_caption?}。
    ⚠不变式：5 个 director_reference_* 数组必须等长（每张参考在各数组同下标占 1 元素），
    不等长 NAI API 报错——任何改动禁止单独动某一数组。
    多张参考为整图级 blend（NAI 无逐槽绑定），每张 ~5 Anlas 按张数叠加。
    """
    if not refs:
        return None
    out: dict = {
        "director_reference_images": [],
        "director_reference_descriptions": [],
        "director_reference_strength_values": [],
        "director_reference_secondary_strength_values": [],
        "director_reference_information_extracted": [],
    }
    for r in refs:
        one = char_reference_fields_from_b64(
            r["image_b64"],
            strength=float(r.get("strength", 1.0)),
            fidelity=float(r.get("fidelity", 1.0)),
            base_caption=r.get("base_caption", "character"),
            cfg=cfg,
        )
        for k in out:
            out[k].extend(one[k])
    n = len(out["director_reference_images"])
    assert all(len(v) == n for v in out.values()), "director_reference_* 数组不等长"
    return out


def build_char_reference(image_path: str, *, strength: float, fidelity: float,
                         base_caption: str = "character", cfg: dict | None = None) -> dict:
    """构造 Precise Reference（角色参考）的 director_reference_* 字段。

    image_path:  参考图路径（任意尺寸，内部会 letterbox 到允许画布）
    strength:    UI「Strength」滑块（0-1），AI 模仿参考图视觉特征的强度
    fidelity:    UI「Fidelity」滑块（0-1）；注意 API 写入的是 1-fidelity
    base_caption: 三选一 'character&style'（角色+画风）/ 'character'（仅角色）/ 'style'（仅画风）
    """
    import base64
    from PIL import Image

    img = Image.open(image_path).convert("RGB")
    cw, ch = min(ACCEPTED_CR_SIZES, key=lambda s: abs((s[0] / s[1]) - (img.width / img.height)))
    padded = _letterbox_to_canvas(img, cw, ch)

    buf = io.BytesIO()
    padded.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    return char_reference_fields_from_b64(b64, strength=strength, fidelity=fidelity,
                                          base_caption=base_caption, cfg=cfg)


def merge_params(cfg: dict, overrides: dict | None) -> dict:
    """合并默认参数 + 用户覆盖，返回最终生效的参数字典。"""
    defaults = dict(cfg.get("default_params", {}))
    if overrides:
        # 只接受非 None 的覆盖
        for k, v in overrides.items():
            if v is not None:
                defaults[k] = v
    return defaults


def build_parameters(
    cfg: dict,
    *,
    positive: str,
    negative: str,
    seed: int,
    width: int,
    height: int,
    model: str,
    final_params: dict,
    characters: list[dict] | None = None,
) -> dict:
    """构造 NAI API 请求 parameters 字段。

    V4 系列 / V5：内嵌 v4_prompt / v4_negative_prompt 结构，强制 karras，移除 sm。
    V3 及更早：保留 sm/sm_dyn，noise_schedule 用配置中的值。
    params_version：V5=4，其余=3；final_params 显式给 params_version 时以显式值为准。

    characters: 角色 prompt 列表，每项 {text: str, x: float, y: float}
    """
    fp = final_params

    params = {
        "params_version": int(fp.get("params_version") or params_version_for(model)),
        "width": width,
        "height": height,
        "scale": fp.get("scale", 5.0),
        "sampler": fp.get("sampler", "k_euler"),
        "steps": fp.get("steps", 28),
        "seed": seed,
        "n_samples": 1,
        "ucPreset": fp.get("ucPreset", 0),
        "qualityToggle": fp.get("qualityToggle", True),
        "dynamic_thresholding": fp.get("dynamic_thresholding", False),
        "controlnet_strength": fp.get("controlnet_strength", 1.0),
        "legacy": fp.get("legacy", False),
        "add_original_image": fp.get("add_original_image", False),
        "uncond_scale": fp.get("uncond_scale", 1.0),
        "cfg_rescale": fp.get("cfg_rescale", 0.1),
        "noise_schedule": fp.get("noise_schedule", "karras"),
        "negative_prompt": negative,
        "reference_image_multiple": [],
        "reference_information_extracted_multiple": [],
        "reference_strength_multiple": [],
    }

    # 处理角色 prompt
    char_list = characters or []
    char_captions = []
    char_negatives = []  # 每个角色独立 negative，与 char_captions 一一对应
    character_prompts = []
    for c in char_list:
        if not c.get("text", "").strip():
            continue
        text = c["text"]
        x = float(c.get("x", 0.5))
        y = float(c.get("y", 0.5))
        neg = (c.get("negative") or "").strip()
        char_captions.append({
            "char_caption": text,
            "centers": [{"x": x, "y": y}],
        })
        char_negatives.append(neg)
        character_prompts.append({
            "prompt": text,
            "uc": neg,
            "center": {"x": x, "y": y},
        })
    params["characterPrompts"] = character_prompts

    if is_v4plus_model(model):
        params["noise_schedule"] = "karras"
        params["v4_prompt"] = {
            "caption": {
                "base_caption": positive,
                "char_captions": char_captions,
            },
            "use_coords": not fp.get("auto_position", True),
            "use_order": True,
        }
        params["v4_negative_prompt"] = {
            "caption": {
                "base_caption": negative,
                "char_captions": [
                    {"char_caption": char_negatives[i], "centers": cc["centers"]}
                    for i, cc in enumerate(char_captions)
                ],
            },
            "legacy_uc": fp.get("legacy_uc", False),
        }
    else:
        params["sm"] = fp.get("sm", False)
        params["sm_dyn"] = fp.get("sm_dyn", False)

    if fp.get("variety_plus", False):
        # 19.0 是 V4.5 时代标定的经验常数；V5 换了架构与 VAE（16ch→32ch），sigma 尺度未标定，
        # 照搬会以未知方式改画面 → V5 下默认不注入，除非用户在 final_params 显式给值
        # （显式值走下方 ADV_PASSTHROUGH 透传）。
        if is_v5_model(model) and "skip_cfg_above_sigma" not in fp:
            print(f"  ⚠ variety_plus 已开，但 model={model} 为 V5：skip_cfg_above_sigma 的 19.0 "
                  f"常数是 V4.5 经验值、V5 未标定，本次不注入该参数"
                  f"（要强制请在 params 里显式给 skip_cfg_above_sigma）", file=sys.stderr)
        else:
            from math import sqrt
            params["skip_cfg_above_sigma"] = 19.0 * sqrt((width * height) / (832 * 1216))

    # Precise Reference（角色参考）：仅 V4.5；与 Vibe Transfer 互斥
    cr = fp.get("_char_reference")
    if cr:
        if is_v5_model(model):
            raise NaiValidationError(
                f"✗ Precise Reference 在 V5 尚未上线（NAI 官方未提供），当前 model={model}；"
                f"需要角色参考请改用 V4.5 模型")
        if not is_v45_model(model):
            raise NaiValidationError(f"✗ Precise Reference 仅 V4.5 模型支持，当前 model={model}")
        if params.get("reference_image_multiple"):
            raise NaiValidationError("✗ Precise Reference 与 Vibe Transfer 互斥，不能同时使用")
        params.update(cr)

    # 高级采样/CFG flag 透传（仅当 final_params 显式提供时才转发，否则用 NAI 服务端默认）：
    # 忠实复刻原图必须对齐 euler_ancestral 噪声树(prefer_brownian)/CFG 调度等，否则同 seed 也崩构图。
    # webapp/scenario 不设这些键 → 行为零变化。
    ADV_PASSTHROUGH = (
        "prefer_brownian", "deliberate_euler_ancestral_bug", "cfg_sched_eligibility",
        "skip_cfg_above_sigma", "skip_cfg_below_sigma", "legacy_v3_extend",
        "dynamic_thresholding_percentile", "dynamic_thresholding_mimic_scale",
        "explike_fine_detail", "minimize_sigma_inf", "uncond_per_vibe", "wonky_vibe_correlation",
    )
    for k in ADV_PASSTHROUGH:
        if k in fp and fp[k] is not None:
            params[k] = fp[k]

    return params


def build_request(cfg: dict, *, positive: str, negative: str, seed: int, model: str,
                  width: int, height: int, final_params: dict,
                  characters: list[dict] | None = None) -> dict:
    parameters = build_parameters(
        cfg,
        positive=positive,
        negative=negative,
        seed=seed,
        width=width,
        height=height,
        model=model,
        final_params=final_params,
        characters=characters,
    )
    return {
        "input": positive,
        "model": model,
        "action": "generate",
        "parameters": parameters,
    }


def make_opener(proxy: str):
    """构造支持代理的 urllib opener。proxy 格式: 'host:port' 或空字符串。"""
    if proxy:
        proxy_url = f"http://{proxy}"
        handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        return urllib.request.build_opener(handler)
    return urllib.request.build_opener()


def post_nai(opener, api_key: str, payload: dict, timeout: int = 120) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        NAI_API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/x-zip-compressed",
            "User-Agent": "NAI-Client/0.1",
        },
        method="POST",
    )
    with opener.open(req, timeout=timeout) as resp:
        return resp.read()


# ── V5 配额护栏（新的钱红线）─────────────────────────────────────────────
# V4.5 及更早在 Opus 订阅下「通常分辨率批量全免费」，V5 不在其中：V5 走独立的
# 「充电电池」配额池（日恢复约 11%），耗尽后按 Anlas 计费。故仅 V5 模型开批前查一次余量。
# 查询是只读 GET，不花钱、不产图。api_key 只进 Authorization 头，永不打印/落盘。
_USAGE_CACHE: dict = {"ts": 0.0, "percent": None}


def fetch_usage_percent(cfg: dict, *, opener=None, timeout: int = 15) -> float | None:
    """查询 NAI 订阅余量 usage.percent（V5 配额池剩余百分比）。

    返回 float；响应里没有 usage.percent 字段时返回 None。
    网络/HTTP 失败原样抛异常，由调用方决定是否阻断（护栏策略=只警告不阻断）。
    ★绝不打印 api_key、绝不把 key 写进任何文件或日志。
    """
    if opener is None:
        opener = make_opener(cfg.get("proxy", ""))
    req = urllib.request.Request(
        NAI_SUBSCRIPTION_URL,
        headers={
            "Authorization": f"Bearer {cfg.get('api_key', '')}",
            "Accept": "application/json",
            "User-Agent": "NAI-Client/0.1",
        },
        method="GET",
    )
    with opener.open(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return None
    percent = usage.get("percent")
    if isinstance(percent, bool) or not isinstance(percent, (int, float)):
        return None
    return float(percent)


def check_v5_usage_guard(cfg: dict, model: str, *, opener=None, log=print) -> float | None:
    """V5 开批前配额护栏。非 V5 模型直接返回 None（V4.5 行为零变化）。

    · 打印余量；低于 batch.v5_usage_warn_percent（默认 20）打醒目警告。
    · 低于 batch.v5_usage_block_percent（默认 0 = 关闭）抛 NaiError 拒跑。
    · 查询失败只警告不阻断（网络问题不能卡住出图）。
    """
    if not is_v5_model(model):
        return None
    batch_cfg = cfg.get("batch", {}) or {}
    warn_at = float(batch_cfg.get("v5_usage_warn_percent", 20))
    block_at = float(batch_cfg.get("v5_usage_block_percent", 0))
    cache_sec = float(batch_cfg.get("v5_usage_cache_sec", 60))

    now = time.time()
    cached = (_USAGE_CACHE["percent"] is not None
              and cache_sec > 0 and (now - _USAGE_CACHE["ts"]) < cache_sec)
    if cached:
        percent = _USAGE_CACHE["percent"]
    else:
        try:
            percent = fetch_usage_percent(cfg, opener=opener)
        except Exception as e:
            log(f"  ⚠ V5 配额查询失败（不阻断，继续出图）: {type(e).__name__}: {e}", file=sys.stderr)
            return None
        if percent is None:
            log("  ⚠ V5 配额响应无 usage.percent 字段（不阻断，继续出图）", file=sys.stderr)
            return None
        _USAGE_CACHE["percent"] = percent
        _USAGE_CACHE["ts"] = now

    tag = "（缓存）" if cached else ""
    log(f"  V5 配额余量: {percent:.0f}%{tag}")
    if percent < block_at:
        raise NaiError(
            f"✗ V5 配额余量 {percent:.0f}% 低于拒跑阈值 {block_at:.0f}%"
            f"（batch.v5_usage_block_percent），已拒绝开批；等配额恢复或改用 V4.5 模型")
    if percent < warn_at:
        log(f"  ⚠⚠ V5 配额余量仅 {percent:.0f}%（低于告警阈值 {warn_at:.0f}%）——"
            f"耗尽后每张按 Anlas 计费，确认再跑", file=sys.stderr)
    return percent


def save_images_from_zip(zip_bytes: bytes, output_dir: Path, prefix: str, seed: int) -> list[Path]:
    """从 NAI 返回的 ZIP 解出 PNG，保存到 output_dir。返回保存的路径列表。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for idx, name in enumerate(zf.namelist()):
            if not name.lower().endswith(".png"):
                continue
            data = zf.read(name)
            suffix = f"_{idx}" if idx > 0 else ""
            filename = f"{prefix}_{timestamp}_seed{seed}{suffix}.png"
            out_path = output_dir / filename
            out_path.write_bytes(data)
            saved.append(out_path)
    return saved


def submit_one(cfg: dict, opener=None, *, positive: str, negative: str, seed: int, model: str,
               width: int, height: int, output_dir: Path, prefix: str,
               final_params: dict, characters: list[dict] | None = None,
               log=print) -> list[Path]:
    """提交一次请求，处理 429 重试。返回保存的图片路径列表。

    opener=None 则自建（worker 传入复用连接）；log 默认 print（CLI），worker 传入自定义。
    每次实际 POST 前用 fcntl 独占 data/nai_gen.lock（阻塞等待），POST+存图完成后释放；
    重试的 sleep 在锁外（不抱锁睡觉挡别人）——临界区=单次 post_nai+save_images_from_zip。
    """
    if opener is None:
        opener = make_opener(cfg.get("proxy", ""))
    payload = build_request(
        cfg,
        positive=positive,
        negative=negative,
        seed=seed,
        model=model,
        width=width,
        height=height,
        final_params=final_params,
        characters=characters,
    )
    batch_cfg = cfg.get("batch", {})
    retry_on_429 = batch_cfg.get("retry_on_429_enabled", False)
    retry_delay = batch_cfg.get("retry_on_429_delay_sec", 10)
    max_retries = batch_cfg.get("max_retries", 3)
    # 超时/网络中断重试（2026-07-10 加）：健康出图仅 ~6.5s，120s 空等纯浪费；
    # 60s 仍失败视为连接 hang（代理长连接偶发被掐），立即重投而非干等。默认开。
    req_timeout = batch_cfg.get("request_timeout_sec", 60)
    retry_on_timeout = batch_cfg.get("retry_on_timeout_enabled", True)
    timeout_delay = batch_cfg.get("retry_on_timeout_delay_sec", 3)
    max_timeout_retries = batch_cfg.get("max_timeout_retries", 2)
    # 服务端 5xx 重试（2026-07-12 加）：实测 char-ref（Precise Reference）请求偶发
    # HTTP 500 {"message":"read tcp ... i/o timeout"}=NAI 内网网关↔推理后端超时（非我方
    # schema/图片问题：同 payload 重试即成）。重请求（2MB 参考图）更易触发，可重试。默认开。
    retry_on_500 = batch_cfg.get("retry_on_500_enabled", True)
    s5_delay = batch_cfg.get("retry_on_500_delay_sec", 5)
    max_500_retries = batch_cfg.get("max_500_retries", 3)

    api_key = cfg["api_key"]
    attempt = 0        # 429 重试计数
    to_attempt = 0     # 超时/网络重试计数（独立于 429）
    s5_attempt = 0     # 服务端 5xx 重试计数（独立于 429/超时）
    while True:
        retry_sleep = None   # 本轮如需重试，锁外 sleep 的秒数（None=不重试）
        # 全局生成锁临界区=单次 post_nai+存图；异常仅决定是否重试，sleep 放到锁外。
        with _gen_lock():
            try:
                zip_bytes = post_nai(opener, api_key, payload, timeout=req_timeout)
                return save_images_from_zip(zip_bytes, output_dir, prefix, seed)
            except urllib.error.HTTPError as e:
                if e.code == 429 and retry_on_429 and attempt < max_retries:
                    attempt += 1
                    log(f"  ⚠ 429 限流，{retry_delay}s 后重试 (#{attempt}/{max_retries})", file=sys.stderr)
                    retry_sleep = retry_delay
                else:
                    body = ""
                    try:
                        body = e.read().decode("utf-8", errors="replace")
                    except Exception:
                        pass
                    # NAI 服务端 5xx（含 char-ref 常见 500 i/o timeout）：换 seed 无意义，同 payload 重投
                    if e.code >= 500 and retry_on_500 and s5_attempt < max_500_retries:
                        s5_attempt += 1
                        log(f"  ⚠ HTTP {e.code} NAI 服务端异常，{s5_delay}s 后重试 (#{s5_attempt}/{max_500_retries}): {body[:120]}", file=sys.stderr)
                        retry_sleep = s5_delay
                    else:
                        log(f"✗ HTTP {e.code}: {e.reason}", file=sys.stderr)
                        if body:
                            log(f"  详细: {body[:500]}", file=sys.stderr)
                        raise
            except urllib.error.URLError as e:
                # 超时/连接中断：同一 seed 立即重投（这次请求没产图，重投只是重现同一意图）
                if retry_on_timeout and to_attempt < max_timeout_retries:
                    to_attempt += 1
                    log(f"  ⚠ 网络超时/中断，{timeout_delay}s 后重试 (#{to_attempt}/{max_timeout_retries}): {e.reason}", file=sys.stderr)
                    retry_sleep = timeout_delay
                else:
                    log(f"✗ 网络错误(重试耗尽): {e}", file=sys.stderr)
                    raise
        # 锁已释放，重试等待放锁外（不抱锁睡觉挡别人）
        time.sleep(retry_sleep)


def sleep_with_jitter(cfg: dict):
    """按 batch 配置 sleep（含随机抖动）"""
    batch_cfg = cfg.get("batch", {})
    base = batch_cfg.get("interval_seconds", 1)
    jmin = batch_cfg.get("interval_jitter_min", 0)
    jmax = batch_cfg.get("interval_jitter_max", 0)
    if jmax > jmin:
        base += random.uniform(jmin, jmax)
    if base > 0:
        time.sleep(base)


def resolve_output_folder(cfg: dict) -> Path:
    folder = cfg.get("output_folder", "output/nai")
    path = Path(folder)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path


def run_batch(cfg: dict, *, positive: str, negative: str, model: str,
              width: int, height: int, count: int, seed: int | None,
              prefix: str, output_dir: Path,
              final_params: dict, characters: list[dict] | None = None,
              opener=None, log=print) -> list[Path]:
    """跑一批图（同一 prompt + 参数，不同 seed），返回保存路径列表。

    opener=None 则自建（worker 传入复用连接）；log 默认 print（CLI），worker 传入自定义。
    """
    if opener is None:
        opener = make_opener(cfg.get("proxy", ""))

    log(f"NAI 出图任务")
    log(f"  模型: {model}")
    log(f"  尺寸: {width}x{height}")
    log(f"  数量: {count}")
    log(f"  角色 prompt: {len([c for c in (characters or []) if c.get('text', '').strip()])}")
    log(f"  输出: {output_dir}")
    log(f"  代理: {cfg.get('proxy') or '直连'}")
    # V5 配额护栏（仅 V5 模型生效；V4.5 及更早零变化）
    check_v5_usage_guard(cfg, model, opener=opener, log=log)
    log()

    # 自愈式批量（2026-07-10 改）：以「跑够 count 张成功」为目标，而非「跑 count 次」。
    # 单帧内含 429+超时重试；仍失败则换 seed 补跑，直到凑够张数或撞防呆上限——
    # 从此偶发 hang 不再漏帧、不需要人工补跑。指定 seed 的单张不做换 seed 补跑（保持 seed 语义）。
    seeded_single = (count == 1 and seed is not None)
    max_total = count if seeded_single else count * 3   # 防呆：NAI 真挂了不无限跑

    total_saved: list[Path] = []
    attempts = 0
    while len(total_saved) < count and attempts < max_total:
        attempts += 1
        use_seed = seed if seeded_single else random.randint(1, 2**32 - 1)

        tag = f"[{len(total_saved) + 1}/{count}]"
        if attempts > count:
            tag += f"(补跑·第{attempts}次尝试)"
        log(f"{tag} seed={use_seed} 提交中...")
        try:
            saved = submit_one(cfg, opener, positive=positive, negative=negative, seed=use_seed,
                               model=model, width=width, height=height, output_dir=output_dir,
                               prefix=prefix, final_params=final_params, characters=characters,
                               log=log)
            if saved:
                for p in saved:
                    log(f"  ✓ {p}")
                    total_saved.append(p)
            else:
                log(f"  ⚠ 返回空图，换 seed 补跑", file=sys.stderr)
        except Exception as e:
            log(f"  ✗ 本帧失败，换 seed 补跑继续: {e}", file=sys.stderr)

        if len(total_saved) < count and attempts < max_total:
            sleep_with_jitter(cfg)

    log()
    if len(total_saved) < count:
        log(f"⚠ 达尝试上限 {max_total} 次，仅保存 {len(total_saved)}/{count} 张（NAI 可能异常，请查网络/并发锁）", file=sys.stderr)
    log(f"完成: 共保存 {len(total_saved)} 张图片")
    return total_saved


def submit_request(payload: dict, cfg: dict, *,
                   augment: bool = False, aug_preset: str | None = None,
                   enable_extra: list[str] | None = None,
                   global_layer: bool = True,
                   char_layers: bool = False,
                   opener=None, dry_run: bool = False,
                   log=print) -> dict:
    """纯业务入口（worker 唯一调用面）——把 json-stdin 的完整语义抽成可 import 的函数。

    payload 形状=现 json-stdin 完整语义(positive/negative/characters/cast/
    char_layer_assign/char_layer_views/count/seed/prefix/output/params)。
    返回 {"saved": [str路径...], "request": dry_run 时构建的请求 or None}。
    失败抛 NaiError 系，不 sys.exit、不吞异常。

    隐私边界不动：augment/char_layers 的隐私合并链原样保留，只在本进程内发生。
    """
    defaults = cfg["default_params"]

    positive = payload.get("positive", "")
    negative = payload.get("negative") if "negative" in payload else defaults.get("negative_prompt", "")
    characters = payload.get("characters", [])

    overrides = payload.get("params", {}) or {}

    # 顶层 char_reference（webapp 直投·公开显式参考·2026-07-13 期一B 切CLI）：
    # 最高优先级——在 augment/char_layers 分支之前设置，覆盖固定参考，也覆盖预构造的 params._char_reference。
    # 无该键时下方三级优先链与保护逻辑逐字节不变（overrides 里没有 _char_reference 就不动）。
    top_cr = payload.get("char_reference")
    if top_cr:
        overrides["_char_reference"] = char_ref_fields_from_payload(top_cr, cfg)

    views = payload.get("char_layer_views") or {}

    # --augment 语义：json-stdin 默认不套加装层（webapp/scenario 自带组装会重复）；
    # 显式 augment=True 时按 bare CLI 同款套用。角色加装层拼进 characters[0]（不新增角色）。
    if augment:
        aug = load_augmentation(cfg, aug_preset, enable_extra=enable_extra)
        # cast（该帧出场女角编号）驱动 role 门控紧凑落槽；payload 无 cast=None→走旧 char_index 路径（双路径 gate）
        cast = payload.get("cast")
        cast = cast if isinstance(cast, list) else None
        positive, negative, characters = apply_augmentation(
            positive, negative, characters, aug, cast=cast, views=views,
            global_rules=(load_global_layer(cfg) if global_layer else None))
        rules = load_replacements(cfg, aug_preset)
        if rules:
            positive, negative, characters = apply_replacements(positive, negative, characters, rules)
        # 固定角色参考（payload 未自带 _char_reference 时才套用；多张按 role/cast 门控挑张·整图 blend）
        if "_char_reference" not in overrides:
            aug_cr = augmentation_char_reference(
                aug, cast=cast, cfg=cfg,
                view=str(views.get("0") or views.get(0) or "front_full"))
            if aug_cr:
                overrides["_char_reference"] = aug_cr
    elif global_layer:
        positive, negative, characters = apply_augmentation(
            positive, negative, characters, None,
            global_rules=load_global_layer(cfg))

    # --char-layers 语义：角色加装层按槽指派（与 augment 独立、可并存）。
    if char_layers:
        assign = payload.get("char_layer_assign") or {}
        layers_by_id = load_character_layers(cfg)
        positive, negative, characters = apply_character_layers(positive, negative, characters, assign, layers_by_id, views)
        # 整图级参考图（NAI 限制·只取第一张）；augment 已设则不覆盖
        if "_char_reference" not in overrides:
            cl_cr = character_layers_char_reference(assign, layers_by_id, cfg=cfg)
            if cl_cr:
                overrides["_char_reference"] = cl_cr

    count = int(payload.get("count", 1))
    seed = payload.get("seed")
    if seed is not None:
        seed = int(seed)
    prefix = payload.get("prefix", "nai")
    output_dir = Path(payload["output"]) if payload.get("output") else resolve_output_folder(cfg)

    final_params = merge_params(cfg, overrides)
    model = final_params.get("model", defaults.get("model"))
    width = int(final_params.get("width", defaults.get("width", 832)))
    height = int(final_params.get("height", defaults.get("height", 1216)))

    sanity_check_json_stdin(positive, negative, characters)

    if dry_run:
        request = build_request(
            cfg, positive=positive, negative=negative,
            seed=(seed if seed is not None else 0), model=model,
            width=width, height=height, final_params=final_params, characters=characters,
        )
        return {"saved": [], "request": request}

    saved = run_batch(
        cfg,
        positive=positive,
        negative=negative,
        model=model,
        width=width,
        height=height,
        count=count,
        seed=seed,
        prefix=prefix,
        output_dir=output_dir,
        final_params=final_params,
        characters=characters,
        opener=opener,
        log=log,
    )
    return {"saved": [str(p) for p in saved], "request": None}


def main_json_stdin():
    """JSON stdin 仅保留公开 dry-run；实际提交必须走终端工单。"""
    if "--dry-run" not in sys.argv:
        raise SystemExit(
            "✗ submit_nai.py CLI 实际提交已禁用：请通过 draw.py/runner/webapp "
            "投递 NAI 出图终端统一工单。")
    private_flags = [f for f in ("--augment", "--aug-preset", "--enable-extra", "--char-layers")
                     if f in sys.argv]
    if private_flags:
        raise SystemExit(
            "✗ 直接 CLI dry-run 不得加载私密层（检测到 " + ", ".join(private_flags) +
            "）；请用公开 runner --dry 审查终端前 payload。")
    cfg = load_config()

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"✗ stdin JSON 解析失败: {e}", file=sys.stderr)
        sys.exit(2)

    # argv 解析（CLI 兼容）；enable_extra=None → load_augmentation 内部沿用 argv 嗅探。
    result = submit_request(
        payload, cfg,
        augment=False,
        aug_preset=None,
        enable_extra=None,
        global_layer=False,
        char_layers=False,
        dry_run=True,
    )
    print(json.dumps(result["request"], ensure_ascii=False, indent=2))


def main():
    # JSON stdin 模式
    if "--json-stdin" in sys.argv:
        main_json_stdin()
        return

    ap = argparse.ArgumentParser(description="NAI 内部引擎（CLI 仅支持无私密层 dry-run）")
    ap.add_argument("prompt", help="正向提示词")
    ap.add_argument("--negative", help="负向提示词（默认用配置里的）")
    ap.add_argument("--count", type=int, default=1, help="跑几张图（每张不同 seed）")
    ap.add_argument("--seed", type=int, help="指定 seed（仅当 count=1 时生效）")
    ap.add_argument("--width", type=int, help="覆盖宽度")
    ap.add_argument("--height", type=int, help="覆盖高度")
    ap.add_argument("--model", help="覆盖模型")
    ap.add_argument("--prefix", default="nai", help="输出文件名前缀")
    ap.add_argument("--output", help="覆盖输出目录")
    ap.add_argument("--no-defaults", action="store_true",
                    help="不自动拼接 nai_config.default_base_blocks（默认会把 enabled 的默认 block 用逗号拼到 prompt 前面）")
    ap.add_argument("--no-augmentation", action="store_true",
                    help="不套固定加装层 + 替换规则（nai_config.augmentation / replacements）。默认会自动套用。")
    ap.add_argument("--no-variety", action="store_true",
                    help="本次关闭 variety_plus（多样性扰动 skip_cfg）。不改全局 config，多对话并行安全。多人/复杂构图易因 variety 崩坏时用。")
    ap.add_argument("--dry-run", action="store_true",
                    help="只打印不含任何私密层的公开请求；必须同时给 --no-augmentation。")
    ap.add_argument("--aug-preset", help="指定加装预设 id（覆盖 activeId，不改全局配置，多对话并行安全）")
    ap.add_argument("--char-ref", help="Precise Reference 参考图路径（角色参考，仅 V4.5）")
    ap.add_argument("--cr-strength", type=float, default=1.0,
                    help="角色参考 Strength（0-1，默认 1.0）")
    ap.add_argument("--cr-fidelity", type=float, default=1.0,
                    help="角色参考 Fidelity（0-1，默认 1.0；越高越严格还原）")
    ap.add_argument("--cr-mode", choices=CHAR_REF_MODES, default="character",
                    help="角色参考模式：character&style（角色+画风）/ character（仅角色，默认）/ style（仅画风）")
    args = ap.parse_args()

    if not args.dry_run:
        raise SystemExit(
            "✗ submit_nai.py CLI 实际提交已禁用：请通过 draw.py/runner/webapp "
            "投递 NAI 出图终端统一工单。")
    if not args.no_augmentation:
        raise SystemExit(
            "✗ 直接 CLI dry-run 不得输出私密最终 prompt；"
            "请加 --no-augmentation，或用公开 runner --dry 审查终端前 payload。")

    cfg = load_config()
    defaults = cfg["default_params"]

    positive = args.prompt
    # 默认行为：把 nai_config.default_base_blocks 中 enabled+text 的 block 拼到 prompt 前面
    # （逗号分隔——NAI 不识别 BREAK，旧版误用 BREAK 会变噪声）
    if not args.no_defaults:
        default_blocks = cfg.get("default_base_blocks")
        prefix_parts: list[str] = []
        if isinstance(default_blocks, list):
            for b in default_blocks:
                if not isinstance(b, dict): continue
                text = (b.get("text") or "").strip().rstrip(",").strip()
                if b.get("enabled") and text:
                    prefix_parts.append(text + ",")
        elif isinstance(default_blocks, dict):
            # 旧 Record 格式兼容：按值顺序拼
            for k, v in default_blocks.items():
                if isinstance(v, str) and v.strip():
                    prefix_parts.append(v.strip().rstrip(",") + ",")
        if prefix_parts:
            positive = "\n".join(prefix_parts + [args.prompt])

    negative = args.negative if args.negative is not None else defaults.get("negative_prompt", "")

    # 固定加装层（bare CLI 专属：AI 批量跑图走这条；json-stdin 路径不套）
    aug = None if args.no_augmentation else load_augmentation(cfg, args.aug_preset)
    positive, negative, characters = apply_augmentation(
        positive, negative, None, aug, global_rules=None)

    # 替换规则（最后一道：注入加装层之后，对最终 prompt 全做一遍）
    if not args.no_augmentation:
        rules = load_replacements(cfg)
        positive, negative, characters = apply_replacements(positive, negative, characters, rules)

    # 命令行 overrides
    overrides: dict = {}
    if args.no_variety: overrides["variety_plus"] = False
    if args.width is not None: overrides["width"] = args.width
    if args.height is not None: overrides["height"] = args.height
    if args.model is not None: overrides["model"] = args.model
    if args.char_ref:
        overrides["_char_reference"] = build_char_reference(
            args.char_ref,
            strength=args.cr_strength,
            fidelity=args.cr_fidelity,
            base_caption=args.cr_mode,
        )
    else:
        # 命令行没显式给参考图时，套用固定加装层里的角色参考（若启用）
        aug_cr = augmentation_char_reference(aug)
        if aug_cr:
            overrides["_char_reference"] = aug_cr

    final_params = merge_params(cfg, overrides)
    model = final_params.get("model", defaults["model"])
    width = int(final_params.get("width", defaults["width"]))
    height = int(final_params.get("height", defaults["height"]))
    output_dir = Path(args.output) if args.output else resolve_output_folder(cfg)

    if args.dry_run:
        seed = args.seed if args.seed is not None else 0
        payload = build_request(
            cfg, positive=positive, negative=negative, seed=seed, model=model,
            width=width, height=height, final_params=final_params, characters=characters,
        )
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    run_batch(
        cfg,
        positive=positive,
        negative=negative,
        model=model,
        width=width,
        height=height,
        count=args.count,
        seed=args.seed,
        prefix=args.prefix,
        output_dir=output_dir,
        final_params=final_params,
        characters=characters,
    )


def _cli_entry():
    """CLI 入口包装：把 worker 用的异常体系翻译回原文案+原退出码（byte 一致）。"""
    try:
        main()
    except NaiConfigError:
        # 原 load_config 缺文件时的两行文案 + 退出码 1
        print(f"✗ 配置文件不存在: {CONFIG_PATH}", file=sys.stderr)
        print(f"  请复制 data/nai_config.example.json 为 data/nai_config.json 并填入 API Token", file=sys.stderr)
        sys.exit(1)
    except NaiValidationError as e:
        # 原 build_parameters 的 raise SystemExit(str) 语义：消息打到 stderr + 退出码 1
        print(str(e), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _cli_entry()

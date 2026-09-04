#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""共享桥: 公开 payload → RenderJob 工单 → 经唯一官方 emitter 投递（NAI 出图终端）。

三 runner、scenario 和 webapp 全部复用本模块：收集帧 → 组装一张 RenderJob 工单
→ `job_emitter.submit`。它是旧 json-stdin payload 转统一工单的唯一公开翻译层，
不存在回退 `submit_nai.py` CLI 直连 NAI 的分支。

翻译层铁律: 不改动任何 prompt 内容（positive/negative/caption 原文透传），只做形状搬运 + 参数快照。
payload 形状 = 现 json-stdin 完整语义（positive/negative/characters/cast/char_layer_assign/
char_layer_views/count/seed/prefix/output/params）。翻译规则见各方法 docstring（施工设计定版 2026-07-13）。
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import job_emitter as JE

# generation 源键（含 config camelCase 别名）；这些从 merged 消费掉、不再进「丢弃告警」
_GEN_SOURCE_KEYS = {
    "model", "width", "height", "steps", "sampler", "scale", "cfg_rescale",
    "noise_schedule", "variety_plus", "auto_position",
    "quality_toggle", "qualityToggle", "uc_preset", "ucPreset",
}
# advanced 透传白名单 = schema $defs/advanced 属性（与 submit_nai ADV_PASSTHROUGH 对齐）
_ADV_KEYS = (
    "prefer_brownian", "deliberate_euler_ancestral_bug", "cfg_sched_eligibility",
    "skip_cfg_above_sigma", "skip_cfg_below_sigma", "legacy_v3_extend",
    "dynamic_thresholding_percentile", "dynamic_thresholding_mimic_scale",
    "explike_fine_detail", "minimize_sigma_inf", "uncond_per_vibe", "wonky_vibe_correlation",
)
# 明确「非 generation、静默忽略」的键（负向词=base_negative 源；张数=samples/count；seed 单独取）
_IGNORE_KEYS = {"negative_prompt", "n_samples", "seed"}


def _load_config() -> dict:
    return json.load(open(os.path.join(ROOT, "data", "nai_config.json"), encoding="utf-8"))


def _pick(merged: dict, *keys, default=None):
    for k in keys:
        if k in merged:
            return merged[k]
    return default


class TranslationError(Exception):
    """payload→工单翻译失败（越界输出/cast 超员/输出目录不一致等）。"""


class JobCollector:
    """收集多帧 payload → 组装并投递一张 RenderJob 工单。用法: 逐帧 add()，最后 submit()。"""

    def __init__(self, *, workspace_root: str | None = None, cfg: dict | None = None,
                 clean: bool = False, log=print):
        self._cfg = cfg if cfg is not None else _load_config()
        self.workspace_root = workspace_root or self._cfg.get("output_folder")
        if not self.workspace_root:
            raise TranslationError("workspace_root 未定（nai_config.json 缺 output_folder）")
        # v1 schema compatibility only.  The worker deliberately ignores this
        # field; actual Clean behaviour is owned by the App's binary switch.
        self.clean = bool(clean)
        self.log = log
        self.frames: list[JE.RenderFrame] = []
        self._frame_ids: set[str] = set()
        self._output_rel: str | None = None       # 整单唯一输出相对路径
        self._aug: tuple | None = None            # (preset_id, tuple(extras), frozenset(char_layer_assign.items()))
        self._paid = False                        # 是否任一帧需计 Anlas（char_layer_assign 或预设带 enabled 参考）
        self._warned_keys: set[str] = set()

    # -------------------------------------------------------------- helpers

    def _frame_id(self, prefix: str) -> str:
        """由 prefix 派生合法唯一 frame_id：非 [A-Za-z0-9._-] → '_'；首字符非字母数字则前置 'f'；重复加 _N。"""
        fid = re.sub(r"[^A-Za-z0-9._-]", "_", prefix or "")
        if not fid or not re.match(r"[A-Za-z0-9]", fid[0]):
            fid = "f" + fid
        fid = fid[:64]                            # schema frame_id 上限 64
        base, n = fid, 2
        while fid in self._frame_ids:
            suf = f"_{n}"
            fid = base[:64 - len(suf)] + suf
            n += 1
        self._frame_ids.add(fid)
        return fid

    def _output_rel_of(self, payload: dict) -> str:
        out_abs = payload.get("output")
        if not out_abs:
            raise TranslationError("payload 缺 output（终端投递需绝对输出目录）")
        rel = os.path.relpath(out_abs, self.workspace_root)
        if rel == os.pardir or rel.startswith(os.pardir + os.sep) or os.path.isabs(rel):
            raise TranslationError(f"输出目录不在 workspace 根内: {out_abs}（根={self.workspace_root}）")
        return rel.replace("\\", "/")

    def _generation(self, params: dict) -> JE.GenerationSpec:
        merged = {**self._cfg.get("default_params", {}), **(params or {})}
        adv = {k: merged[k] for k in _ADV_KEYS if k in merged and merged[k] is not None}
        for k in merged:                          # 白名单外的键: 丢弃 + 一次性告警
            if k in _GEN_SOURCE_KEYS or k in _ADV_KEYS or k in _IGNORE_KEYS:
                continue
            if k not in self._warned_keys:
                self._warned_keys.add(k)
                self.log(f"  ⚠ [via-terminal] 参数 '{k}' 不在 RenderJob 生成字段/advanced 白名单，"
                         f"投递时丢弃（终端按其 config 兜底）")
        # V4 及以上归一（镜像 submit_nai.build_parameters 执行时行为：强制 karras；sm/sm_dyn 已随白名单丢弃）
        # 忠实帧快照可能带旧时代 native/sm 值，工单必须记录「实际生效」参数而非原始快照值
        # 判据与 job_emitter._is_v4plus / submit_nai.is_v4plus_model 同源，改一处须同步三处。
        noise_schedule = merged["noise_schedule"]
        if JE._is_v4plus(merged["model"]):
            noise_schedule = "karras"
        return JE.GenerationSpec(
            model=merged["model"],
            width=int(merged["width"]),
            height=int(merged["height"]),
            steps=int(merged["steps"]),
            sampler=merged["sampler"],
            scale=float(merged["scale"]),
            cfg_rescale=float(merged["cfg_rescale"]),
            noise_schedule=noise_schedule,
            variety_plus=bool(merged["variety_plus"]),
            auto_position=bool(merged["auto_position"]),
            quality_toggle=bool(_pick(merged, "quality_toggle", "qualityToggle", default=True)),
            uc_preset=int(_pick(merged, "uc_preset", "ucPreset", default=0)),
            advanced=(adv or None),
        )

    def _characters(self, payload: dict) -> list[JE.CharacterPrompt]:
        chars = payload.get("characters") or []
        cast = payload.get("cast") or []
        if len(cast) > len(chars):
            raise TranslationError(f"cast 数({len(cast)}) > 角色数({len(chars)})，越界（女角排最前铁律）")
        views = payload.get("char_layer_views") or {}
        out = []
        for i, c in enumerate(chars):
            out.append(JE.CharacterPrompt(
                slot_id=f"char_{i}",
                caption=c.get("text", ""),
                negative=(c.get("negative") or ""),
                x=float(c.get("x", 0.5)),
                y=float(c.get("y", 0.5)),
                view=(views.get(str(i)) or "front_full"),
                cast_id=(cast[i] if i < len(cast) else None),
            ))
        return out

    def _char_reference(self, payload: dict) -> JE.CharReference | None:
        """公开顶层 char_reference 原样搬进工单；已展开的内部数组不属于公开契约。"""
        raw = payload.get("char_reference")
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise TranslationError("char_reference 必须是 object")
        image_b64 = raw.get("image_b64")
        if not isinstance(image_b64, str) or not image_b64:
            raise TranslationError("char_reference.image_b64 缺失或为空")
        mode = raw.get("mode", raw.get("base_caption", "character"))
        if mode not in ("character&style", "character", "style"):
            raise TranslationError(f"char_reference.mode/base_caption 非法: {mode!r}")
        try:
            strength = float(raw.get("strength", 1.0))
            fidelity = float(raw.get("fidelity", 1.0))
        except (TypeError, ValueError) as e:
            raise TranslationError("char_reference strength/fidelity 必须是数字") from e
        return JE.CharReference(image_b64=image_b64, strength=strength,
                                fidelity=fidelity, mode=mode)

    def _preset_has_enabled_charref(self, preset_id: str) -> bool:
        presets = (self._cfg.get("augmentation_presets") or {}).get("presets") or []
        for p in presets:
            if p.get("id") == preset_id:
                return any(cr.get("enabled") for cr in (p.get("char_references") or []))
        return False

    # -------------------------------------------------------------- API

    def add(self, payload: dict, *, augment: bool,
            aug_preset: str | None = None,
            enable_extra: list[str] | None = None) -> None:
        """把一帧 payload 翻译成 RenderFrame 收进本单。整单的 output/augmentation 首帧定基、后续不一致抛错。

        augment（CRITICAL·期一A越权加装 bug 修法）：
          - augment=False → 忠实/无加装跑，工单 preset_id=null（不得兜底 activeId、不得带 enable_extra）；
          - augment=True 且 aug_preset=None → 兜底 config.activeId；
          - augment=True 且 aug_preset 显式给出 → 用之。
        """
        # params._char_reference 是 submit_nai 内部已展开 director_reference_* 数组，不属于公开工单契约。
        if (payload.get("params") or {}).get("_char_reference") is not None:
            raise TranslationError(
                "params._char_reference 是内部展开形状，无法无损翻译为统一工单；"
                "请改传顶层 char_reference {image_b64,strength,fidelity,mode|base_caption}。")
        rel = self._output_rel_of(payload)
        if self._output_rel is None:
            self._output_rel = rel
        elif rel != self._output_rel:
            raise TranslationError(
                f"整单输出目录必须一致：首帧 {self._output_rel!r} vs 本帧 {rel!r}（一套图一个目录）")

        cla = payload.get("char_layer_assign")
        cla = {str(k): v for k, v in cla.items()} if cla else None
        # v1.1 无加装合法态：augment=False → preset_id=null；augment=True 未给 preset → 兜底 activeId
        if augment:
            preset_id = aug_preset or (self._cfg.get("augmentation_presets") or {}).get("activeId")
            if not preset_id:
                raise TranslationError("augment=True 但未给 aug_preset 且 config 无 activeId")
            extras = tuple(enable_extra or [])
        else:
            preset_id = None
            if enable_extra:
                raise TranslationError("augment=False（无加装）时不得指定 enable_extra")
            extras = ()
        aug_key = (preset_id, extras, frozenset((cla or {}).items()))
        if self._aug is None:
            self._aug = aug_key
            self._preset_id, self._extras, self._char_layer_assign = preset_id, list(extras), cla
        elif aug_key != self._aug:
            raise TranslationError("整单 augmentation（preset/extras/char_layer_assign）必须一致，首帧后不得变")

        char_reference = self._char_reference(payload)
        if cla or char_reference is not None or self._preset_has_enabled_charref(preset_id):
            self._paid = True

        frame = JE.RenderFrame(
            frame_id=self._frame_id(payload.get("prefix", "")),
            output_name=payload.get("prefix", ""),
            base_positive=payload.get("positive", ""),
            base_negative=payload.get("negative", "") or "",
            characters=self._characters(payload),
            generation=self._generation(payload.get("params") or {}),
            samples=JE.make_samples(int(payload.get("count", 1)), payload.get("seed")),
            char_reference=char_reference,
        )
        self.frames.append(frame)

    def submit(self) -> JE.JobReceipt:
        """组装 RenderJob（build_job 内自动 validate）→ POST 终端 → 打印回执后返回。"""
        if not self.frames:
            raise TranslationError("无帧可投递（collector 为空）")
        total = sum(len(f.samples) for f in self.frames)
        max_anlas = 5 * total if self._paid else 0
        display_name = self._output_rel.rsplit("/", 1)[-1]
        job = JE.build_job(
            frames=self.frames,
            augmentation=JE.AugmentationSpec(
                preset_id=self._preset_id, extras=self._extras,
                char_layer_assign=self._char_layer_assign),
            output=JE.OutputTarget(relative_path=self._output_rel),
            limits=JE.BudgetLimits(max_images=total, max_anlas=max_anlas),
            clean=self.clean,
            display_name=display_name,
        )
        self.log(f"\n📮 投递工单 → 终端 (帧 {len(self.frames)} / 张 {total} / preset {self._preset_id}"
                 f" / max_anlas {max_anlas})")
        receipt = JE.submit(job)
        self.log(f"   job_id={receipt.job_id}  status={receipt.status}"
                 f"  queue_position={receipt.queue_position}"
                 + (f"  (replayed)" if receipt.replayed else ""))
        status_url = receipt.raw.get("status_url")
        if status_url:
            self.log(f"   status_url={status_url}")
        return receipt


def submit_collected(collector: "JobCollector | None", *, log=print):
    """runner 收尾统一投递：终端不可达（未启动/网络类）→ 清晰报错提示，禁止静默回退直连。

    切默认后所有 runner/scenario 的收尾都走这里。终端已启动但拒单（HTTP 4xx）→ 照原样报拒单原文，
    不提示「去启动终端」（那会误导）。返回 JobReceipt；失败以 SystemExit(1) 退出（CLI 语义）。
    """
    if collector is None or not collector.frames:
        return None
    try:
        return collector.submit()
    except JE.EmitterError as e:
        cause = e.__cause__
        not_started = (
            "读不到终端 token" in str(e) or "连不上终端" in str(e)
            or (isinstance(cause, urllib.error.URLError)
                and not isinstance(cause, urllib.error.HTTPError)))
        log(f"\n✗ 投递出图终端失败：{e}")
        if not_started:
            log("  → 请打开“NAI 出图终端” App，点击“一键启动”后重试。")
        raise SystemExit(1)


def main(argv: list[str] | None = None) -> int:
    """webapp/兼容客户端的薄 CLI：只做 payload→工单投递，stdout 只返回公开回执。"""
    import argparse

    ap = argparse.ArgumentParser(description="公开 payload → NAI 出图终端统一工单")
    ap.add_argument("--json-stdin", action="store_true", help="从 stdin 读取一帧公开 payload")
    ap.add_argument("--augment", action="store_true", help="使用终端预设（未指定 id 时用 activeId）")
    ap.add_argument("--aug-preset", help="指定公开的终端预设 id")
    ap.add_argument("--enable-extra", help="逗号分隔的特殊项 id/名称")
    args = ap.parse_args(argv)
    if not args.json_stdin:
        ap.error("只支持 --json-stdin；手写 RenderJob 请走 job_emitter 库函数")
    if args.aug_preset and not args.augment:
        ap.error("--aug-preset 必须与 --augment 同用")
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"✗ stdin JSON 解析失败：{e}", file=sys.stderr)
        return 2
    if not isinstance(payload, dict):
        print("✗ stdin 必须是 JSON object", file=sys.stderr)
        return 2

    extras = ([x.strip() for x in (args.enable_extra or "").split(",") if x.strip()]
              if args.enable_extra else None)
    try:
        collector = JobCollector(log=lambda m: print(m, file=sys.stderr))
        collector.add(payload, augment=args.augment,
                      aug_preset=(args.aug_preset if args.augment else None),
                      enable_extra=(extras if args.augment else None))
        receipt = submit_collected(collector, log=lambda m: print(m, file=sys.stderr))
    except TranslationError as e:
        print(f"✗ 无法翻译为终端工单：{e}", file=sys.stderr)
        return 2
    if receipt is None:
        print("✗ 工单为空，未投递", file=sys.stderr)
        return 2
    print(json.dumps({
        "ok": True,
        "queued": True,
        "job_id": receipt.job_id,
        "status": receipt.status,
        "queue_position": receipt.queue_position,
        "status_url": receipt.raw.get("status_url"),
        "echo_url": receipt.raw.get("echo_url"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

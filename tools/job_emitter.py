#!/usr/bin/env python3
"""RenderJob v1 唯一官方 emitter（NAI 出图终端·期一）。

全库所有跑图入口（三 runner / scenario / webapp / 手动挡）只准经本模块投递工单；
手册明文禁止手写工单 JSON 或绕开本入口（CLAUDE.md §10 / project_NAI出图终端.md §七）。

职责：强类型 builder → 展开固定 seed → 结构校验(schema) + 语义校验(跨字段/白名单)
      → JCS 兼容 canonical 化 → 幂等键 → POST 终端 /v1/jobs。
终端 worker 从本模块 import 同一套校验/白名单 = 双向校验同源零漂移。

schema 权威源 = schemas/render_job.v1.json；改字段必须先改 schema 再改本文件（同 commit）。
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

TOOLS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TOOLS_DIR.parent
SCHEMA_PATH = PROJECT_ROOT / "schemas" / "render_job.v1.json"
TOKEN_PATH = PROJECT_ROOT / "data" / "terminal_token"
DEFAULT_TERMINAL_URL = os.environ.get("NAI_TERMINAL_URL", "http://127.0.0.1:8747")

SCHEMA_VERSION = "render_job.v1"
PRIVATE_SENTINEL = "__TERMINAL_PRIVATE__"

# ---- 语义白名单（emitter 与终端 worker 双端共用的权威源；扩项直接改这里，无需动 schema 版本） ----
ALLOWED_MODELS = (
    "nai-diffusion-5-full",
    "nai-diffusion-5-curated",
    "nai-diffusion-4-5-full",
    "nai-diffusion-4-5-curated",
    "nai-diffusion-4-full",
    "nai-diffusion-3",
)
# V4 及以上（v4_prompt 结构 + 强制 karras）；与 submit_nai.is_v4plus_model 同语义，改一处须同步另一处。
V4PLUS_MODEL_PREFIXES = ("nai-diffusion-4", "nai-diffusion-5")


def _is_v4plus(model: str) -> bool:
    return any(str(model).startswith(p) for p in V4PLUS_MODEL_PREFIXES)


def _is_v5(model: str) -> bool:
    return str(model).startswith("nai-diffusion-5")
ALLOWED_SAMPLERS = (
    "k_euler",
    "k_euler_ancestral",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m",
    "k_dpmpp_2m_sde",
    "k_dpmpp_sde",
    "ddim_v3",
)
ALLOWED_NOISE_SCHEDULES = ("native", "karras", "exponential", "polyexponential")
VIEW_KEYS = (
    "front_full", "front_cowboy", "front_upper", "front_mid", "front_lower",
    "back_full", "back_cowboy", "back_upper", "back_mid", "back_lower",
)
CHAR_REF_MODES = ("character&style", "character", "style")
SEED_MAX = 4294967295


class EmitterError(Exception):
    """工单构造/校验/投递失败（库内不 sys.exit，调用方处置）。"""


# ---------------------------------------------------------------- dataclasses

@dataclass(frozen=True)
class CharacterPrompt:
    slot_id: str
    caption: str
    negative: str = ""
    x: float = 0.5
    y: float = 0.5
    view: str = "front_full"
    cast_id: str | None = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "slot_id": self.slot_id,
            "caption": self.caption,
            "negative": self.negative,
            "center": {"x": self.x, "y": self.y},
            "view": self.view,
        }
        if self.cast_id:
            d["cast_id"] = self.cast_id
        return d


@dataclass(frozen=True)
class GenerationSpec:
    model: str
    width: int
    height: int
    steps: int
    sampler: str
    scale: float
    cfg_rescale: float
    noise_schedule: str
    variety_plus: bool
    auto_position: bool
    quality_toggle: bool
    uc_preset: int
    advanced: Mapping[str, Any] | None = None

    def to_dict(self) -> dict:
        d = {
            "model": self.model, "width": self.width, "height": self.height,
            "steps": self.steps, "sampler": self.sampler, "scale": self.scale,
            "cfg_rescale": self.cfg_rescale, "noise_schedule": self.noise_schedule,
            "variety_plus": self.variety_plus, "auto_position": self.auto_position,
            "quality_toggle": self.quality_toggle, "uc_preset": self.uc_preset,
        }
        if self.advanced:
            d["advanced"] = dict(self.advanced)
        return d


@dataclass(frozen=True)
class RenderSample:
    sample_id: str
    seed: int


@dataclass(frozen=True)
class CharReference:
    image_b64: str
    strength: float
    fidelity: float
    mode: str = "character"

    def to_dict(self) -> dict:
        return {"image_b64": self.image_b64, "strength": self.strength,
                "fidelity": self.fidelity, "mode": self.mode}


@dataclass(frozen=True)
class RenderFrame:
    frame_id: str
    output_name: str
    base_positive: str
    base_negative: str
    characters: Sequence[CharacterPrompt]
    generation: GenerationSpec
    samples: Sequence[RenderSample]
    char_reference: CharReference | None = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "frame_id": self.frame_id,
            "output_name": self.output_name,
            "prompt": {
                "base_positive": self.base_positive,
                "base_negative": self.base_negative,
                "characters": [c.to_dict() for c in self.characters],
            },
            "generation": self.generation.to_dict(),
            "samples": [{"sample_id": s.sample_id, "seed": s.seed} for s in self.samples],
        }
        if self.char_reference is not None:
            d["char_reference"] = self.char_reference.to_dict()
        return d


@dataclass(frozen=True)
class OutputTarget:
    relative_path: str
    root: str = "workspace"
    collision_policy: str = "append_suffix"


@dataclass(frozen=True)
class BudgetLimits:
    max_images: int
    max_anlas: int = 0


@dataclass(frozen=True)
class AugmentationSpec:
    preset_id: str | None  # v1.1: None=无加装合法态（此时 extras 必须为空；char_layer_assign 仍允许）
    extras: Sequence[str] = ()
    global_layer: bool = True
    char_layer_assign: Mapping[str, str] | None = None  # 过渡字段·期二废


# ---------------------------------------------------------------- seed / uuid

def make_samples(count: int, seed: int | None = None, prefix: str = "s") -> list[RenderSample]:
    """seed 预展开：指定 seed 且 count==1 用之；否则逐张随机（投递前固定，终端不再随机）。"""
    if count < 1:
        raise EmitterError(f"count 必须 >=1，收到 {count}")
    out = []
    for i in range(count):
        s = seed if (seed is not None and count == 1) else secrets.randbelow(SEED_MAX + 1)
        out.append(RenderSample(sample_id=f"{prefix}{i + 1:02d}", seed=int(s)))
    return out


def uuid7() -> str:
    """UUIDv7（毫秒时间戳 + 随机），小写规范格式。"""
    ts = int(time.time() * 1000) & ((1 << 48) - 1)
    ra = secrets.randbits(12)
    rb = secrets.randbits(62)
    v = (ts << 80) | (0x7 << 76) | (ra << 64) | (0b10 << 62) | rb
    h = f"{v:032x}"
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


# ---------------------------------------------------------------- canonical / 幂等

def _canon(v: Any) -> Any:
    """JCS 兼容子集：整型浮点降为 int（5.0→5），其余浮点用最短 round-trip 表示。
    工单数值域（0~2^32、0-1 小数）内与 RFC8785 输出一致；跨语言端共享测试向量钉死。"""
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            raise EmitterError("工单禁止 NaN/Infinity")
        return int(v) if v.is_integer() else v
    if isinstance(v, dict):
        return {k: _canon(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_canon(x) for x in v]
    return v


IDEM_FIELDS = ("schema_version", "job_id", "display_name", "augmentation",
               "output", "clean", "limits", "frames")


def canonicalize_job(job: Mapping[str, Any]) -> bytes:
    subset = {k: _canon(job[k]) for k in IDEM_FIELDS if k in job}
    return json.dumps(subset, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def compute_idempotency_key(job: Mapping[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonicalize_job(job)).hexdigest()


# ---------------------------------------------------------------- build / validate

def build_job(
    *,
    frames: Sequence[RenderFrame],
    augmentation: AugmentationSpec,
    output: OutputTarget,
    limits: BudgetLimits | None = None,
    clean: bool = False,
    display_name: str | None = None,
    job_id: str | None = None,
) -> dict:
    """构造完整 RenderJob dict（含幂等键），随后自动 validate_job。

    ``clean`` 仅保留 v1 工单格式兼容性；实际 Clean 只由终端 App 开关决定。
    """
    aug: dict[str, Any] = {
        "preset_id": augmentation.preset_id,
        "extras": list(dict.fromkeys(augmentation.extras)),
        "global_layer": bool(augmentation.global_layer),
        "private_content": PRIVATE_SENTINEL,
    }
    if augmentation.char_layer_assign:
        aug["char_layer_assign"] = dict(augmentation.char_layer_assign)
    total = sum(len(f.samples) for f in frames)
    lim = limits or BudgetLimits(max_images=total)
    job: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "job_id": job_id or uuid7(),
        "idempotency_key": "sha256:" + "0" * 64,  # 占位，下方回填
        "display_name": display_name or output.relative_path.rsplit("/", 1)[-1],
        "augmentation": aug,
        "output": {"root": output.root, "relative_path": output.relative_path,
                   "collision_policy": output.collision_policy},
        "clean": bool(clean),
        "limits": {"max_images": lim.max_images, "max_anlas": lim.max_anlas},
        "frames": [f.to_dict() for f in frames],
        "emitter_version": _git_rev(),
        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    job["idempotency_key"] = compute_idempotency_key(job)
    validate_job(job)
    return job


_schema_cache: dict | None = None


def _schema() -> dict:
    global _schema_cache
    if _schema_cache is None:
        _schema_cache = json.loads(SCHEMA_PATH.read_text("utf-8"))
    return _schema_cache


def validate_job(job: Mapping[str, Any]) -> None:
    """结构(schema) + 语义(跨字段/白名单) 全量校验；不合格抛 EmitterError。发送端与终端接收端各调一次。"""
    import jsonschema
    v = jsonschema.Draft202012Validator(_schema())
    errs = sorted(v.iter_errors(job), key=lambda e: list(e.absolute_path))
    if errs:
        e = errs[0]
        raise EmitterError(f"schema 校验失败({len(errs)}处)，首处 {'/'.join(map(str, e.absolute_path))}: {e.message}")

    # 跨字段语义校验
    if compute_idempotency_key(job) != job["idempotency_key"]:
        raise EmitterError("idempotency_key 与工单内容不符（禁止手改工单）")
    # v1.1: preset_id=null（无加装）时 extras 必须为空数组（validator 强制）
    if job["augmentation"].get("preset_id") is None and (job["augmentation"].get("extras") or []):
        raise EmitterError("preset_id=null（无加装）时 extras 必须为空数组（套图级特殊栏无预设可挂）")
    fids: set[str] = set()
    total = 0
    for f in job["frames"]:
        if f["frame_id"] in fids:
            raise EmitterError(f"frame_id 重复: {f['frame_id']}")
        fids.add(f["frame_id"])
        g = f["generation"]
        if g["model"] not in ALLOWED_MODELS:
            raise EmitterError(f"model 不在白名单: {g['model']}（扩项改 job_emitter.ALLOWED_MODELS）")
        if g["sampler"] not in ALLOWED_SAMPLERS:
            raise EmitterError(f"sampler 不在白名单: {g['sampler']}")
        if g["noise_schedule"] not in ALLOWED_NOISE_SCHEDULES:
            raise EmitterError(f"noise_schedule 不在白名单: {g['noise_schedule']}")
        if _is_v4plus(g["model"]) and g["noise_schedule"] != "karras":
            raise EmitterError(f"V4 系模型强制 karras，收到 {g['noise_schedule']}（帧 {f['frame_id']}）")
        if f.get("char_reference") is not None and not g["model"].startswith("nai-diffusion-4-5"):
            if _is_v5(g["model"]):
                raise EmitterError(
                    f"char_reference（Precise Reference）在 V5 尚未上线，"
                    f"需要角色参考请改用 V4.5 模型（帧 {f['frame_id']} model={g['model']}）")
            raise EmitterError(f"char_reference 仅 V4.5 支持（帧 {f['frame_id']} model={g['model']}）")
        sids = [s["sample_id"] for s in f["samples"]]
        if len(sids) != len(set(sids)):
            raise EmitterError(f"sample_id 帧内重复（帧 {f['frame_id']}）")
        total += len(sids)
        slots = [c["slot_id"] for c in f["prompt"]["characters"]]
        if len(slots) != len(set(slots)):
            raise EmitterError(f"slot_id 帧内重复（帧 {f['frame_id']}）")
        casts = [c["cast_id"] for c in f["prompt"]["characters"] if c.get("cast_id")]
        if len(casts) != len(set(casts)):
            raise EmitterError(f"cast_id 帧内重复（帧 {f['frame_id']}）")
    if job["limits"]["max_images"] != total:
        raise EmitterError(f"limits.max_images({job['limits']['max_images']}) != 总张数({total})")


def _git_rev() -> str:
    try:
        import subprocess
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=PROJECT_ROOT,
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


# ---------------------------------------------------------------- submit

@dataclass(frozen=True)
class JobReceipt:
    job_id: str
    status: str
    replayed: bool
    queue_position: int | None
    estimated_anlas: int | None
    raw: dict = field(repr=False, default_factory=dict)


def _read_token() -> str:
    try:
        return TOKEN_PATH.read_text("utf-8").strip()
    except OSError as e:
        raise EmitterError(f"读不到终端 token（{TOKEN_PATH}）：终端 worker 未启动过？ {e}") from e


def submit(job: Mapping[str, Any], base_url: str | None = None, timeout: float = 30.0) -> JobReceipt:
    """POST /v1/jobs。202=接受 200=幂等重放 409/422=拒单（原文抛出）。投递即返回，不等图。"""
    validate_job(job)
    url = (base_url or DEFAULT_TERMINAL_URL).rstrip("/") + "/v1/jobs"
    body = json.dumps(job, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + _read_token(),
        "Idempotency-Key": job["idempotency_key"],
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            code = resp.status
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:2000]
        raise EmitterError(f"终端拒单 HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise EmitterError(f"连不上终端 {url}（worker 没跑？）: {e}") from e
    return JobReceipt(
        job_id=data.get("job_id", job["job_id"]),
        status=data.get("status", "accepted"),
        replayed=bool(data.get("replayed", code == 200)),
        queue_position=data.get("queue_position"),
        estimated_anlas=data.get("estimated_anlas"),
        raw=data,
    )


def build_and_submit(**kwargs) -> JobReceipt:
    return submit(build_job(**kwargs))


# ---------------------------------------------------------------- CLI（只做校验/哈希调试，不提供手写工单投递捷径）

def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="RenderJob v1 校验/调试工具（投递必须走库函数，CLI 不收工单文件直投）")
    ap.add_argument("--validate", metavar="JOB_JSON", help="校验工单文件（结构+语义+幂等键）")
    ap.add_argument("--hash", metavar="JOB_JSON", help="打印工单 canonical 幂等键")
    a = ap.parse_args(argv)
    if a.validate:
        job = json.loads(Path(a.validate).read_text("utf-8"))
        validate_job(job)
        print(f"OK {job['job_id']} frames={len(job['frames'])} images={job['limits']['max_images']}")
        return 0
    if a.hash:
        job = json.loads(Path(a.hash).read_text("utf-8"))
        print(compute_idempotency_key(job))
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except EmitterError as e:
        print(f"✗ {e}", file=sys.stderr)
        sys.exit(1)

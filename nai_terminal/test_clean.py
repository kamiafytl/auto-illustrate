#!/usr/bin/env python3
"""NAI 出图终端 · 期二 2d clean 去 meta 测试（SPEC §十二 2d，实跑）。

覆盖：
  C1 App Clean=开（legacy 工单 clean=false）端到端：
     mock 出图产物带 tEXt 文本块 + alpha LSB stealth 隐写；
     公开侧图无文本块 meta、alpha 隐写复检干净；保密归档路径有原版且字节一致；
     artifacts sha256=clean 版（≠原版）；event 有 CLEAN_APPLIED；
     echo/GET 响应无 meta_archive 归档路径泄露。
  C2 App Clean=关（legacy 工单 clean=true）：公开侧原版直落、无归档、无 CLEAN_APPLIED。
  C3 bridge legacy clean 字段仍可序列化（终端不再用它决定 Clean）。
  C4 五个公开 runner 入口遇到旧 --clean 均明确拒绝并指向 App 设置。

独立 --data-dir（临时目录）+ 随机空闲端口，mock submit_nai.submit_request，
全程不碰 data/terminal/ 生产库、不向 NAI 发请求。

跑法：python3 -m nai_terminal.test_clean
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import sys
from unittest import mock
from pathlib import Path

import nai_terminal  # noqa: F401  （导入即把 tools/ 加入 sys.path）
from nai_terminal import adapter as adapterm
from nai_terminal import db as dbm
from nai_terminal import test_integration as TI
from nai_terminal import worker as wk
import job_emitter as JE
import submit_nai
import strip_image_meta as SIM
import terminal_bridge as TB
from PIL import Image
from PIL.PngImagePlugin import PngInfo

_PASS, _FAIL = [], []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (_PASS if cond else _FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' — ' + extra) if extra else ''}")
    return cond


# ------------------------------------------------------------------ 造带 meta+alpha 隐写的假 PNG

def _make_meta_png(w: int = 64, h: int = 64) -> bytes:
    """RGBA PNG：tEXt 文本块（NAI 风格 Comment/Software）+ alpha 通道 LSB 按列写入 stealth magic。
    模拟真实 NAI 出图产物（两份 meta）。strip 逻辑复检要能把两份都灭掉。"""
    img = Image.new("RGBA", (w, h), (120, 130, 140, 255))
    px = img.load()
    payload = b"stealth_pngcomp" + b"\x1f\x8b\x08\x00SECRET"   # magic + 假 gzip 头 + 标记
    bits = []
    for byte in payload:
        for i in range(8):
            bits.append((byte >> (7 - i)) & 1)                # MSB 优先（镜像 has_alpha_stealth 组装）
    idx = 0
    for x in range(w):                                         # 按列优先（stealth 规范）
        for y in range(h):
            r, g, b, a = px[x, y]
            if idx < len(bits):
                a = (a & ~1) | bits[idx]                       # 只动 alpha LSB（255→254/255，仍不透明）
                idx += 1
            px[x, y] = (r, g, b, a)
    meta = PngInfo()
    meta.add_text("Comment", json.dumps({"prompt": "SECRET_PROMPT_LEAK", "seed": 42}))
    meta.add_text("Software", "NovelAI")
    buf = io.BytesIO()
    img.save(buf, format="PNG", pnginfo=meta)
    return buf.getvalue()


_META_PNG = _make_meta_png()


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _install_meta_submit(png_bytes: bytes, observed_outputs: list[Path] | None = None):
    """mock submit_request：把带 meta+隐写的假 PNG 写到落图路径（worker 之后再 clean）。"""
    orig = getattr(submit_nai, "submit_request", None)

    def fake(payload, cfg, *, augment=False, aug_preset=None, enable_extra=None,
             global_layer=True, char_layers=False, opener=None, dry_run=False, log=print):
        outdir = Path(payload["output"])
        if observed_outputs is not None:
            observed_outputs.append(outdir.resolve())
        outdir.mkdir(parents=True, exist_ok=True)
        p = outdir / f"{payload['prefix']}_seed{payload['seed']}.png"
        p.write_bytes(png_bytes)
        return {"saved": [str(p)], "request": None}

    submit_nai.submit_request = fake

    def uninstall():
        if orig is None:
            with contextlib.suppress(AttributeError):
                del submit_nai.submit_request
        else:
            submit_nai.submit_request = orig
    return uninstall


def _build_clean_job(clean: bool, rel: str, seed: int = 12345):
    """无加装（null-preset）单帧单 sample 工单，clean 可控。"""
    frame = JE.RenderFrame(
        frame_id="f01", output_name="shot01",
        base_positive="1girl", base_negative="lowres",
        characters=[JE.CharacterPrompt(slot_id="char_0", caption="smile", view="front_full")],
        generation=TI._gen(),
        samples=[JE.RenderSample(sample_id="s01", seed=seed)])
    return JE.build_job(
        frames=[frame],
        augmentation=JE.AugmentationSpec(preset_id=None),
        output=JE.OutputTarget(relative_path=rel),
        limits=JE.BudgetLimits(max_images=1, max_anlas=0),
        clean=clean)


def _public_files(ctx, rel: str) -> list[Path]:
    d = (ctx.output_root / rel)
    return sorted(p for p in d.glob("*.png")) if d.is_dir() else []


def _events(ctx, job_id: str) -> list[str]:
    conn = ctx.connect()
    try:
        return [r["code"] for r in dbm.get_events(conn, job_id, limit=500)]
    finally:
        conn.close()


# ------------------------------------------------------------------ 测试

def test_c1_clean_true_e2e():
    print("\n[C1] App Clean=开：公开侧无 meta/隐写、归档存原版、artifacts=clean 版、无路径泄露")
    # 前置：确认假 PNG 确实两份 meta 都在（否则测试无意义）
    with Image.open(io.BytesIO(_META_PNG)) as im0:
        im0.load()
        check("假 PNG 原版有文本块 meta", SIM.has_text_meta(im0))
        check("假 PNG 原版有 alpha 隐写", SIM.has_alpha_stealth(im0))

    observed_outputs: list[Path] = []
    un = _install_meta_submit(_META_PNG, observed_outputs)
    try:
        with TI.harness(with_worker=True) as (client, ctx):
            ctx.terminal_config_path.parent.mkdir(parents=True, exist_ok=True)
            ctx.terminal_config_path.write_text(
                json.dumps({"clean_override": True}), encoding="utf-8")
            # legacy 工单字段故意给 False，证明实际准则是 App 开关。
            job = _build_clean_job(clean=False, rel="set_clean_on")
            check("工单 legacy clean=False", job["clean"] is False)
            code, data = client.post_job(job)
            check("POST 202", code == 202, f"got {code} {data}")
            st, detail = TI._wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
            check("最终 succeeded", st == "succeeded", f"got {st}")

            check("NAI 原图先落终端私密 staging（不是 project 公开目录）",
                  len(observed_outputs) == 1 and
                  ctx.clean_staging_root.resolve() in observed_outputs[0].parents and
                  ctx.output_root.resolve() not in observed_outputs[0].parents,
                  str(observed_outputs))
            check("完成后私密 staging 已清空",
                  not ctx.clean_staging_root.exists() or
                  not any(p.is_file() for p in ctx.clean_staging_root.rglob("*")))

            pubs = _public_files(ctx, "set_clean_on")
            check("公开侧落 1 张图", len(pubs) == 1, f"got {len(pubs)}")
            pub = pubs[0]
            pub_bytes = pub.read_bytes()
            with Image.open(pub) as imp:
                imp.load()
                check("公开侧无文本块 meta", not SIM.has_text_meta(imp))
                check("公开侧无 alpha 隐写", not SIM.has_alpha_stealth(imp))
            check("公开侧 SIM.verify 复检干净", SIM.verify(pub))
            check("公开侧 ≠ 原版字节（确已重写）", pub_bytes != _META_PNG)

            # 保密归档：原版字节一致
            archive_dir = ctx.meta_archive_dir()
            archived = sorted(archive_dir.rglob("*.png"))
            check("归档目录有 1 张原版", len(archived) == 1, f"got {len(archived)} @ {archive_dir}")
            if archived:
                check("归档原版字节 == mock 出图原版（逐字节一致）",
                      archived[0].read_bytes() == _META_PNG)

            # artifacts sha256 = clean 版（≠原版）
            arts = [a for f in detail["frames"] for a in f["artifacts"]]
            check("登记 1 artifact", len(arts) == 1, f"got {len(arts)}")
            if arts:
                check("artifact sha256 == 公开 clean 版", arts[0]["sha256"] == _sha(pub_bytes),
                      arts[0]["sha256"])
                check("artifact sha256 ≠ 原版（未登记带 meta 版）", arts[0]["sha256"] != _sha(_META_PNG))

            # event CLEAN_APPLIED
            codes = _events(ctx, job["job_id"])
            check("event 有 CLEAN_APPLIED", "CLEAN_APPLIED" in codes, str(codes))

            # echo/GET 无归档路径泄露
            _, echo = client.get(f"/v1/jobs/{job['job_id']}/echo")
            blob = json.dumps(detail, ensure_ascii=False) + json.dumps(echo, ensure_ascii=False)
            check("GET/echo 无 meta_archive 归档路径泄露",
                  str(archive_dir) not in blob and "meta_archive" not in blob and "config.json" not in blob)
    finally:
        un()


def test_c2_clean_false_passthrough():
    print("\n[C2] App Clean=关：公开侧原版直落（字节一致）、无归档、无 CLEAN_APPLIED")
    un = _install_meta_submit(_META_PNG)
    try:
        with TI.harness(with_worker=True) as (client, ctx):
            ctx.terminal_config_path.parent.mkdir(parents=True, exist_ok=True)
            ctx.terminal_config_path.write_text(
                json.dumps({"clean_override": False}), encoding="utf-8")
            # legacy 工单字段故意给 True，证明它不再控制终端。
            job = _build_clean_job(clean=True, rel="set_clean_off")
            check("工单 legacy clean=True", job["clean"] is True)
            code, data = client.post_job(job)
            check("POST 202", code == 202, f"got {code} {data}")
            st, detail = TI._wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
            check("最终 succeeded", st == "succeeded", f"got {st}")

            pubs = _public_files(ctx, "set_clean_off")
            check("公开侧落 1 张图", len(pubs) == 1, f"got {len(pubs)}")
            if pubs:
                check("公开侧 == 原版字节（clean 关：原版直落）", pubs[0].read_bytes() == _META_PNG)

            # 无归档。
            check("clean=false 未触发归档",
                  not ctx.terminal_config_path.exists() or
                  not any((ctx.data_dir / "meta_archive").rglob("*.png")))

            codes = _events(ctx, job["job_id"])
            check("event 无 CLEAN_APPLIED", "CLEAN_APPLIED" not in codes, str(codes))
    finally:
        un()


def test_c3_bridge_clean_passthrough():
    print("\n[C3] bridge legacy clean 字段仅保持 schema 序列化兼容（无执行控制权）")
    cfg = {"output_folder": "/tmp/ws_clean_c3",
           "default_params": {"model": "nai-diffusion-4-5-full", "width": 832, "height": 1216,
                              "steps": 28, "sampler": "k_euler", "scale": 5.0, "cfg_rescale": 0.1,
                              "noise_schedule": "karras", "variety_plus": False, "auto_position": True},
           "augmentation_presets": {"activeId": "p_x", "presets": []}}
    base = {"positive": "1girl", "negative": "lowres", "characters": [],
            "count": 1, "prefix": "p01", "output": "/tmp/ws_clean_c3/set1", "params": {}}

    captured: dict = {}
    orig_submit = JE.submit

    def fake_submit(job, base_url=None, timeout=30.0):
        captured.clear()
        captured.update(job)
        return JE.JobReceipt(job_id=job["job_id"], status="queued", replayed=False,
                             queue_position=1, estimated_anlas=0, raw={})

    JE.submit = fake_submit
    try:
        c1 = TB.JobCollector(cfg=cfg, clean=True)
        check("兼容 collector.clean 属性=True", c1.clean is True)
        c1.add(dict(base), augment=False)
        c1.submit()
        check("兼容字段 clean=True 可序列化", captured.get("clean") is True, str(captured.get("clean")))

        c2 = TB.JobCollector(cfg=cfg)                 # 默认 clean=False
        check("collector 默认 clean=False", c2.clean is False)
        c2.add(dict(base), augment=False)
        c2.submit()
        check("默认 → 工单 clean=False", captured.get("clean") is False, str(captured.get("clean")))
    finally:
        JE.submit = orig_submit


def test_c4_clean_cli_rejected_everywhere():
    print("\n[C4] 旧 --clean 在全部公开 runner 入口明确拒绝，并指向终端 App 设置")
    import draw as DRAW
    import run_comp_draw as COMP
    import run_db_draw as DB
    import run_nai_scenario as SCEN
    import run_shots_draw as SHOTS
    cases = (
        ("draw", DRAW, ["draw.py", "fixture", "--clean"]),
        ("set", DB, ["run_db_draw.py", "fixture", "--clean"]),
        ("shot", SHOTS, ["run_shots_draw.py", "--clean"]),
        ("comp", COMP, ["run_comp_draw.py", "fixture", "--clean"]),
        ("scenario", SCEN, ["run_nai_scenario.py", "fixture", "--clean"]),
    )
    original = sys.argv[:]
    for label, module, argv in cases:
        message = ""
        sys.argv = argv
        try:
            module.main()
        except SystemExit as exc:
            message = str(exc)
        finally:
            sys.argv = original
        check(f"{label} 拒绝 --clean 并提示 App 设置",
              "--clean 已废止" in message and "终端“设置”页" in message, message)


def _run_fail_closed_case(kind: str):
    """注入一个 Clean 管线故障，断言公开侧没有原版、临时文件或 artifact。"""
    observed_outputs: list[Path] = []
    un = _install_meta_submit(_META_PNG, observed_outputs)
    try:
        with TI.harness(with_worker=True) as (client, ctx):
            ctx.terminal_config_path.parent.mkdir(parents=True, exist_ok=True)
            ctx.terminal_config_path.write_text(
                json.dumps({"clean_override": True}), encoding="utf-8")
            job = _build_clean_job(clean=False, rel=f"set_fail_{kind}")

            if kind == "archive_copy":
                patcher = mock.patch.object(
                    wk.shutil, "copy2", side_effect=OSError("injected archive copy failure"))
            elif kind == "strip":
                patcher = mock.patch.object(
                    SIM, "strip_one", side_effect=OSError("injected strip failure"))
            elif kind == "verify":
                patcher = mock.patch.object(SIM, "verify", return_value=False)
            elif kind == "publish_copy":
                real_copy2 = wk.shutil.copy2

                def fail_public_copy(src, dst, *args, **kwargs):
                    target = Path(dst).resolve()
                    if target == ctx.output_root.resolve() or ctx.output_root.resolve() in target.parents:
                        raise OSError("injected public publish copy failure")
                    return real_copy2(src, dst, *args, **kwargs)

                patcher = mock.patch.object(wk.shutil, "copy2", side_effect=fail_public_copy)
            else:  # pragma: no cover - 测试调用方固定枚举
                raise AssertionError(kind)

            with patcher:
                code, data = client.post_job(job)
                check(f"{kind}: POST 202", code == 202, f"got {code} {data}")
                st, detail = TI._wait_status(
                    client, job["job_id"], {"succeeded", "partial", "failed"})

            check(f"{kind}: 管线失败则 sample/job failed", st == "failed", f"got {st}")
            public_dir = ctx.output_root / f"set_fail_{kind}"
            public_files = ([p for p in public_dir.rglob("*") if p.is_file()]
                            if public_dir.exists() else [])
            check(f"{kind}: project 公开目录无原版/临时残留",
                  public_files == [], str(public_files))
            arts = [a for frame in detail.get("frames", []) for a in frame.get("artifacts", [])]
            check(f"{kind}: 未登记任何公开 artifact", arts == [], str(arts))
            check(f"{kind}: 私密 staging 已清空",
                  not ctx.clean_staging_root.exists() or
                  not any(p.is_file() for p in ctx.clean_staging_root.rglob("*")))

            _, echo = client.get(f"/v1/jobs/{job['job_id']}/echo")
            blob = json.dumps(detail, ensure_ascii=False) + json.dumps(echo, ensure_ascii=False)
            check(f"{kind}: HTTP 无 staging/归档路径泄露",
                  str(ctx.clean_staging_root) not in blob and
                  str(ctx.meta_archive_dir()) not in blob and
                  "clean_staging" not in blob and "meta_archive" not in blob)
    finally:
        un()


def test_c5_clean_fail_closed():
    print("\n[C5] Clean fail-closed：归档复制/清理/复检/发布复制任一步失败都不公开原版")
    for kind in ("archive_copy", "strip", "verify", "publish_copy"):
        _run_fail_closed_case(kind)


def test_c6_private_paths_fail_closed_and_redacted():
    print("\n[C6] 私密路径边界：归档不得落公开根，staging 路径不得出现在公开控制台")
    observed_outputs: list[Path] = []
    un = _install_meta_submit(_META_PNG, observed_outputs)
    try:
        with TI.harness(with_worker=True) as (client, ctx):
            unsafe_archive = ctx.output_root / "unsafe_meta_archive"
            ctx.terminal_config_path.parent.mkdir(parents=True, exist_ok=True)
            ctx.terminal_config_path.write_text(json.dumps({
                "clean_override": True,
                "meta_archive_dir": str(unsafe_archive),
            }), encoding="utf-8")
            job = _build_clean_job(clean=False, rel="set_unsafe_archive")
            code, data = client.post_job(job)
            check("公开根内归档配置：POST 202", code == 202, f"got {code} {data}")
            st, detail = TI._wait_status(
                client, job["job_id"], {"succeeded", "partial", "failed"})
            check("公开根内归档配置：fail-closed", st == "failed", f"got {st}")
            check("公开根内归档配置：未调用 NAI/未落原版", observed_outputs == [],
                  str(observed_outputs))
            check("公开根内归档配置：公开根无任何文件",
                  not any(p.is_file() for p in ctx.output_root.rglob("*")))
            blob = json.dumps(detail, ensure_ascii=False)
            check("公开根内归档配置：HTTP 不回显私密目录",
                  str(unsafe_archive) not in blob and "unsafe_meta_archive" not in blob)

            public_logs: list[str] = []
            logger = adapterm._public_submit_logger(ctx, public_logs.append)
            secret_line = f"输出: {ctx.clean_staging_root / 'secret_raw.png'}"
            logger(secret_line)
            joined = "\n".join(public_logs)
            check("公开控制台以占位隐藏 staging 路径",
                  "<private-staging>" in joined and
                  str(ctx.clean_staging_root) not in joined, joined)
    finally:
        un()


def main():
    tests = [test_c1_clean_true_e2e, test_c2_clean_false_passthrough,
             test_c3_bridge_clean_passthrough, test_c4_clean_cli_rejected_everywhere,
             test_c5_clean_fail_closed, test_c6_private_paths_fail_closed_and_redacted]
    for t in tests:
        try:
            t()
        except Exception as e:
            import traceback
            _FAIL.append(t.__name__ + " (EXC)")
            print(f"  [FAIL] {t.__name__} 抛异常: {e}")
            traceback.print_exc()
    print(f"\n==== 期二 2d clean 合计 PASS={len(_PASS)} FAIL={len(_FAIL)} ====")
    if _FAIL:
        print("失败项:", _FAIL)
    return 1 if _FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

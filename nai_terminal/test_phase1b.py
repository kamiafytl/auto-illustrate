#!/usr/bin/env python3
"""NAI 出图终端 · 期一B 集成/单元测试（SPEC §十一 B.8，实跑）。

覆盖：
  1. null-preset（无加装）工单端到端（mock NAI）：202 / est=0 / succeeded；
     且 adapter 传给 submit_request 的 augment=False、aug_preset=None（=期一A 越权加装 bug 已修）。
  2. 向后兼容：v1 字符串 preset 工单仍 202，adapter augment=True/aug_preset=<id>。
  3. null-preset + extras 非空 → 拒（build 端 EmitterError + server 端 422）。
  4. bridge 无损搬运顶层 char_reference；只拒绝 params._char_reference 内部展开形状。
  5. bridge 无 --augment 不被加装：augment=False→工单 preset_id=null（不兜底 activeId）；
     augment=True 且未给 preset→兜底 activeId。
  6. scenario 只走 collector：收集帧数 == 剧本帧数；--legacy-direct 明确拒绝。

独立 --data-dir（临时目录）+ 随机空闲端口（harness port=0），mock submit_nai.submit_request，
全程不碰 data/terminal/ 生产库、不向 NAI 发请求。

跑法：python3 -m nai_terminal.test_phase1b
"""

from __future__ import annotations

import base64
import contextlib
import json
import sys
from pathlib import Path

import nai_terminal  # noqa: F401  （导入即把 tools/ 加入 sys.path）
from nai_terminal import db as dbm
import job_emitter as JE
import submit_nai
import terminal_bridge as TB

from nai_terminal import test_integration as TI

_PASS, _FAIL = [], []


def check(name: str, cond: bool, extra: str = "") -> bool:
    (_PASS if cond else _FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{(' — ' + extra) if extra else ''}")
    return cond


# ------------------------------------------------------------------ 记录型假提交（捕获 submit_request kwargs）

def _install_recording_submit(calls: list):
    orig = getattr(submit_nai, "submit_request", None)

    def fake(payload, cfg, *, augment=False, aug_preset=None, enable_extra=None,
             global_layer=True, char_layers=False, opener=None, dry_run=False, log=print):
        calls.append({"augment": augment, "aug_preset": aug_preset,
                      "enable_extra": enable_extra, "global_layer": global_layer,
                      "char_layers": char_layers})
        outdir = Path(payload["output"])
        outdir.mkdir(parents=True, exist_ok=True)
        p = outdir / f"{payload['prefix']}_seed{payload['seed']}.png"
        p.write_bytes(TI._PNG)
        return {"saved": [str(p)], "request": None}

    submit_nai.submit_request = fake

    def uninstall():
        if orig is None:
            with contextlib.suppress(AttributeError):
                del submit_nai.submit_request
        else:
            submit_nai.submit_request = orig
    return uninstall


def _build_null_job(rel="set_null", n_samples=2, extras=()):
    """无加装（preset_id=None）工单。"""
    frame = JE.RenderFrame(
        frame_id="f01", output_name="shot01",
        base_positive="1girl, masterpiece", base_negative="lowres",
        characters=[JE.CharacterPrompt(slot_id="char_0", caption="smile", view="front_full")],
        generation=TI._gen(),
        samples=JE.make_samples(n_samples, prefix="s"))
    return JE.build_job(
        frames=[frame],
        augmentation=JE.AugmentationSpec(preset_id=None, extras=list(extras)),
        output=JE.OutputTarget(relative_path=rel),
        limits=JE.BudgetLimits(max_images=n_samples, max_anlas=0))


# ------------------------------------------------------------------ 测试

def test_b1_null_preset_e2e():
    print("\n[B1] null-preset 无加装工单端到端（202/est0/succeeded + adapter augment=False）")
    calls = []
    un = _install_recording_submit(calls)
    try:
        with TI.harness(with_worker=True) as (client, ctx):
            job = _build_null_job(n_samples=2)
            check("工单 preset_id 为 null", job["augmentation"]["preset_id"] is None)
            code, data = client.post_job(job)
            check("POST 202", code == 202, f"got {code} {data}")
            check("est_anlas=0（无加装无参考）", data.get("estimated_anlas") == 0, str(data.get("estimated_anlas")))
            st, detail = TI._wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
            check("最终 succeeded", st == "succeeded", f"got {st}")
            arts = [a for f in detail["frames"] for a in f["artifacts"]]
            check("登记 2 artifacts", len(arts) == 2, f"got {len(arts)}")
            check("adapter 传 augment=False", all(c["augment"] is False for c in calls), str(calls))
            check("adapter 传 aug_preset=None", all(c["aug_preset"] is None for c in calls), str(calls))
            # echo：无 __PRIVATE_PRESET__ 占位、preset.id 为 null、不崩
            code2, echo = client.get(f"/v1/jobs/{job['job_id']}/echo")
            check("echo 200 不崩", code2 == 200, f"got {code2}")
            check("echo 无 __PRIVATE_PRESET__ 占位", "__PRIVATE_PRESET__" not in echo["injection_placeholders"])
            check("echo preset.id=null", echo["preset"]["id"] is None, str(echo["preset"]))
    finally:
        un()


def test_b2_backward_compat_string_preset():
    print("\n[B2] 向后兼容：字符串 preset 工单仍过 + adapter augment=True/aug_preset=<id>")
    calls = []
    un = _install_recording_submit(calls)
    try:
        with TI.harness(with_worker=True) as (client, ctx):
            job = TI._build_text_job(preset_id="p_test", rel="set_compat", n_samples=1)
            code, data = client.post_job(job)
            check("字符串 preset 202", code == 202, f"got {code} {data}")
            st, _ = TI._wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
            check("succeeded", st == "succeeded", f"got {st}")
            check("adapter augment=True", all(c["augment"] is True for c in calls), str(calls))
            check("adapter aug_preset='p_test'", all(c["aug_preset"] == "p_test" for c in calls), str(calls))
    finally:
        un()


def test_b3_null_plus_extras_rejected():
    print("\n[B3] null-preset + extras 非空 → build EmitterError + server 422")
    # (a) 构造端：build_job 直接拒
    raised = False
    try:
        _build_null_job(rel="set_nx", extras=["eb_x"])
    except JE.EmitterError:
        raised = True
    check("build_job(null+extras) 抛 EmitterError", raised)

    # (b) server 端：手工造工单绕过 builder → POST → 422
    un = TI._install_fake_submit()
    try:
        with TI.harness(with_worker=False) as (client, ctx):
            job = _build_null_job(rel="set_nx2")           # 合法 null 工单
            job["augmentation"]["extras"] = ["eb_x"]        # 手工塞 extras（破坏契约）
            job["idempotency_key"] = JE.compute_idempotency_key(job)  # 回填幂等键使头体一致
            code, data = client.post_job(job)
            check("server 拒 null+extras → 422", code == 422, f"got {code} {data}")
    finally:
        un()


def test_b4_bridge_char_reference_contract():
    print("\n[B4] bridge 搬运顶层角色参考，拒绝内部展开形状")
    cfg = {"output_folder": "/tmp/ws_b4",
           "default_params": {"model": "nai-diffusion-4-5-full", "width": 832, "height": 1216,
                              "steps": 28, "sampler": "k_euler", "scale": 5.0, "cfg_rescale": 0.1,
                              "noise_schedule": "karras", "variety_plus": False,
                              "auto_position": True},
           "augmentation_presets": {"activeId": "p_x", "presets": []}}
    base = {"positive": "1girl", "negative": "lowres", "characters": [],
            "count": 1, "prefix": "p01", "output": "/tmp/ws_b4/set1", "params": {}}

    c = TB.JobCollector(cfg=cfg)
    c.add({**base, "char_reference": {"image_b64": "AA", "strength": 0.7,
                                      "fidelity": 0.8, "base_caption": "style"}},
          augment=False)
    cr = c.frames[0].char_reference
    check("顶层 char_reference 进入 RenderFrame", cr is not None)
    check("base_caption 别名归一为 mode", cr is not None and cr.mode == "style")
    check("显式参考计入 paid 预算", c._paid is True)

    c2 = TB.JobCollector(cfg=cfg)
    r2 = False
    try:
        c2.add({**base, "params": {"_char_reference": {"director_reference_images": ["x"]}}}, augment=False)
    except TB.TranslationError:
        r2 = True
    check("params._char_reference → TranslationError", r2)


def test_b5_bridge_no_augment_not_activated():
    print("\n[B5] bridge 无 augment 不兜底 activeId（bug 修复核心）")
    cfg = {"output_folder": "/tmp/ws_b5",
           "default_params": {"model": "nai-diffusion-4-5-full", "width": 832, "height": 1216,
                              "steps": 28, "sampler": "k_euler", "scale": 5.0, "cfg_rescale": 0.1,
                              "noise_schedule": "karras", "variety_plus": False, "auto_position": True},
           "augmentation_presets": {"activeId": "p_active", "presets": []}}
    base = {"positive": "1girl", "negative": "lowres", "characters": [],
            "count": 1, "prefix": "p01", "output": "/tmp/ws_b5/set1", "params": {}}

    # augment=False → preset_id 必须为 None（旧 bug 会兜底成 p_active）
    c = TB.JobCollector(cfg=cfg)
    c.add(dict(base), augment=False)
    check("augment=False → collector preset_id=None（不被加装）", c._preset_id is None, str(c._preset_id))
    check("augment=False → extras 空", c._extras == [], str(c._extras))

    # augment=True 且未给 aug_preset → 兜底 activeId
    c2 = TB.JobCollector(cfg=cfg)
    c2.add(dict(base), augment=True, aug_preset=None)
    check("augment=True 未给 preset → 兜底 activeId", c2._preset_id == "p_active", str(c2._preset_id))

    # augment=False 且给 enable_extra → 拒（无加装不得带 extra）
    c3 = TB.JobCollector(cfg=cfg)
    r = False
    try:
        c3.add(dict(base), augment=False, enable_extra=["eb_x"])
    except TB.TranslationError:
        r = True
    check("augment=False + enable_extra → TranslationError", r)


def _run_scenario_collect(scen_id: str, extra_argv: list) -> list:
    """在进程内跑 run_nai_scenario.main()，用假 collector 记录。"""
    import run_nai_scenario as SCEN
    collected: list = []

    class FakeCollector:
        def __init__(self, **kw):
            self.frames = collected

        def add(self, payload, *, augment, aug_preset=None, enable_extra=None):
            collected.append((payload.get("prefix"), augment))

    orig_JC = TB.JobCollector
    orig_sc = TB.submit_collected
    orig_argv = sys.argv[:]
    TB.JobCollector = FakeCollector
    TB.submit_collected = lambda c, **k: None
    sys.argv = ["run_nai_scenario.py", scen_id, "--submit"] + extra_argv
    try:
        SCEN.main()
    finally:
        TB.JobCollector = orig_JC
        TB.submit_collected = orig_sc
        sys.argv = orig_argv
    return collected


def test_b6_scenario_terminal_only():
    print("\n[B6] scenario 只能→collector（帧数正确）；旧直连 flag 被拒")
    scen_id = "guangduili-baipo-14"
    expected = 14
    # 默认（终端路径）：--outdir 给子目录使 run_dir 非 None
    collected = _run_scenario_collect(scen_id, ["--outdir", "output/_b6_term"])
    check("默认路径收集帧数==14", len(collected) == expected, f"got {len(collected)}")
    check("scenario 无 augment → 全部 augment=False", all(a is False for _, a in collected), str(collected[:2]))

    rejected = False
    try:
        _run_scenario_collect(scen_id, ["--legacy-direct", "--outdir", "output/_b6_legacy"])
    except SystemExit as e:
        rejected = "--legacy-direct 已废止" in str(e)
    check("--legacy-direct 明确拒绝", rejected)


def main():
    tests = [test_b1_null_preset_e2e, test_b2_backward_compat_string_preset,
             test_b3_null_plus_extras_rejected, test_b4_bridge_char_reference_contract,
             test_b5_bridge_no_augment_not_activated, test_b6_scenario_terminal_only]
    for t in tests:
        try:
            t()
        except Exception as e:
            import traceback
            _FAIL.append(t.__name__ + " (EXC)")
            print(f"  [FAIL] {t.__name__} 抛异常: {e}")
            traceback.print_exc()
    print(f"\n==== 期一B 合计 PASS={len(_PASS)} FAIL={len(_FAIL)} ====")
    if _FAIL:
        print("失败项:", _FAIL)
    return 1 if _FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

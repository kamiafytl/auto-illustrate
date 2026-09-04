#!/usr/bin/env python3
"""NAI 出图终端 · 期一 集成测试（SPEC §十 的 8 条，实跑）。

真 HTTP（随机空闲端口）+ 真 SQLite（临时目录）跑全链；mock 掉对 NAI 的实际提交
（submit_nai.submit_request 换成写假 PNG 的桩），全程不向 api.novelai.net 发任何请求。
config 路径注入临时假 config（含 augmentation_presets 公开壳）。

跑法：python3 -m nai_terminal.test_integration    （或 pytest 亦可，函数以 test_ 开头）
"""

from __future__ import annotations

import base64
import contextlib
import json
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# 确保 tools/ 与包可 import（导入包即把 tools 加入 sys.path）
import nai_terminal  # noqa: F401
from nai_terminal import db as dbm
from nai_terminal import server as srv
from nai_terminal import worker as wk
import job_emitter as JE
import submit_nai  # 用于注入 submit_request 桩

# 1x1 PNG（size>0 即可通过落图核对；内容真伪不影响队列内核测试）
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")

_PASS, _FAIL = [], []


def check(name: str, cond: bool, extra: str = ""):
    (_PASS if cond else _FAIL).append(name)
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {name}{(' — ' + extra) if extra else ''}")
    if not cond and extra:
        pass
    return cond


# ------------------------------------------------------------------ 桩：假提交

def _install_fake_submit(saved_out_dir_guard=None):
    """把 submit_nai.submit_request 换成写假 PNG 的桩（不碰 NAI）。返回卸载函数。"""
    orig = getattr(submit_nai, "submit_request", None)

    def fake_submit_request(payload, cfg, *, augment=False, aug_preset=None,
                            enable_extra=None, global_layer=True, char_layers=False,
                            opener=None, dry_run=False, log=print):
        outdir = Path(payload["output"])
        outdir.mkdir(parents=True, exist_ok=True)
        p = outdir / f"{payload['prefix']}_seed{payload['seed']}.png"
        p.write_bytes(_PNG)
        return {"saved": [str(p)], "request": None}

    submit_nai.submit_request = fake_submit_request

    def uninstall():
        if orig is None:
            with contextlib.suppress(AttributeError):
                del submit_nai.submit_request
        else:
            submit_nai.submit_request = orig
    return uninstall


# ------------------------------------------------------------------ 假 config

def _write_fake_config(out_folder: Path) -> Path:
    cfg = {
        "output_folder": str(out_folder),
        "proxy": "",
        "api_key": "TEST_FAKE_KEY",
        "default_params": {"model": "nai-diffusion-4-5-full", "width": 832, "height": 1216,
                           "steps": 28, "scale": 5.0, "negative_prompt": "lowres"},
        "batch": {},
        "augmentation_presets": {
            "activeId": "p_test",
            "presets": [
                {"id": "p_test", "name": "测试预设", "enabled": True,
                 "extra_blocks": [{"id": "eb_x", "roleLabel": "特殊效果A", "role": "other",
                                   "enabled": True, "text": "sparkle"}],
                 "chars": [], "char_references": []},
                {"id": "p_disabled", "name": "禁用预设", "enabled": False},
                {"id": "p_ref", "name": "带参考预设", "enabled": True,
                 "char_references": [{"id": "cr_1", "enabled": True, "isPrivate": True}]},
            ],
        },
        "character_layers": {"layers": []},
    }
    fd = out_folder.parent / "fake_nai_config.json"
    fd.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    return fd


# ------------------------------------------------------------------ 工单构造

def _gen(model="nai-diffusion-4-5-full"):
    return JE.GenerationSpec(
        model=model, width=832, height=1216, steps=28, sampler="k_euler",
        scale=5.0, cfg_rescale=0.1, noise_schedule="karras", variety_plus=False,
        auto_position=True, quality_toggle=True, uc_preset=0)


def _build_text_job(preset_id="p_test", extras=(), rel="set_text", n_samples=2,
                    display_name=None, max_anlas=0):
    frame = JE.RenderFrame(
        frame_id="f01", output_name="shot01",
        base_positive="1girl, masterpiece", base_negative="lowres",
        characters=[JE.CharacterPrompt(slot_id="char_0", caption="smile", x=0.5, y=0.5,
                                       view="front_full", cast_id="f1")],
        generation=_gen(),
        samples=JE.make_samples(n_samples, prefix="s"))
    return JE.build_job(
        frames=[frame],
        augmentation=JE.AugmentationSpec(preset_id=preset_id, extras=list(extras)),
        output=JE.OutputTarget(relative_path=rel),
        limits=JE.BudgetLimits(max_images=n_samples, max_anlas=max_anlas),
        display_name=display_name)


def _build_ref_job(rel="set_ref", n_samples=2, max_anlas=5):
    b64 = base64.b64encode(_PNG).decode("ascii")
    frame = JE.RenderFrame(
        frame_id="f01", output_name="shot01",
        base_positive="1girl", base_negative="lowres",
        characters=[JE.CharacterPrompt(slot_id="char_0", caption="smile", view="front_full")],
        generation=_gen(),
        samples=JE.make_samples(n_samples, prefix="s"),
        char_reference=JE.CharReference(image_b64=b64, strength=1.0, fidelity=1.0, mode="character"))
    return JE.build_job(
        frames=[frame],
        augmentation=JE.AugmentationSpec(preset_id="p_ref"),
        output=JE.OutputTarget(relative_path=rel),
        limits=JE.BudgetLimits(max_images=n_samples, max_anlas=max_anlas))


# ------------------------------------------------------------------ HTTP 客户端 + harness

class Client:
    def __init__(self, base_url, token):
        self.base = base_url
        self.token = token

    def _req(self, method, path, body=None, headers=None):
        url = self.base + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        h = {"Authorization": "Bearer " + self.token,
             "Host": self.base.split("//", 1)[1]}
        if data is not None:
            h["Content-Type"] = "application/json"
        if headers:
            h.update(headers)
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def post_job(self, job, idem_key=None):
        return self._req("POST", "/v1/jobs", job,
                         {"Idempotency-Key": idem_key or job["idempotency_key"]})

    def get(self, path):
        return self._req("GET", path)

    def post(self, path, body=None):
        return self._req("POST", path, body)


@contextlib.contextmanager
def harness(with_worker: bool):
    root = Path(tempfile.mkdtemp(prefix="nai_term_test_"))
    out_folder = root / "workspace"
    out_folder.mkdir(parents=True, exist_ok=True)
    data_dir = root / "terminal"
    cfg_path = _write_fake_config(out_folder)
    ctx = dbm.load_context(str(cfg_path), str(data_dir))
    httpd = srv.make_server(ctx, port=0)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    worker = None
    if with_worker:
        worker = wk.Worker(ctx, poll_interval=0.05)
        worker.start()
    client = Client(f"http://127.0.0.1:{port}", httpd.token)
    try:
        yield client, ctx
    finally:
        if worker:
            worker.stop()
            worker.join(timeout=5)
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(root, ignore_errors=True)


def _wait_status(client, job_id, want, timeout=15):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        code, data = client.get(f"/v1/jobs/{job_id}")
        last = data.get("status")
        if last in want:
            return last, data
        time.sleep(0.05)
    return last, data


# ------------------------------------------------------------------ 8 条测试

def test_1_deliver_run_succeeded():
    print("\n[1] 投递→202→worker 跑完→artifacts/succeeded/GET 正确")
    un = _install_fake_submit()
    try:
        with harness(with_worker=True) as (client, ctx):
            job = _build_text_job(n_samples=2)
            code, data = client.post_job(job)
            check("POST 返回 202", code == 202, f"got {code} {data}")
            check("响应含 estimated_images=2", data.get("estimated_images") == 2)
            check("纯文生图 estimated_anlas=0", data.get("estimated_anlas") == 0)
            st, detail = _wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
            check("job 最终 succeeded", st == "succeeded", f"got {st}")
            arts = [a for f in detail["frames"] for a in f["artifacts"]]
            check("登记 2 个 artifacts", len(arts) == 2, f"got {len(arts)}")
            check("artifact 有 sha256+bytes", all(a["sha256"] and a["bytes"] > 0 for a in arts))
            smps = [s for f in detail["frames"] for s in f["samples"]]
            check("2 个 sample 全 succeeded", all(s["status"] == "succeeded" for s in smps))
    finally:
        un()


def test_2_replay_and_conflict():
    print("\n[2] 同工单重投→200 replayed 不重跑；同 key 改 body→409")
    un = _install_fake_submit()
    try:
        with harness(with_worker=False) as (client, ctx):
            job = _build_text_job(rel="set_replay")
            code, _ = client.post_job(job)
            check("首投 202", code == 202, f"got {code}")
            code2, data2 = client.post_job(job)
            check("重投 200", code2 == 200, f"got {code2}")
            check("replayed=true", data2.get("replayed") is True)
            # 同 key 改 body（display_name 改、idempotency_key 头/体保持旧值）
            job2 = json.loads(json.dumps(job))
            job2["display_name"] = job["display_name"] + "_MUT"
            code3, data3 = client.post_job(job2, idem_key=job["idempotency_key"])
            check("同 key 异 body → 409", code3 == 409, f"got {code3} {data3}")
            check("错误码 IDEMPOTENCY_CONFLICT", data3.get("error") == "IDEMPOTENCY_CONFLICT")
    finally:
        un()


def test_3_bad_schema_and_fake_preset():
    print("\n[3] 坏 schema→422；假/禁用 preset_id→422 不回落")
    un = _install_fake_submit()
    try:
        with harness(with_worker=False) as (client, ctx):
            job = _build_text_job(rel="set_bad")
            bad = json.loads(json.dumps(job))
            bad["frames"][0]["bogus_field"] = 1  # additionalProperties:false
            code, data = client.post_job(bad, idem_key=job["idempotency_key"])
            check("未知字段 → 422", code == 422, f"got {code} {data}")
            # 假 preset
            jfake = _build_text_job(preset_id="p_nonexistent", rel="set_fp")
            code2, data2 = client.post_job(jfake)
            check("不存在 preset → 422", code2 == 422, f"got {code2}")
            check("错误码 PRESET_INVALID", data2.get("error") == "PRESET_INVALID", str(data2))
            # 禁用 preset
            jdis = _build_text_job(preset_id="p_disabled", rel="set_dis")
            code3, data3 = client.post_job(jdis)
            check("禁用 preset → 422 不回落", code3 == 422 and data3.get("error") == "PRESET_INVALID",
                  str(data3))
    finally:
        un()


def test_4_extras_exact_match():
    print("\n[4] extras 精确匹配报告 matched/not_found（禁子串）")
    un = _install_fake_submit()
    try:
        with harness(with_worker=False) as (client, ctx):
            # eb_x: id=eb_x roleLabel=特殊效果A。命中 id 与 roleLabel；子串"特殊"不得命中
            job = _build_text_job(extras=["特殊效果A", "eb_x", "特殊", "不存在Z"], rel="set_ex")
            code, data = client.post_job(job)
            check("202", code == 202, f"got {code} {data}")
            rep = data.get("extras_report", {})
            matched = set(rep.get("matched", []))
            notf = set(rep.get("not_found", []))
            check("roleLabel 精确命中", "特殊效果A" in matched)
            check("id 精确命中", "eb_x" in matched)
            check("子串'特殊'不命中（禁子串）", "特殊" in notf and "特殊" not in matched)
            check("不存在项 not_found", "不存在Z" in notf)
    finally:
        un()


def test_5_budget_exceeded():
    print("\n[5] 预算：带 char_reference 估 5×N，超 max_anlas→422")
    un = _install_fake_submit()
    try:
        with harness(with_worker=False) as (client, ctx):
            # 2 sample × 5 = 10 est；max_anlas=5 → 超
            job = _build_ref_job(n_samples=2, max_anlas=5)
            code, data = client.post_job(job)
            check("超预算 → 422", code == 422, f"got {code} {data}")
            check("错误码 BUDGET_EXCEEDED", data.get("error") == "BUDGET_EXCEEDED", str(data))
            # 放宽预算 → 接受，est=10
            job_ok = _build_ref_job(n_samples=2, max_anlas=20, rel="set_ref_ok")
            code2, data2 = client.post_job(job_ok)
            check("放宽后 202", code2 == 202, f"got {code2}")
            check("est=10", data2.get("estimated_anlas") == 10, str(data2.get("estimated_anlas")))
    finally:
        un()


def test_6_crash_recovery():
    print("\n[6] 崩溃恢复：submitting 免费→queued；submitting 烧钱→recovery_required")
    un = _install_fake_submit()
    try:
        with harness(with_worker=False) as (client, ctx):
            free = _build_text_job(rel="set_free")            # est 0
            paid = _build_ref_job(n_samples=1, max_anlas=20, rel="set_paid")  # est 5
            client.post_job(free)
            client.post_job(paid)
            conn = ctx.connect()
            with conn:
                conn.execute("UPDATE jobs SET status='submitting' WHERE job_id=?", (free["job_id"],))
                conn.execute("UPDATE jobs SET status='submitting' WHERE job_id=?", (paid["job_id"],))
            wk.recover(conn, ctx)
            fs = dbm.get_job(conn, free["job_id"])["status"]
            ps = dbm.get_job(conn, paid["job_id"])["status"]
            conn.close()
            check("免费 submitting → queued", fs == "queued", f"got {fs}")
            check("烧钱 submitting → recovery_required", ps == "recovery_required", f"got {ps}")
    finally:
        un()


def test_7_cancel_priority_resume():
    print("\n[7] cancel/priority/resume 生效")
    un = _install_fake_submit()
    try:
        with harness(with_worker=False) as (client, ctx):
            j1 = _build_text_job(rel="set_cancel")
            client.post_job(j1)
            code, data = client.post(f"/v1/jobs/{j1['job_id']}/cancel")
            check("cancel queued → 200 cancelled", code == 200 and data.get("status") == "cancelled",
                  f"got {code} {data}")
            _, det = client.get(f"/v1/jobs/{j1['job_id']}")
            check("GET 确认 cancelled", det.get("status") == "cancelled")

            j2 = _build_text_job(rel="set_prio")
            client.post_job(j2)
            code2, data2 = client.post(f"/v1/jobs/{j2['job_id']}/priority", {"sort_key": -99.0})
            check("priority → 200 sort_key 更新", code2 == 200 and data2.get("sort_key") == -99.0,
                  f"got {code2} {data2}")

            # resume：造 recovery_required
            j3 = _build_text_job(rel="set_resume")
            client.post_job(j3)
            conn = ctx.connect()
            with conn:
                conn.execute("UPDATE jobs SET status='recovery_required' WHERE job_id=?", (j3["job_id"],))
            conn.close()
            code3, data3 = client.post(f"/v1/jobs/{j3['job_id']}/resume")
            check("resume recovery_required → 200 queued",
                  code3 == 200 and data3.get("status") == "queued", f"got {code3} {data3}")
            # 非 recovery 态 resume → 409
            code4, _ = client.post(f"/v1/jobs/{j2['job_id']}/resume")
            check("非 recovery 态 resume → 409", code4 == 409, f"got {code4}")
    finally:
        un()


def test_8_echo_no_privacy():
    print("\n[8] echo 无隐私正文；错误原文只在 private_error.log")
    un = _install_fake_submit()
    try:
        with harness(with_worker=False) as (client, ctx):
            job = _build_text_job(extras=["特殊效果A"], rel="set_echo")
            client.post_job(job)
            code, echo = client.get(f"/v1/jobs/{job['job_id']}/echo")
            check("echo 200", code == 200, f"got {code}")
            blob = json.dumps(echo, ensure_ascii=False)
            check("echo 不含参考图 b64 键", "image_b64" not in blob)
            check("含公开 base_positive", echo["frames"][0]["base_positive"] == "1girl, masterpiece")
            check("含注入占位 __PRIVATE_PRESET__", "__PRIVATE_PRESET__" in echo["injection_placeholders"])
            check("含 extra 占位", any(p.startswith("__PRIVATE_EXTRA:") for p in echo["injection_placeholders"]))
            check("preset revision 字段存在", "revision" in echo["preset"])

            # 错误原文只入 private_error.log：worker 端 sample 失败时把 raw 写私有日志
            from nai_terminal import scrub
            tid = scrub.new_trace_id()
            scrub.write_private_error(ctx.private_error_log, tid, "NAI raw error: prompt=SECRET_PRIVATE")
            summary = scrub.scrub_error(RuntimeError("SECRET_PRIVATE leak"), tid)
            check("公开摘要不含隐私原文", "SECRET_PRIVATE" not in summary and tid in summary, summary)
            log_txt = ctx.private_error_log.read_text("utf-8")
            check("私有日志含原文+trace_id", "SECRET_PRIVATE" in log_txt and tid in log_txt)
    finally:
        un()


def test_9_pause_queue_between_samples():
    print("\n[9] pause：GET 状态同步；暂停时不取新 job；恢复后继续")
    un = _install_fake_submit()
    worker = None
    try:
        with harness(with_worker=False) as (client, ctx):
            code, paused = client.post("/v1/queue/pause", {"paused": True})
            check("pause → 200 paused=true", code == 200 and paused.get("paused") is True,
                  f"got {code} {paused}")
            qcode, summary = client.get("/v1/queue")
            check("GET /queue 含 paused=true", qcode == 200 and summary.get("paused") is True)

            job = _build_text_job(rel="set_paused", n_samples=1)
            client.post_job(job)
            worker = wk.Worker(ctx, poll_interval=0.03)
            worker.start()
            time.sleep(0.15)
            _, held = client.get(f"/v1/jobs/{job['job_id']}")
            check("暂停期间 job 保持 queued", held.get("status") == "queued", str(held.get("status")))

            rcode, resumed = client.post("/v1/queue/pause", {"paused": False})
            check("resume queue → 200 paused=false",
                  rcode == 200 and resumed.get("paused") is False, f"got {rcode} {resumed}")
            status, _ = _wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
            check("恢复后 job succeeded", status == "succeeded", f"got {status}")

            conn = ctx.connect()
            try:
                codes = [r["code"] for r in conn.execute(
                    "SELECT code FROM events WHERE job_id IS NULL ORDER BY id").fetchall()]
            finally:
                conn.close()
            check("全局 event 有 QUEUE_PAUSED/QUEUE_RESUMED",
                  codes == ["QUEUE_PAUSED", "QUEUE_RESUMED"], str(codes))
            worker.stop()
            worker.join(timeout=5)
            worker = None
    finally:
        if worker:
            worker.stop()
            worker.join(timeout=5)
        un()


def test_10_clean_app_switch():
    print("\n[10] Clean：App 二态开关是实际准则，公开状态可见")
    un = _install_fake_submit()
    try:
        with harness(with_worker=True) as (client, ctx):
            ctx.terminal_config_path.parent.mkdir(parents=True, exist_ok=True)
            ctx.terminal_config_path.write_text(
                json.dumps({"clean_override": False}), encoding="utf-8")
            qcode, queue = client.get("/v1/queue")
            check("GET /queue 公开 clean_enabled=false",
                  qcode == 200 and queue.get("clean_enabled") is False,
                  f"got {qcode} {queue.get('clean_enabled')}")
            frame = JE.RenderFrame(
                frame_id="f01", output_name="shot01", base_positive="1girl",
                base_negative="lowres", characters=[], generation=_gen(),
                samples=[JE.RenderSample(sample_id="s01", seed=123)])
            job = JE.build_job(
                frames=[frame], augmentation=JE.AugmentationSpec(preset_id=None),
                output=JE.OutputTarget(relative_path="set_override"),
                limits=JE.BudgetLimits(max_images=1, max_anlas=0), clean=True)
            code, data = client.post_job(job)
            check("clean=true 工单 202", code == 202, f"got {code} {data}")
            status, _ = _wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
            check("App 关闭 Clean 后原图流程 succeeded", status == "succeeded", f"got {status}")
            conn = ctx.connect()
            try:
                codes = [r["code"] for r in dbm.get_events(conn, job["job_id"], 100)]
            finally:
                conn.close()
            check("event 有 CLEAN_MODE", "CLEAN_MODE" in codes, str(codes))
            check("App 关闭 Clean 后无 CLEAN_APPLIED", "CLEAN_APPLIED" not in codes, str(codes))

            ctx.terminal_config_path.write_text(
                json.dumps({"clean_override": True}), encoding="utf-8")
            qcode, queue = client.get("/v1/queue")
            check("GET /queue 公开 clean_enabled=true",
                  qcode == 200 and queue.get("clean_enabled") is True,
                  f"got {qcode} {queue.get('clean_enabled')}")
    finally:
        un()


def main():
    tests = [test_1_deliver_run_succeeded, test_2_replay_and_conflict,
             test_3_bad_schema_and_fake_preset, test_4_extras_exact_match,
             test_5_budget_exceeded, test_6_crash_recovery,
             test_7_cancel_priority_resume, test_8_echo_no_privacy,
             test_9_pause_queue_between_samples, test_10_clean_app_switch]
    for t in tests:
        try:
            t()
        except Exception as e:
            import traceback
            _FAIL.append(t.__name__ + " (EXC)")
            print(f"  [FAIL] {t.__name__} 抛异常: {e}")
            traceback.print_exc()
    print(f"\n==== 合计 PASS={len(_PASS)} FAIL={len(_FAIL)} ====")
    if _FAIL:
        print("失败项:", _FAIL)
    return 1 if _FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

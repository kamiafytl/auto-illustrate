from __future__ import annotations

import contextlib
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import nai_terminal  # noqa: F401 - 安装 tools/ import 路径
from nai_terminal import adapter, db as dbm, estimate, vault, worker as wk
from nai_terminal.test_integration import _build_text_job, harness
import submit_nai


class PublicConfigRefreshTests(unittest.TestCase):
    @staticmethod
    def _fake_submit(captured):
        def submit(payload, cfg, **kwargs):
            captured.append({
                "cfg": json.loads(json.dumps(cfg)),
                "global_layer": kwargs.get("global_layer"),
                "payload_output": payload["output"],
            })
            out = Path(payload["output"])
            out.mkdir(parents=True, exist_ok=True)
            image = out / f"{payload['prefix']}_seed{payload['seed']}.png"
            image.write_bytes(b"fixture-image")
            return {"saved": [str(image)], "request": None}
        return submit

    def test_new_preset_is_accepted_and_query_uses_fresh_public_shell(self):
        """server 启动后新增预设：下一单不被旧 cfg 拒绝，未绑 revision 的查询也刷新。"""
        with harness(with_worker=False) as (client, ctx):
            cfg = json.loads(ctx.config_path.read_text("utf-8"))
            cfg["augmentation_presets"]["presets"].append({
                "id": "p_after_start",
                "name": "启动后新增",
                "enabled": True,
                "chars": [],
                "extra_blocks": [],
                "char_references": [],
            })
            ctx.config_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")

            job = _build_text_job(preset_id="p_after_start", n_samples=1)
            code, body = client.post_job(job)
            self.assertEqual(code, 202, body)
            self.assertEqual(
                estimate.find_preset(ctx.cfg, "p_after_start")["name"], "启动后新增")

            # 尚未由 worker 绑定 revision；查询应拿此刻磁盘壳，而不是 server 启动快照。
            cfg["augmentation_presets"]["presets"][-1]["name"] = "启动后改名"
            ctx.config_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
            qcode, echo = client.get(f"/v1/jobs/{job['job_id']}/echo")
            self.assertEqual(qcode, 200, echo)
            self.assertEqual(echo["preset"]["name"], "启动后改名")

    def test_queued_preset_job_binds_and_submits_one_refreshed_snapshot(self):
        """排队后编辑 preset，任务开跑取新壳；开跑后的再次编辑不得换掉本 job。"""
        with harness(with_worker=False) as (client, ctx):
            job = _build_text_job(preset_id="p_test", n_samples=1)
            code, body = client.post_job(job)
            self.assertEqual(code, 202, body)

            queued_cfg = json.loads(ctx.config_path.read_text("utf-8"))
            estimate.find_preset(queued_cfg, "p_test")["name"] = "排队后版本"
            ctx.config_path.write_text(
                json.dumps(queued_cfg, ensure_ascii=False), encoding="utf-8")

            captured = []
            bound = []

            def bind_revision(shell):
                raw = json.dumps(shell, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"))
                revision = "fixture:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()
                bound.append((revision, raw))
                # 模拟任务已经绑定后，GUI 又保存一次，且 HTTP 线程并发刷新共享 Context。
                if len(bound) == 1:
                    later = json.loads(ctx.config_path.read_text("utf-8"))
                    estimate.find_preset(later, "p_test")["name"] = "运行中版本"
                    ctx.config_path.write_text(
                        json.dumps(later, ensure_ascii=False), encoding="utf-8")
                    ctx.reload_cfg()
                return revision, raw

            conn = ctx.connect()
            try:
                row = dict(dbm.get_job(conn, job["job_id"]))
                worker = wk.Worker(ctx)
                with mock.patch.object(worker, "_get_opener", return_value=None), \
                        mock.patch.object(adapter, "compute_preset_revision",
                                          side_effect=bind_revision), \
                        mock.patch.object(submit_nai, "submit_request",
                                          side_effect=self._fake_submit(captured)):
                    worker.process_job(conn, row)
                result = dbm.get_job(conn, job["job_id"])
            finally:
                conn.close()

            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["preset_revision"], bound[0][0])
            submitted = estimate.find_preset(captured[0]["cfg"], "p_test")
            self.assertEqual(submitted["name"], "排队后版本")
            self.assertEqual(estimate.find_preset(ctx.cfg, "p_test")["name"], "运行中版本")

    def test_queued_null_global_job_uses_start_snapshot_after_concurrent_reload(self):
        """无 preset 的全局层也必须在开跑刷新，且不受之后的共享 ctx.cfg 替换。"""
        with harness(with_worker=False) as (client, ctx):
            job = _build_text_job(preset_id=None, n_samples=1)
            code, body = client.post_job(job)
            self.assertEqual(code, 202, body)

            queued_cfg = json.loads(ctx.config_path.read_text("utf-8"))
            queued_cfg["global_layer"] = {
                "enabled": True,
                "rules": [{"id": "queued-rule", "kind": "delete",
                           "scope": "all", "enabled": True}],
            }
            queued_output = ctx.data_dir.parent / "queued-output"
            queued_cfg["output_folder"] = str(queued_output)
            ctx.config_path.write_text(
                json.dumps(queued_cfg, ensure_ascii=False), encoding="utf-8")

            # Exercise the Clean path too: its private staging and final public
            # publish must retain the same output-root snapshot as submission.
            ctx.terminal_config_path.write_text(json.dumps({
                "clean_override": True,
                "meta_archive_dir": str(ctx.data_dir / "meta-archive"),
            }), encoding="utf-8")

            captured = []
            clean_roots = []

            def concurrent_reload(_cfg_snapshot=None):
                later = json.loads(ctx.config_path.read_text("utf-8"))
                later["global_layer"]["rules"][0]["id"] = "midrun-rule"
                later["output_folder"] = str(ctx.data_dir.parent / "midrun-output")
                ctx.config_path.write_text(
                    json.dumps(later, ensure_ascii=False), encoding="utf-8")
                ctx.reload_cfg()
                return None

            def publish_clean(_archive, _stage, job_value, _fid, _sid, saved, *,
                              public_root=None):
                # Real stripping/fail-closed behaviour has its own 65-check suite;
                # this fixture isolates which public root the worker hands to it.
                root = Path(public_root).resolve()
                clean_roots.append(root)
                target = adapter.resolve_output_dir(root, job_value)
                target.mkdir(parents=True, exist_ok=True)
                final = target / Path(saved[0]).name
                final.write_bytes(b"clean-fixture")
                return [str(final)]

            conn = ctx.connect()
            try:
                row = dict(dbm.get_job(conn, job["job_id"]))
                worker = wk.Worker(ctx)
                with mock.patch.object(worker, "_get_opener",
                                       side_effect=concurrent_reload), \
                        mock.patch.object(worker, "_apply_clean",
                                          side_effect=publish_clean), \
                        mock.patch.object(submit_nai, "submit_request",
                                          side_effect=self._fake_submit(captured)):
                    worker.process_job(conn, row)
                result = dbm.get_job(conn, job["job_id"])
            finally:
                conn.close()

            self.assertEqual(result["status"], "succeeded")
            self.assertTrue(captured[0]["global_layer"])
            self.assertEqual(
                captured[0]["cfg"]["global_layer"]["rules"][0]["id"],
                "queued-rule")
            self.assertEqual(ctx.cfg["global_layer"]["rules"][0]["id"], "midrun-rule")
            self.assertEqual(clean_roots, [queued_output.resolve()])
            self.assertTrue((queued_output / "set_text").is_dir())
            self.assertFalse((ctx.data_dir.parent / "midrun-output" / "set_text").exists())


class PrivatePayloadRefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir(parents=True)

    def tearDown(self):
        vault.invalidate_payload_cache(self.root)
        self.tmp.cleanup()

    @contextlib.contextmanager
    def _submit_paths(self, dek: bytes):
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(submit_nai, "PROJECT_ROOT", self.root))
            stack.enter_context(mock.patch.object(
                submit_nai, "AUGMENT_PRIVATE_PATH", self.root / "data/nai_augment_private.json"))
            stack.enter_context(mock.patch.object(
                submit_nai, "CHAR_LAYERS_PRIVATE_PATH",
                self.root / "data/nai_character_layers_private.json"))
            stack.enter_context(mock.patch.object(
                submit_nai, "GLOBAL_LAYER_PRIVATE_PATH",
                self.root / "data/nai_global_layer_private.json"))
            stack.enter_context(mock.patch.object(vault, "_process_dek", dek, create=True))
            yield

    def test_three_vault_payloads_cache_until_envelope_changes_then_reload(self):
        first = (
            {"preset": {"base_positive": "fixture-one"}},
            {"layer": {"persona": {"text": "fixture-one"}}},
            {"rules": {"r": {"from": "fixture-one", "to": "x"}}},
        )
        second = (
            {"preset": {"base_positive": "fixture-two"}},
            {"layer": {"persona": {"text": "fixture-two"}}},
            {"rules": {"r": {"from": "fixture-two", "to": "y"}}},
        )
        dek = vault.create_or_update(
            "1234", first[0], first[1], self.root, global_layer=first[2])

        readers = (
            submit_nai._read_augment_private,
            submit_nai._read_character_layers_private,
            submit_nai._read_global_layer_private,
        )
        with self._submit_paths(dek), \
                mock.patch.object(vault, "_open_json", wraps=vault._open_json) as decrypt:
            self.assertEqual(tuple(reader() for reader in readers), first)
            self.assertEqual(decrypt.call_count, 3)

            # envelope 未改：三类正文均直接复用，不重复解密。
            self.assertEqual(tuple(reader() for reader in readers), first)
            self.assertEqual(decrypt.call_count, 3)

            # 模拟“另一个 GUI 进程”原子保存：故意屏蔽本进程显式失效，只靠密文
            # envelope revision 检测；下一次 load 仍必须得到新正文。
            with mock.patch.object(vault, "invalidate_payload_cache", return_value=None):
                vault.create_or_update(
                    dek, second[0], second[1], self.root, global_layer=second[2])
            self.assertEqual(tuple(reader() for reader in readers), second)
            self.assertEqual(decrypt.call_count, 6)

            self.assertEqual(tuple(reader() for reader in readers), second)
            self.assertEqual(decrypt.call_count, 6)

    def test_plaintext_compatibility_mode_reads_each_change_immediately(self):
        path = self.root / "data/nai_augment_private.json"
        with mock.patch.object(submit_nai, "PROJECT_ROOT", self.root), \
                mock.patch.object(submit_nai, "AUGMENT_PRIVATE_PATH", path):
            path.write_text(json.dumps({"p": {"text": "fixture-a"}}), encoding="utf-8")
            self.assertEqual(submit_nai._read_augment_private()["p"]["text"], "fixture-a")
            path.write_text(json.dumps({"p": {"text": "fixture-b"}}), encoding="utf-8")
            self.assertEqual(submit_nai._read_augment_private()["p"]["text"], "fixture-b")


if __name__ == "__main__":
    unittest.main()

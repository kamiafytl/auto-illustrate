#!/usr/bin/env python3
"""NAI 终端期二 2b：加装层分栏重构专项测试（全假数据，不投 NAI）。

纯函数/dry 测试不访问仓库 data；worker 测试复用 test_integration harness 的临时
--data-dir、随机端口与 mock submit_request，不接触 data/terminal 或 8747。
"""
from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import nai_terminal  # noqa: F401（导入即把 tools/ 加入 sys.path）
from nai_terminal import adapter
from nai_terminal import db as dbm
from nai_terminal import test_integration as TI
from nai_terminal import vault
import job_emitter as JE
import submit_nai as SN
from tools import vault_migrate


def _cfg() -> dict:
    return {
        "default_params": {
            "model": "nai-diffusion-4-5-full", "width": 832, "height": 1216,
            "negative_prompt": "lowres", "scale": 5.0, "sampler": "k_euler", "steps": 28,
        },
        "batch": {"charref_wire_max_kb": 1024},
    }


class Phase2bTests(unittest.TestCase):
    def test_global_delete_boundary_scope_normalize_and_order(self):
        cfg = {
            "global_layer": {
                "enabled": True,
                # 故意把 replace 列在 delete 前：运行时仍须 delete→replace。
                "rules": [
                    {"id": "r-replace", "kind": "replace", "scope": "positive", "enabled": True},
                    {"id": "r-delete-eyes", "kind": "delete", "scope": "all", "enabled": True},
                    {"id": "r-delete-paren", "kind": "delete", "scope": "positive", "enabled": True},
                ],
            }
        }
        private = {"rules": {
            "r-replace": {"from": "light", "to": "bright"},
            "r-delete-eyes": {"word": "blue eyes"},
            "r-delete-paren": {"word": "cierra (ra-bit"},
        }}
        with mock.patch.object(SN, "_read_global_layer_private", return_value=private):
            rules = SN.load_global_layer(cfg)
        self.assertEqual([r["kind"] for r in rules], ["delete", "delete", "replace"])

        positive = "light blue eyes, blue eyeshadow, cierra (ra-bit, , tail"
        negative = "light blue eyes, cierra (ra-bit, bad"
        chars = [{"text": "light blue eyes, blue eyeshadow", "negative": "blue eyes, noisy"}]
        got = SN.apply_replacements(positive, negative, chars, rules)
        # Owner 验收例：blue eyes 是整段词序列；blue eyeshadow 不命中。
        self.assertEqual(got[0], "bright, blue eyeshadow, tail")
        self.assertEqual(got[1], "light, cierra (ra-bit, bad")
        self.assertEqual(got[2][0]["text"], "bright, blue eyeshadow")
        self.assertEqual(got[2][0]["negative"], "noisy")

    def test_global_runs_before_preset_chain_and_preset_delete_defaults(self):
        global_rules = [{"from": "alpha", "to": "beta", "wholeWord": True,
                         "kind": "replace", "scope": "all", "asciiBoundary": True}]
        aug = {"base_positive": {"enabled": True, "text": "alpha", "position": "suffix"},
               "chars": [], "extra_blocks": []}
        p, n, chars = SN.apply_augmentation("alpha", "", [], aug, global_rules=global_rules)
        preset_rules = [{"from": "beta", "to": "gamma", "wholeWord": True,
                         "kind": "replace", "scope": "all"}]
        p, n, chars = SN.apply_replacements(p, n, chars, preset_rules)
        self.assertEqual(p, "gamma, alpha")  # 后注入的 preset alpha 未被全局层回头改写

        # 新 kind/scope 缺失时严格保持旧规则：replace + all（正负及角色正负全作用）。
        old_rule = [{"from": "old", "to": "new", "wholeWord": True,
                     "kind": "replace", "scope": "all"}]
        got = SN.apply_replacements("old", "old", [{"text": "old", "negative": "old"}], old_rule)
        self.assertEqual(got, ("new", "new", [{"text": "new", "negative": "new"}]))

        delete = [{"from": "blue eyes", "to": "ignored", "wholeWord": True,
                   "kind": "delete", "scope": "positive", "asciiBoundary": True}]
        got = SN.apply_replacements("light blue eyes, blue eyeshadow", "blue eyes", [], delete)
        self.assertEqual(got[:2], ("light, blue eyeshadow", "blue eyes"))

    def test_front_text_exact_six_view_gate_and_default(self):
        aug = {"base_positive": None, "base_negative": None, "extra_blocks": [],
               "chars": [{"id": "c1", "enabled": True, "text": "base persona",
                          "front_text": "front only", "char_index": 1, "position": "suffix"}]}
        injected = {"front_full", "front_cowboy", "front_upper", "front_mid"}
        all_views = injected | {"front_lower", "back_full", "back_cowboy", "back_upper",
                                "back_mid", "back_lower"}
        for view in all_views:
            with self.subTest(view=view):
                _, _, chars = SN.apply_augmentation(
                    "", "", [{"text": "subject", "negative": ""}], aug,
                    views={"0": view})
                self.assertEqual("front only" in chars[0]["text"], view in injected)
        _, _, default_chars = SN.apply_augmentation(
            "", "", [{"text": "subject", "negative": ""}], aug)
        self.assertIn("front only", default_chars[0]["text"])

    def test_reference_front_back_pick_and_fallback(self):
        refs = [
            {"id": "front", "enabled": True, "image_b64": "fake-front"},  # 缺 side=front
            {"id": "back", "side": "back", "enabled": True, "image_b64": "fake-back"},
        ]
        with mock.patch.object(SN, "char_reference_fields_from_multi",
                               side_effect=lambda picked, cfg=None: [r["id"] for r in picked]):
            self.assertEqual(SN.augmentation_char_reference({"char_references": refs}, view="front_lower"),
                             ["front"])
            self.assertEqual(SN.augmentation_char_reference({"char_references": refs}, view="back_upper"),
                             ["back"])
            self.assertEqual(SN.augmentation_char_reference(
                {"char_references": refs[:1]}, view="back_lower"), ["front"])

    def test_global_private_vault_payload_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake_global = {"rules": {"x": {"word": "fake secret"}}}
            dek = vault.create_or_update("pw", {"p": {}}, {"c": {}}, root,
                                         global_layer=fake_global)
            self.assertEqual(vault.read_payload("global_layer", dek, root), fake_global)

    def test_revision_tracks_global_ciphertext(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            vault.create_or_update("pw", {}, {}, root,
                                   global_layer={"rules": {"x": {"word": "fake"}}})
            old_root = vault.PROJECT_ROOT
            vault.PROJECT_ROOT = root
            try:
                before, _ = adapter.compute_preset_revision({"id": "p"})
                env_path = root / vault.ENV_REL
                env = json.loads(env_path.read_text(encoding="utf-8"))
                env["payloads"]["global_layer"]["ct_b64"] += "A"
                env_path.write_text(json.dumps(env), encoding="utf-8")
                after, _ = adapter.compute_preset_revision({"id": "p"})
                self.assertNotEqual(before, after)
            finally:
                vault.PROJECT_ROOT = old_root

    def test_submit_global_private_reader_plain_vault_and_dual_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            plain = root / "data/nai_global_layer_private.json"
            plain.parent.mkdir(parents=True)
            fake_global = {"rules": {"x": {"word": "fake only"}}}
            plain.write_text(json.dumps(fake_global), encoding="utf-8")
            with mock.patch.object(SN, "PROJECT_ROOT", root), \
                 mock.patch.object(SN, "GLOBAL_LAYER_PRIVATE_PATH", plain):
                self.assertEqual(SN._read_global_layer_private(), fake_global)

            plain.unlink()
            dek = vault.create_or_update("pw", {}, {}, root, global_layer=fake_global)
            with contextlib.suppress(AttributeError):
                del SN._read_global_layer_private._payload
            with mock.patch.object(SN, "PROJECT_ROOT", root), \
                 mock.patch.object(SN, "GLOBAL_LAYER_PRIVATE_PATH", plain), \
                 mock.patch.object(vault, "_process_dek", dek, create=True):
                self.assertEqual(SN._read_global_layer_private(), fake_global)
                plain.write_text("{}", encoding="utf-8")
                with self.assertRaisesRegex(SN.NaiConfigError, "必须先完成迁移收尾"):
                    SN._read_global_layer_private()
            with contextlib.suppress(AttributeError):
                del SN._read_global_layer_private._payload

    def test_migrate_third_plaintext_when_present(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            data = root / "data"
            data.mkdir()
            values = ({"p": {"text": "fake preset"}}, {"c": {"text": "fake char"}},
                      {"rules": {"g": {"word": "fake global"}}})
            paths = vault_migrate._paths(root)
            for path, value in zip(paths, values):
                path.write_text(json.dumps(value), encoding="utf-8")
            with mock.patch("tools.vault_migrate.getpass.getpass", side_effect=["pw", "pw"]), \
                 mock.patch("nai_terminal.vault.cache_dek_dpapi"):
                self.assertEqual(vault_migrate.main(["--write", "--root", str(root)]), 0)
            dek = vault.unlock_with_password("pw", root)
            self.assertEqual(vault.read_payload("global_layer", dek, root), values[2])

    def test_worker_global_toggle_real_passthrough_no_deferred_event(self):
        calls = []
        original = SN.submit_request

        def fake(payload, cfg, *, augment=False, aug_preset=None, enable_extra=None,
                 global_layer=True, char_layers=False, opener=None, dry_run=False, log=print):
            calls.append(global_layer)
            out = Path(payload["output"])
            out.mkdir(parents=True, exist_ok=True)
            image = out / f"{payload['prefix']}_seed{payload['seed']}.png"
            image.write_bytes(TI._PNG)
            return {"saved": [str(image)], "request": None}

        SN.submit_request = fake
        try:
            try:
                with TI.harness(with_worker=True) as (client, ctx):
                    job = TI._build_text_job(rel="phase2b_global", n_samples=1)
                    job["augmentation"]["global_layer"] = False
                    job["idempotency_key"] = JE.compute_idempotency_key(job)
                    code, _ = client.post_job(job)
                    self.assertEqual(code, 202)
                    status, _ = TI._wait_status(client, job["job_id"], {"succeeded", "partial", "failed"})
                    self.assertEqual(status, "succeeded")
                    self.assertEqual(calls, [False])
                    conn = ctx.connect()
                    try:
                        codes = [row["code"] for row in dbm.get_events(conn, job["job_id"], limit=100)]
                    finally:
                        conn.close()
                    self.assertNotIn("FEATURE_DEFERRED", codes)
            except PermissionError as exc:
                self.skipTest(f"当前沙箱禁止随机端口 socket：{exc}")
        finally:
            SN.submit_request = original

    def test_old_job_dry_output_byte_equal_to_git_head(self):
        root = Path(__file__).resolve().parents[1]
        head_src = subprocess.check_output(
            ["git", "-C", str(root), "show", "HEAD:tools/submit_nai.py"], text=True)
        fd, name = tempfile.mkstemp(suffix="_submit_nai_head.py")
        os.close(fd)
        Path(name).write_text(head_src, encoding="utf-8")
        try:
            spec = importlib.util.spec_from_file_location("submit_nai_phase2b_head", name)
            head = importlib.util.module_from_spec(spec)
            assert spec.loader is not None
            spec.loader.exec_module(head)

            preset = {
                "id": "old-preset", "enabled": True,
                "base_positive": {"enabled": True, "text": "preset base", "position": "prefix"},
                "base_negative": {"enabled": True, "text": "preset neg", "position": "suffix"},
                "extra_blocks": [],
                "chars": [{"id": "old-char", "enabled": True, "text": "persona",
                           "negative": "char bad", "char_index": 1, "position": "suffix"}],
                "char_references": [],
                "replacements": {"enabled": True, "rules": [
                    {"id": "old-rule", "enabled": True, "from": "garden", "to": "park",
                     "wholeWord": True, "isPrivate": False},
                ]},
            }
            cfg = _cfg() | {"augmentation_presets": {"activeId": "old-preset", "presets": [preset]}}
            payload = {"positive": "1girl, garden", "negative": "lowres",
                       "characters": [{"text": "subject", "negative": ""}],
                       "params": {}, "count": 1, "seed": 123, "prefix": "old"}
            with mock.patch.object(SN, "_read_augment_private", return_value={}):
                new_out = SN.submit_request(json.loads(json.dumps(payload)), json.loads(json.dumps(cfg)),
                                            augment=True, dry_run=True)
            head._read_augment_private = lambda: {}
            old_out = head.submit_request(json.loads(json.dumps(payload)), json.loads(json.dumps(cfg)),
                                          augment=True, dry_run=True)
            new_bytes = json.dumps(new_out, sort_keys=True, ensure_ascii=False).encode("utf-8")
            old_bytes = json.dumps(old_out, sort_keys=True, ensure_ascii=False).encode("utf-8")
            self.assertEqual(new_bytes, old_bytes)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name)


class FillerAnchorTests(unittest.TestCase):
    """充数锚顶替不变式（2026-07-14 拍板：「换 adult woman」语义下 persona 进场必顶掉充数锚；
    追加式注入曾致舞萌女2 persona+orange hair 同槽互搏。修=_inject 注前 _strip_filler）。"""

    AUG = {"chars": [
        {"enabled": True, "role": "f1", "char_index": 1, "text": "P1", "position": "prefix"},
        {"enabled": True, "role": "f2", "char_index": 2, "text": "P2", "position": "prefix"},
    ]}

    def _chars(self):
        return [{"text": "adult woman, wedding_dress", "negative": ""},
                {"text": "adult woman, orange hair, black_dress", "negative": ""}]

    def test_persona_replaces_filler_old_char_index_path(self):
        _, _, cs = SN.apply_augmentation("b", "", self._chars(), self.AUG, cast=None)
        self.assertNotIn("orange hair", cs[1]["text"])
        self.assertTrue(cs[1]["text"].startswith("P2, adult woman"))

    def test_persona_replaces_filler_cast_path(self):
        _, _, cs = SN.apply_augmentation("b", "", self._chars(), self.AUG, cast=["f1", "f2"])
        self.assertNotIn("orange hair", cs[1]["text"])

    def test_no_persona_keeps_orange_fallback(self):
        aug = {"chars": [self.AUG["chars"][0]]}   # 只有 f1 → 女2 无 persona 仍充数
        _, _, cs = SN.apply_augmentation(
            "b", "", [{"text": "adult woman, a"}, {"text": "adult woman, b"}], aug, cast=["f1", "f2"])
        self.assertIn("orange hair", cs[1]["text"])

    def test_genuine_orange_character_untouched(self):
        # 保留原角色+bare CLI 自动加装：真·橙发原角色（无 adult woman 段）不误剥
        _, _, cs = SN.apply_augmentation(
            "b", "", [{"text": "konohata mira, orange hair, school uniform"}], self.AUG, cast=None)
        self.assertIn("orange hair", cs[0]["text"])

    def test_prepend_and_underscore_forms(self):
        _, _, cs = SN.apply_augmentation(
            "b", "", [{"text": "x"}, {"text": "orange hair, girl"}], self.AUG, cast=None)
        self.assertNotIn("orange hair", cs[1]["text"])
        _, _, cs = SN.apply_augmentation(
            "b", "", [{"text": "x"}, {"text": "adult woman, orange_girl, c"}], self.AUG, cast=None)
        self.assertNotIn("orange", cs[1]["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

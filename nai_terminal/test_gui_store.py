"""2c GUI 无 Qt 业务层测试；全部内容为临时假数据。"""
from __future__ import annotations

import base64
import copy
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from nai_terminal import gui_store, main as terminal_main, managed_launch, vault
from tools import submit_nai


def _fixture() -> tuple[dict, dict, dict, dict]:
    image = base64.b64encode(b"fixture-image-not-private").decode("ascii")
    cfg = {
        "output_folder": "output/fake",
        "augmentation_presets": {
            "activeId": "preset-fixture",
            "presets": [{
                "id": "preset-fixture", "name": "假预设", "group": "假分组", "enabled": True,
                "base_positive": {"enabled": True, "isPrivate": True, "position": "prefix",
                                  "role": "main", "text": ""},
                "base_negative": {"enabled": True, "isPrivate": True, "position": "prefix",
                                  "role": "main", "text": ""},
                "chars": [{"id": "char-fixture", "name": "假角色", "enabled": True,
                           "isPrivate": True, "position": "prefix", "role": "main",
                           "text": "", "front_text": "", "negative": "",
                           "extras": [{"id": "char-extra", "enabled": True,
                                       "isPrivate": True, "position": "prefix", "role": "main",
                                       "kind": "positive", "text": ""}]}],
                "extra_blocks": [{"id": "extra-fixture", "enabled": True, "isPrivate": True,
                                  "position": "prefix", "role": "main", "kind": "positive",
                                  "text": ""}],
                "char_references": [{"id": "ref-fixture", "enabled": True, "isPrivate": True,
                                     "image_b64": "", "side": "front", "strength": 0.7,
                                     "fidelity": 0.8, "role": "main", "fileName": ""}],
                "replacements": {"enabled": True, "rules": [
                    {"id": "replace-fixture", "enabled": True, "isPrivate": True,
                     "kind": "replace", "scope": "all", "from": "", "to": "",
                     "wholeWord": True, "role": "main"},
                    {"id": "delete-fixture", "enabled": True, "isPrivate": True,
                     "kind": "delete", "scope": "positive", "from": "", "to": "", "word": "",
                     "wholeWord": True, "role": "main"},
                ]},
            }],
        },
        "global_layer": {"enabled": True, "rules": [
            {"id": "global-delete", "kind": "delete", "scope": "negative", "enabled": True},
            {"id": "global-replace", "kind": "replace", "scope": "all", "enabled": True},
        ]},
        "character_layers": {"layers": []},
    }
    aug = {"preset-fixture": {
        "base_positive": "fixture positive", "base_negative": "fixture negative",
        "chars": {"char-fixture": {"text": "fixture character", "front_text": "fixture front",
                                          "negative": "fixture character negative"}},
        "char_extras": {"char-extra": "fixture character extra"},
        "extra": {"extra-fixture": "fixture extra"},
        "charref_images": {"ref-fixture": image},
        "charref_meta": {"ref-fixture": {
            "fileName": "fixture-reference.png",
            "source_path": r"C:\fixture\fixture-reference.png",
        }},
        "repl": {"replace-fixture": {"from": "fixture old", "to": "fixture new"},
                 "delete-fixture": {"word": "fixture remove"}},
    }}
    chars = {"layer-fixture": {"text": "fixture reusable layer"}}
    global_private = {"rules": {
        "global-delete": {"word": "fixture global remove"},
        "global-replace": {"from": "fixture global old", "to": "fixture global new"},
    }}
    return cfg, aug, chars, global_private


class _SubmitRoot:
    def __init__(self, root: Path):
        self.root = root
        self.stack = None

    def __enter__(self):
        self.stack = mock.patch.multiple(
            submit_nai, PROJECT_ROOT=self.root,
            AUGMENT_PRIVATE_PATH=self.root / "data/nai_augment_private.json",
            CHAR_LAYERS_PRIVATE_PATH=self.root / "data/nai_character_layers_private.json",
            GLOBAL_LAYER_PRIVATE_PATH=self.root / "data/nai_global_layer_private.json")
        self.stack.start()
        for reader in (submit_nai._read_augment_private,
                       submit_nai._read_character_layers_private,
                       submit_nai._read_global_layer_private):
            if hasattr(reader, "_payload"):
                delattr(reader, "_payload")
        return self

    def __exit__(self, *args):
        for reader in (submit_nai._read_augment_private,
                       submit_nai._read_character_layers_private,
                       submit_nai._read_global_layer_private):
            if hasattr(reader, "_payload"):
                delattr(reader, "_payload")
        if hasattr(vault, "_process_dek"):
            delattr(vault, "_process_dek")
        self.stack.stop()


class GuiStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir()
        self.cfg, self.aug, self.chars, self.global_private = _fixture()
        self.config = gui_store.ConfigStore(self.root)
        self.config.save(copy.deepcopy(self.cfg))

    def tearDown(self):
        self.tmp.cleanup()

    def _write_plain(self):
        values = {
            "nai_augment_private.json": self.aug,
            "nai_character_layers_private.json": self.chars,
            "nai_global_layer_private.json": self.global_private,
        }
        for name, value in values.items():
            (self.root / "data" / name).write_text(
                json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def test_plain_roundtrip_submit_merged_byte_equal_and_all_private(self):
        self._write_plain()
        private = gui_store.PrivateStore(self.root)
        with _SubmitRoot(self.root):
            before = submit_nai.load_augmentation(copy.deepcopy(self.cfg))
            merged = private.load_preset(copy.deepcopy(self.cfg), "preset-fixture")
            saved_cfg = private.save_preset(self.config, copy.deepcopy(self.cfg), merged)
            after = submit_nai.load_augmentation(saved_cfg)
            merged_after = private.load_preset(saved_cfg, "preset-fixture")
        canonical = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        self.assertEqual(canonical(before), canonical(after))
        self.assertEqual(canonical(merged), canonical(merged_after))
        shell = saved_cfg["augmentation_presets"]["presets"][0]
        self.assertTrue(shell["base_positive"]["isPrivate"])
        self.assertEqual(shell["base_positive"]["text"], "")
        self.assertTrue(all(c["isPrivate"] and not c["text"] for c in shell["chars"]))
        self.assertTrue(all(r["isPrivate"] and not r["from"] and not r["to"]
                            for r in shell["replacements"]["rules"]))
        reference = merged_after["char_references"][0]
        self.assertEqual(reference["fileName"], "fixture-reference.png")
        self.assertEqual(reference["source_path"], r"C:\fixture\fixture-reference.png")
        self.assertEqual(shell["char_references"][0]["fileName"], "")
        self.assertNotIn("source_path", shell["char_references"][0])
        self.assertNotIn("fixture positive", json.dumps(saved_cfg, ensure_ascii=False))
        self.assertNotIn("fixture-reference.png", json.dumps(saved_cfg, ensure_ascii=False))

    def test_reference_metadata_migration_is_private_and_idempotent(self):
        self._write_plain()
        cfg = self.config.load()
        ref = cfg["augmentation_presets"]["presets"][0]["char_references"][0]
        ref["fileName"] = "legacy-reference.png"
        ref["source_path"] = r"C:\fixture\legacy-reference.png"
        self.config.save(cfg)
        self.aug["preset-fixture"].pop("charref_meta", None)
        (self.root / "data/nai_augment_private.json").write_text(
            json.dumps(self.aug, ensure_ascii=False), encoding="utf-8")

        private = gui_store.PrivateStore(self.root)
        self.assertTrue(private.migrate_reference_metadata(self.config))
        shell_ref = self.config.load()["augmentation_presets"]["presets"][0][
            "char_references"][0]
        self.assertEqual(shell_ref["fileName"], "")
        self.assertNotIn("source_path", shell_ref)
        meta = private.read_all()["aug_private"]["preset-fixture"]["charref_meta"][
            "ref-fixture"]
        self.assertEqual(meta["fileName"], "legacy-reference.png")
        self.assertEqual(meta["source_path"], r"C:\fixture\legacy-reference.png")
        self.assertFalse(private.migrate_reference_metadata(self.config))

    def test_global_split_roundtrip_matches_submit_consumer(self):
        self._write_plain()
        private = gui_store.PrivateStore(self.root)
        with _SubmitRoot(self.root):
            before = submit_nai.load_global_layer(copy.deepcopy(self.cfg))
            merged = private.load_global(copy.deepcopy(self.cfg))
            saved_cfg = private.save_global(self.config, copy.deepcopy(self.cfg), merged)
            after = submit_nai.load_global_layer(saved_cfg)
        self.assertEqual(before, after)
        self.assertEqual(set(saved_cfg["global_layer"]["rules"][0]),
                         {"id", "kind", "scope", "enabled"})

    def test_vault_roundtrip_preserves_dek_and_other_payload(self):
        original_dek = vault.create_or_update(
            "fixture-password", self.aug, self.chars, self.root,
            global_layer=self.global_private)
        wrapped_before = json.loads((self.root / vault.ENV_REL).read_text("utf-8"))["wrapped_dek"]
        private = gui_store.PrivateStore(self.root)
        private.unlock("fixture-password")
        with _SubmitRoot(self.root), mock.patch.object(vault, "_process_dek", original_dek, create=True):
            before = submit_nai.load_augmentation(copy.deepcopy(self.cfg))
            merged = private.load_preset(copy.deepcopy(self.cfg), "preset-fixture")
            saved_cfg = private.save_preset(self.config, copy.deepcopy(self.cfg), merged)
            for reader in (submit_nai._read_augment_private,
                           submit_nai._read_character_layers_private,
                           submit_nai._read_global_layer_private):
                if hasattr(reader, "_payload"):
                    delattr(reader, "_payload")
            after = submit_nai.load_augmentation(saved_cfg)
        self.assertEqual(before, after)
        self.assertEqual(vault.unlock_with_password("fixture-password", self.root), original_dek)
        wrapped_after = json.loads((self.root / vault.ENV_REL).read_text("utf-8"))["wrapped_dek"]
        self.assertEqual(wrapped_before, wrapped_after)
        self.assertEqual(vault.read_payload("char_layers_private", original_dek, self.root), self.chars)

    def test_vault_plaintext_mutual_exclusion_fails_loud(self):
        vault.create_or_update("fixture-password", self.aug, self.chars, self.root,
                               global_layer=self.global_private)
        (self.root / "data/nai_global_layer_private.json").write_text("{}", encoding="utf-8")
        private = gui_store.PrivateStore(self.root)
        with self.assertRaisesRegex(gui_store.StoreError, "必须先完成迁移收尾"):
            private.unlock("fixture-password")

    def test_private_store_uses_project_scoped_dpapi_cache(self):
        private = gui_store.PrivateStore(self.root)
        fake_dek = b"d" * 32
        with (mock.patch.object(vault, "vault_exists", return_value=True),
              mock.patch.object(vault, "load_dek_from_dpapi", return_value=fake_dek) as load,
              mock.patch.object(vault, "read_payload", return_value={}) as verify,
              mock.patch.object(vault, "cache_dek_dpapi") as cache):
            self.assertTrue(private.unlock_cached())
            private.cache_unlocked()
        load.assert_called_once_with(self.root)
        verify.assert_called_once_with("aug_private", fake_dek, self.root)
        cache.assert_called_once_with(fake_dek, self.root)

    def test_invalid_cached_dek_stays_locked_without_secret_error(self):
        private = gui_store.PrivateStore(self.root)
        with (mock.patch.object(vault, "vault_exists", return_value=True),
              mock.patch.object(vault, "load_dek_from_dpapi", return_value=b"x" * 32),
              mock.patch.object(vault, "read_payload", side_effect=ValueError("fixture"))):
            self.assertFalse(private.unlock_cached())
            self.assertFalse(private.unlocked)

    def test_terminal_config_clean_switch_is_binary_and_preserves_other_keys(self):
        store = gui_store.TerminalConfig(self.root)
        store.path.parent.mkdir(parents=True, exist_ok=True)
        store.path.write_text('{"keep":"fixture"}', encoding="utf-8")
        for value in (True, False):
            store.save(meta_archive_dir=r"C:\\fixture-archive", clean_override=value)
            got = store.load()
            self.assertEqual(got["clean_override"], value)
            self.assertEqual(got["keep"], "fixture")
        for legacy in (None, "job", 1):
            store.path.write_text(json.dumps({"clean_override": legacy}), encoding="utf-8")
            self.assertIs(store.load()["clean_override"], False)
        with self.assertRaisesRegex(gui_store.StoreError, "true 或 false"):
            store.save(meta_archive_dir="/tmp/fixture", clean_override=None)

    def test_role_mapping_and_new_factories_use_terminal_prefix(self):
        self.assertEqual([gui_store.role_to_char_index(r)
                          for r in ("main", "f1", "f2", "other")], [1, 1, 2, 3])
        char = gui_store.new_character(4)
        extra = gui_store.new_extra_block("negative")
        preset = gui_store.new_preset("空白")
        self.assertRegex(char["id"], r"^ac_[0-9a-f]{12}$")
        self.assertEqual((char["name"], char["position"], char["x"], char["y"]),
                         ("角色4", "prefix", 0.5, 0.5))
        self.assertEqual((extra["kind"], extra["position"]), ("negative", "prefix"))
        self.assertEqual(preset["base_positive"]["position"], "prefix")

    def test_clone_rekeys_nested_private_identities(self):
        source = gui_store.new_preset("原件")
        source["chars"] = [gui_store.new_character(1)]
        source["chars"][0]["extras"] = [gui_store.new_extra_block("positive")]
        source["extra_blocks"] = [gui_store.new_extra_block("negative")]
        source["char_references"] = [{"id": "cr_old"}]
        source["replacements"]["rules"] = [gui_store.new_replacement_rule()]
        cloned = gui_store.clone_preset(source)
        self.assertEqual(cloned["name"], "原件 副本")
        self.assertNotEqual(cloned["id"], source["id"])
        self.assertNotEqual(cloned["chars"][0]["id"], source["chars"][0]["id"])
        self.assertNotEqual(cloned["chars"][0]["extras"][0]["id"],
                            source["chars"][0]["extras"][0]["id"])
        self.assertNotEqual(cloned["char_references"][0]["id"], "cr_old")

    def test_delete_preset_point_deletes_only_its_aug_blob(self):
        self._write_plain()
        cfg = copy.deepcopy(self.cfg)
        cfg["augmentation_presets"]["presets"].extend([
            {"id": "keep-disabled", "name": "停用", "enabled": False},
            {"id": "keep-enabled", "name": "启用", "enabled": True},
        ])
        self.config.save(cfg)
        aug = copy.deepcopy(self.aug) | {"keep-disabled": {"secret": "d"},
                                        "keep-enabled": {"secret": "e"},
                                        "unrelated-orphan": {"secret": "keep"}}
        aug_path = self.root / "data/nai_augment_private.json"
        aug_path.write_text(json.dumps(aug), encoding="utf-8")
        char_path = self.root / "data/nai_character_layers_private.json"
        char_bytes = char_path.read_bytes()
        with mock.patch("nai_terminal.gui_store._write_object",
                        wraps=gui_store._write_object) as writer:
            saved = gui_store.delete_preset(self.config, cfg, "preset-fixture")
        written_paths = [call.args[0] for call in writer.call_args_list]
        self.assertNotIn(char_path, written_paths)
        self.assertEqual(char_path.read_bytes(), char_bytes)
        after_aug = json.loads(aug_path.read_text("utf-8"))
        self.assertNotIn("preset-fixture", after_aug)
        self.assertEqual(set(after_aug), {"keep-disabled", "keep-enabled", "unrelated-orphan"})
        self.assertEqual(saved["augmentation_presets"]["activeId"], "keep-enabled")

    def test_new_units_save_and_submit_consumer_roundtrip(self):
        self._write_plain()
        private = gui_store.PrivateStore(self.root)
        merged = private.load_preset(copy.deepcopy(self.cfg), "preset-fixture")
        char = gui_store.new_character(2)
        char.update({"role": "f2", "roleLabel": "二号", "char_index": 2,
                     "text": "fixture new char", "negative": "fixture new neg"})
        char["extras"].append(gui_store.new_extra_block("positive") | {
            "text": "fixture new char extra", "role": "other", "roleLabel": "女3"})
        merged["chars"].append(char)
        merged["extra_blocks"].append(gui_store.new_extra_block("negative") | {
            "text": "fixture new negative", "role": "f2"})
        with _SubmitRoot(self.root):
            saved_cfg = private.save_preset(self.config, copy.deepcopy(self.cfg), merged)
            consumed = submit_nai.load_augmentation(saved_cfg)
            merged_after = private.load_preset(saved_cfg, "preset-fixture")
        canonical = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        self.assertEqual(canonical(merged), canonical(merged_after))
        self.assertTrue(any(c.get("id") == char["id"] for c in consumed["chars"]))

    def test_win_to_wsl_path_and_theme_config(self):
        cases = {
            r"\\wsl.localhost\Ubuntu\home\user\archive": "/home/user/archive",
            "\\\\wsl.localhost\\Ubuntu\\home\\owner\\": "/home/user/",
            r"X:\NAI\archive": "/mnt/x/NAI/archive",
            "/home/user/archive": "/home/user/archive",
        }
        for source, expected in cases.items():
            self.assertEqual(gui_store.win_to_wsl_path(source), expected)
        store = gui_store.TerminalConfig(self.root)
        store.save(meta_archive_dir="/tmp/fixture", clean_override=False, ui_theme="dark")
        self.assertEqual(store.load()["ui_theme"], "dark")

    def test_queue_client_mock_covers_all_endpoints_and_auth(self):
        (self.root / "data/terminal_token").write_text("fixture-token", encoding="utf-8")
        seen = []

        class Response:
            def __init__(self, value):
                self.value = value
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return json.dumps(self.value).encode("utf-8")

        def fake_urlopen(request, timeout):
            seen.append((request.method, request.full_url,
                         json.loads(request.data) if request.data else None,
                         request.get_header("Authorization"), timeout))
            return Response({"ok": True})

        client = gui_store.QueueClient(self.root, timeout=1.25)
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            client.queue()
            client.jobs(7)
            client.job("job-fixture")
            client.cancel("job-fixture")
            client.priority("job-fixture", 2.5)
            client.resume("job-fixture")
            client.pause(True)
        self.assertEqual([row[0] for row in seen],
                         ["GET", "GET", "GET", "POST", "POST", "POST", "POST"])
        self.assertEqual([row[1].split("8747", 1)[1] for row in seen], [
            "/v1/queue", "/v1/jobs?limit=7", "/v1/jobs/job-fixture",
            "/v1/jobs/job-fixture/cancel",
            "/v1/jobs/job-fixture/priority", "/v1/jobs/job-fixture/resume", "/v1/queue/pause"])
        self.assertTrue(all(row[3] == "Bearer fixture-token" and row[4] == 1.25 for row in seen))
        self.assertEqual(seen[4][2], {"sort_key": 2.5})
        self.assertEqual(seen[6][2], {"paused": True})

    def test_queue_client_unavailable_is_sanitized(self):
        client = gui_store.QueueClient(self.root)
        with self.assertRaisesRegex(gui_store.QueueUnavailable, "终端未启动"):
            client.queue()

    def test_autosave_canonical_skips_equivalent_content(self):
        original = {"z": [1, {"b": True, "a": "假数据"}], "a": None}
        changed, token = gui_store.content_changed(original, None)
        self.assertTrue(changed)
        equivalent = {"a": None, "z": [1, {"a": "假数据", "b": True}]}
        changed, same_token = gui_store.content_changed(equivalent, token)
        self.assertFalse(changed)
        self.assertEqual(token, same_token)
        changed, _ = gui_store.content_changed({**equivalent, "new": 1}, token)
        self.assertTrue(changed)

    def test_managed_commands_are_qprocess_argument_lists(self):
        lease = gui_store.GuiOwnerLease.create(self.root / "gui-state")
        self.addCleanup(lease.close)
        commands = gui_store.managed_process_commands(
            "/home/fixture/project", owner_lease="/mnt/c/fixture/owner.json",
            owner_token=lease.token)
        worker = commands["worker"]
        vite = commands["vite"]
        launcher = "/home/fixture/project/nai_terminal/managed_launch.py"
        # 启动=纯 argv 交给 Linux 侧垫片：跨 wsl.exe 的嵌套引号实测会错位，
        # 一旦回退成 shell 串，受管 PID 会指向 setsid 而不是服务本体（停不掉、日志断）。
        for command in (worker, vite):
            self.assertEqual(command.program, "wsl.exe")
            self.assertEqual(command.launcher, launcher)
            self.assertEqual(list(command.arguments[:6]),
                             ["-d", "Ubuntu-24.04", "--", "python3", "-u", launcher])
            self.assertEqual(command.arguments[6], "run")
            self.assertNotIn("setsid", " ".join(command.arguments))
            self.assertNotIn("bash", " ".join(command.arguments))
        self.assertEqual(worker.arguments[7], "worker")
        self.assertEqual(vite.arguments[7], "vite")
        for command in (worker, vite):
            self.assertIn("--owner-lease", command.arguments)
            self.assertIn("/mnt/c/fixture/owner.json", command.arguments)
            self.assertIn("--owner-token", command.arguments)
            self.assertIn(lease.token, command.arguments)
        self.assertEqual(vite.health_url, "http://localhost:3001/")
        self.assertNotIn("5173", repr(commands))
        self.assertNotIn("pkill", repr(commands))
        self.assertNotIn("taskkill", repr(commands))
        self.assertIsInstance(commands["wsl"], gui_store.DetachedCommand)
        self.assertEqual(commands["owner_ai"].qprocess_command(), (
            "code", ["--remote", "wsl+Ubuntu-24.04", "/home/fixture/project"], ""))
        self.assertEqual(commands["comfy_launcher"].working_directory,
                         r"D:\AI\ComfyUI-aki")
        self.assertTrue(commands["comfy_launcher"].program.endswith(
            r"ComfyUI-aki\绘世启动器.exe"))
        self.assertIn("--remote-debugging-port=9223",
                      commands["chrome_cdp"].arguments)
        self.assertIn("/home/user/project", commands["owner_project"].arguments)
        self.assertIn("/home/user/side-project", commands["owner_life"].arguments)

    def test_managed_commands_require_gui_ownership(self):
        with self.assertRaises(TypeError):
            gui_store.managed_process_commands("/home/fixture/project")
        with self.assertRaises(ValueError):
            gui_store.managed_process_commands(
                "/home/fixture/project", owner_lease="relative.json", owner_token="fixture")
        with self.assertRaises(ValueError):
            gui_store.managed_process_commands(
                "/home/fixture/project", owner_lease="/tmp/fixture.json", owner_token="")

    def test_gui_owner_lease_is_token_bound_and_expires(self):
        lease = gui_store.GuiOwnerLease.create(self.root / "gui-state")
        self.addCleanup(lease.close)
        self.assertTrue(gui_store.validate_gui_owner_lease(lease.path, lease.token))
        self.assertFalse(gui_store.validate_gui_owner_lease(lease.path, "wrong-token"))
        old = time.time() - gui_store.GUI_OWNER_MAX_AGE_SECONDS - 2
        os.utime(lease.path, (old, old))
        self.assertFalse(gui_store.validate_gui_owner_lease(lease.path, lease.token))
        lease.heartbeat()
        self.assertTrue(gui_store.validate_gui_owner_lease(lease.path, lease.token))
        lease.close()
        self.assertFalse(gui_store.validate_gui_owner_lease(lease.path, lease.token))

    def test_persistent_terminal_refuses_direct_cli_start(self):
        with mock.patch.dict(os.environ, {
                "NAI_TERMINAL_GUI_OWNER_LEASE": "",
                "NAI_TERMINAL_GUI_OWNER_TOKEN": ""}, clear=False):
            self.assertEqual(terminal_main.main([]), 2)

    def test_managed_guardian_stops_fake_child_when_gui_lease_disappears(self):
        lease = gui_store.GuiOwnerLease.create(self.root / "gui-state")
        timer = threading.Timer(0.3, lease.close)
        timer.start()
        started = time.monotonic()
        fake_spec = {
            "cwd": str(self.root),
            "argv": ["python3", "-c", "import time; time.sleep(30)"],
            "env": {},
        }
        try:
            with mock.patch.object(managed_launch, "managed_service_spec",
                                   return_value=fake_spec):
                code = managed_launch._run_owned_service(
                    "worker", str(self.root), str(lease.path), lease.token)
        finally:
            timer.cancel()
            lease.close()
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertNotEqual(code, 0)

    def test_managed_service_spec_runs_services_without_a_shell(self):
        worker = gui_store.managed_service_spec("worker", "/home/fixture/project")
        self.assertEqual(worker["cwd"], "/home/fixture/project")
        self.assertEqual(worker["argv"], ["python3", "-u", "-m", "nai_terminal"])
        vite = gui_store.managed_service_spec("vite", "/home/fixture/project")
        self.assertEqual(vite["cwd"], "/home/fixture/project/webapp")
        # 直接跑 vite 的 bin：npx 走 npm exec，会把真 vite 放进另一个进程组，
        # 我们持有的组就停不掉它，孤儿继续霸占 3001 端口（实测）。
        self.assertNotIn("npx", " ".join(vite["argv"]))
        self.assertEqual(vite["argv"][1], "node_modules/vite/bin/vite.js")
        self.assertIn("--strictPort", vite["argv"])
        self.assertIn("3001", vite["argv"])
        self.assertTrue(vite["env"]["PATH"].startswith(gui_store.NODE_BIN + ":"))
        with self.assertRaises(ValueError):
            gui_store.managed_service_spec("something-else", "/home/fixture/project")

    def test_managed_stop_is_exact_and_fail_closed(self):
        launcher = "/home/fixture/project/nai_terminal/managed_launch.py"
        program, arguments = gui_store.managed_stop_command(
            4321, "nai_terminal", launcher=launcher)
        self.assertEqual(program, "wsl.exe")
        self.assertEqual(arguments, ["-d", "Ubuntu-24.04", "--", "python3", "-u", launcher,
                                     "stop", "--pid", "4321", "--signature", "nai_terminal",
                                     "--signal", "TERM"])
        self.assertNotIn("pkill", " ".join(arguments))
        with self.assertRaises(ValueError):
            gui_store.managed_stop_command(0, "nai_terminal", launcher=launcher)
        with self.assertRaises(ValueError):
            gui_store.managed_stop_command(123, "bad signature", launcher=launcher)
        with self.assertRaises(ValueError):
            gui_store.managed_stop_command(123, "nai_terminal", launcher=launcher, signal="HUP")

    def test_stop_managed_group_checks_identity_before_signalling(self):
        # 组长可能先死而服务仍在（npm 式启动器就会这样），所以身份要按整组核验：
        # 组内没有我们的签名 = 拒绝（不误杀别人的进程）；组已空 = 视为已停。
        child = subprocess.Popen(["sleep", "30"], preexec_fn=os.setsid)
        self.addCleanup(child.kill)
        try:
            members = gui_store.process_group_members(child.pid)
            self.assertTrue(any("sleep" in member for member in members))
            self.assertEqual(gui_store.stop_managed_group(child.pid, "nai_terminal"), 3)
            self.assertIsNone(child.poll(), "签名不符时不得终止任何进程")
            self.assertEqual(gui_store.stop_managed_group(child.pid, "sleep"), 0)
            self.assertEqual(child.wait(timeout=5), -signal.SIGTERM)
            self.assertEqual(gui_store.process_group_members(child.pid), [])
            self.assertEqual(gui_store.stop_managed_group(child.pid, "sleep"), 0)
        finally:
            if child.poll() is None:
                child.kill()

    def test_log_line_trimming_normalizes_endings(self):
        got = gui_store.trim_log_lines(["旧一\n", "旧二"], "\x1b[31m新一\x1b[0m\r\n新二\r", limit=3)
        self.assertEqual(got, ["旧二", "新一", "新二"])
        self.assertEqual(gui_store.trim_log_lines(got, "忽略", limit=0), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

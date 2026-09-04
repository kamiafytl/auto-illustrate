from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.exceptions import InvalidTag

from nai_terminal import adapter, vault
from tools import submit_nai, vault_migrate


def _fixtures():
    img_a = base64.b64encode(b"fake-png-A\x00\x01").decode("ascii")
    img_b = base64.b64encode(b"fake-png-B\x02\x03").decode("ascii")
    aug = {
        "preset-a": {"base_positive": "private words", "charref_images": {"front": img_a},
                     "nested": {"charref_image": img_b}},
        "unicode": "私密",
    }
    chars = {"layer-a": {"text": "secret character", "charref_images": {"side": img_b}}}
    return aug, chars


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.aug, self.chars = _fixtures()

    def tearDown(self):
        self.tmp.cleanup()

    def test_password_encrypt_injected_dek_roundtrip_byte_equal(self):
        dek = vault.create_or_update("correct horse", self.aug, self.chars, self.root)
        got = vault.read_payload("aug_private", dek, self.root)
        self.assertEqual(json.dumps(got, ensure_ascii=False, separators=(",", ":")),
                         json.dumps(self.aug, ensure_ascii=False, separators=(",", ":")))
        self.assertEqual(vault.read_payload("char_layers_private", dek, self.root), self.chars)

    def test_wrong_password_raises_vault_auth_error(self):
        vault.create_or_update("right", self.aug, self.chars, self.root)
        with self.assertRaises(vault.VaultAuthError):
            vault.unlock_with_password("wrong", self.root)

    def test_tampered_payload_ciphertext_raises_invalid_tag(self):
        dek = vault.create_or_update("right", self.aug, self.chars, self.root)
        path = self.root / vault.ENV_REL
        env = json.loads(path.read_text("utf-8"))
        raw = bytearray(base64.b64decode(env["payloads"]["aug_private"]["ct_b64"]))
        raw[-1] ^= 1
        env["payloads"]["aug_private"]["ct_b64"] = base64.b64encode(raw).decode("ascii")
        path.write_text(json.dumps(env), encoding="utf-8")
        with self.assertRaises(InvalidTag):
            vault.read_payload("aug_private", dek, self.root)

    def test_refs_are_extracted_and_restored(self):
        dek = vault.create_or_update("right", self.aug, self.chars, self.root)
        env = json.loads((self.root / vault.ENV_REL).read_text("utf-8"))
        self.assertGreaterEqual(len(env["refs"]), 2)
        for meta in env["refs"].values():
            blob = self.root / "data/vault" / meta["file"]
            self.assertTrue(blob.is_file())
            self.assertGreater(blob.stat().st_size, 12)
        self.assertEqual(vault.read_payload("aug_private", dek, self.root), self.aug)
        self.assertEqual(vault.read_payload("char_layers_private", dek, self.root), self.chars)

    def test_submit_rejects_vault_and_plaintext_dual_source(self):
        vault.create_or_update("right", self.aug, self.chars, self.root)
        cases = (
            (submit_nai._read_augment_private, "AUGMENT_PRIVATE_PATH", "nai_augment_private.json"),
            (submit_nai._read_character_layers_private, "CHAR_LAYERS_PRIVATE_PATH",
             "nai_character_layers_private.json"),
        )
        for reader, constant, filename in cases:
            plain = self.root / "data" / filename
            plain.write_text("{}", encoding="utf-8")
            with self.subTest(reader=reader.__name__), \
                 mock.patch.object(submit_nai, "PROJECT_ROOT", self.root), \
                 mock.patch.object(submit_nai, constant, plain):
                with self.assertRaisesRegex(submit_nai.NaiConfigError, "必须先完成迁移收尾"):
                    reader()
            plain.unlink()

    def test_submit_vault_without_cached_dek_has_actionable_error(self):
        vault.create_or_update("right", self.aug, self.chars, self.root)
        with mock.patch.object(submit_nai, "PROJECT_ROOT", self.root), \
             mock.patch.object(submit_nai, "AUGMENT_PRIVATE_PATH",
                               self.root / "data/nai_augment_private.json"), \
             mock.patch.object(vault, "load_dek_from_dpapi", return_value=None), \
             mock.patch.object(vault, "_process_dek", None, create=True):
            with self.assertRaisesRegex(
                    submit_nai.NaiConfigError,
                    "vault 已启用但 DEK 未解锁：先跑 python3 tools/vault_migrate.py --unlock 输密码"):
                submit_nai._read_augment_private()

    def test_revision_changes_from_ciphertext_without_decryption(self):
        vault.create_or_update("right", self.aug, self.chars, self.root)
        old_root = vault.PROJECT_ROOT
        vault.PROJECT_ROOT = self.root
        try:
            before, _ = adapter.compute_preset_revision({"id": "public-a"})
            path = self.root / vault.ENV_REL
            env = json.loads(path.read_text("utf-8"))
            env["payloads"]["aug_private"]["ct_b64"] += "A"
            path.write_text(json.dumps(env), encoding="utf-8")
            after, _ = adapter.compute_preset_revision({"id": "public-a"})
            self.assertNotEqual(before, after)
        finally:
            vault.PROJECT_ROOT = old_root

    @unittest.skipUnless(shutil.which("powershell.exe"),
                         "当前环境找不到 powershell.exe，无法执行 Windows DPAPI")
    def test_dpapi_real_protect_unprotect_roundtrip(self):
        dek = os.urandom(32)
        try:
            vault.cache_dek_dpapi(dek, self.root)
        except (OSError, RuntimeError) as exc:
            self.skipTest(f"powershell.exe 存在但当前环境 DPAPI 不可用：{type(exc).__name__}")
        self.assertEqual(vault.load_dek_from_dpapi(self.root), dek)

    def test_dpapi_cache_path_can_be_project_scoped(self):
        protected = base64.b64encode(b"fixture-protected").decode("ascii")
        dek = b"k" * 32
        with mock.patch("nai_terminal.vault.subprocess.run") as run:
            run.return_value.stdout = protected + "\n"
            vault.cache_dek_dpapi(dek, self.root)
        path = self.root / vault.DPAPI_REL
        self.assertTrue(path.is_file())
        self.assertFalse((vault.PROJECT_ROOT / vault.DPAPI_REL).samefile(path)
                         if (vault.PROJECT_ROOT / vault.DPAPI_REL).exists() else False)
        with mock.patch("nai_terminal.vault.subprocess.run") as run:
            run.return_value.stdout = base64.b64encode(dek).decode("ascii") + "\n"
            self.assertEqual(vault.load_dek_from_dpapi(self.root), dek)

    def test_migrate_dry_write_purge_plaintext_flow(self):
        data = self.root / "data"
        data.mkdir()
        paths = (data / "nai_augment_private.json", data / "nai_character_layers_private.json")
        paths[0].write_text(json.dumps(self.aug, ensure_ascii=False), encoding="utf-8")
        paths[1].write_text(json.dumps(self.chars, ensure_ascii=False), encoding="utf-8")

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(vault_migrate.main(["--dry", "--root", str(self.root)]), 0)
        self.assertIn("DRY RUN", output.getvalue())
        self.assertFalse((self.root / vault.ENV_REL).exists())

        with mock.patch("tools.vault_migrate.getpass.getpass", side_effect=["pw", "pw"]), \
             mock.patch("nai_terminal.vault.cache_dek_dpapi") as cache:
            self.assertEqual(vault_migrate.main(["--write", "--root", str(self.root)]), 0)
            cache.assert_called_once()
        self.assertTrue((self.root / vault.ENV_REL).is_file())

        with mock.patch("tools.vault_migrate.getpass.getpass", return_value="pw"):
            self.assertEqual(vault_migrate.main(["--purge-plaintext", "--root", str(self.root)]), 0)
        for path in paths:
            self.assertFalse(path.exists())
            self.assertTrue(path.with_name(path.name + ".migrated_bak").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)

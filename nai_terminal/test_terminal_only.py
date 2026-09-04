#!/usr/bin/env python3
"""“终端是唯一最终出口”回归测试。

全部只用公开 fixture；不触碰私设正文，不发送 NAI 请求。
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

import nai_terminal  # noqa: F401  # 导入时把 tools/ 加入 sys.path
import check_submit_spawn
import terminal_bridge as TB


ROOT = Path(__file__).resolve().parent.parent


def _cfg() -> dict:
    return {
        "output_folder": "/tmp/terminal-only-ws",
        "default_params": {
            "model": "nai-diffusion-4-5-full", "width": 832, "height": 1216,
            "steps": 28, "sampler": "k_euler", "scale": 5.0,
            "cfg_rescale": 0.1, "noise_schedule": "karras",
            "variety_plus": False, "auto_position": True,
        },
        "augmentation_presets": {"activeId": "p_fixture", "presets": []},
    }


class TerminalOnlyTests(unittest.TestCase):
    def test_submit_nai_cli_actual_submit_is_blocked_before_network(self):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "tools" / ("submit_" + "nai.py")), "--json-stdin"],
            input="{}", text=True, capture_output=True, timeout=10,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("CLI 实际提交已禁用", proc.stderr + proc.stdout)

    def test_submit_nai_private_dry_is_blocked(self):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "tools" / ("submit_" + "nai.py")),
             "--json-stdin", "--dry-run", "--augment"],
            input="{}", text=True, capture_output=True, timeout=10,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("dry-run 不得加载私密层", proc.stderr + proc.stdout)

    def test_public_char_reference_enters_render_frame(self):
        payload = {
            "positive": "1girl", "negative": "lowres", "characters": [],
            "count": 1, "seed": 123, "prefix": "p01",
            "output": "/tmp/terminal-only-ws/set1", "params": {},
            "char_reference": {
                "image_b64": "AA==", "strength": 0.6, "fidelity": 0.9,
                "base_caption": "character&style",
            },
        }
        collector = TB.JobCollector(cfg=_cfg())
        collector.add(payload, augment=False)
        ref = collector.frames[0].char_reference
        self.assertIsNotNone(ref)
        self.assertEqual(ref.mode, "character&style")
        self.assertTrue(collector._paid)

    def test_official_entrypoints_have_no_submit_spawn(self):
        self.assertEqual(check_submit_spawn.scan(str(ROOT)), [])


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from nai_terminal.adapter import _public_submit_logger
from nai_terminal.scrub import scrub_submit_log


class SubmitLogPrivacyTests(unittest.TestCase):
    def test_http_body_is_private_and_public_console_gets_trace(self):
        with tempfile.TemporaryDirectory() as td:
            private_log = Path(td) / "private_error.log"
            public_lines = []
            logger = _public_submit_logger(
                SimpleNamespace(private_error_log=private_log), public_lines.append)

            logger("  详细: request prompt=SECRET_PRIVATE")

            public = "\n".join(public_lines)
            self.assertNotIn("SECRET_PRIVATE", public)
            self.assertIn("trace=", public)
            self.assertIn("SECRET_PRIVATE", private_log.read_text("utf-8"))

    def test_known_progress_stays_visible(self):
        line, sensitive = scrub_submit_log("[1/3] seed=123 提交中...")
        self.assertFalse(sensitive)
        self.assertEqual(line, "[1/3] seed=123 提交中...")

    def test_unknown_future_diagnostic_fails_closed(self):
        line, sensitive = scrub_submit_log("new diagnostic: SECRET_PRIVATE")
        self.assertTrue(sensitive)
        self.assertNotIn("SECRET_PRIVATE", line)


if __name__ == "__main__":
    unittest.main()

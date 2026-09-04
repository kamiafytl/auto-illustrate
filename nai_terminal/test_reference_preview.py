from __future__ import annotations

import base64
import os
import unittest


os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QApplication, QScrollArea
    from qfluentwidgets import TransparentToolButton
    from nai_terminal.gui.preset_page import (
        PresetPage,
        ReferenceEditor,
        ReplacementEditor,
        TextBlockEditor,
        _reference_image_bytes,
        _reference_pixmap,
    )
except Exception:  # pragma: no cover - Linux CI intentionally has no GUI stack
    QApplication = None


# 1x1 RGBA PNG. It contains no project/private data.
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8"
    "z9Dwn4GBgYEJRIAwACaXAoJlzqIBAAAAAElFTkSuQmCC"
)


@unittest.skipUnless(QApplication is not None, "PySide6 GUI stack is unavailable")
class ReferencePreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication(["reference-preview-test"])

    def test_decoder_rejects_invalid_data_without_leaking_it(self):
        self.assertEqual(_reference_image_bytes("not/private/path?"), b"")
        self.assertEqual(
            _reference_image_bytes("data:image/png;base64," + PNG_B64),
            base64.b64decode(PNG_B64),
        )

    def test_preview_is_downscaled_and_editor_reads_private_metadata(self):
        pixmap = _reference_pixmap(PNG_B64, 96)
        self.assertIsNotNone(pixmap)
        self.assertLessEqual(pixmap.width(), 96)
        self.assertLessEqual(pixmap.height(), 96)

        ref = {
            "id": "cr_test",
            "enabled": True,
            "isPrivate": True,
            "image_b64": PNG_B64,
            "fileName": "角色参考.png",
            "source_path": r"C:\private\角色参考.png",
            "side": "front",
            "strength": 1.0,
            "fidelity": 1.0,
            "role": "main",
        }
        editor = ReferenceEditor(ref, lambda: None)
        self.assertIn("角色参考.png", editor.file_name.text())
        self.assertIn(r"C:\private", editor.file_path.text())
        self.assertIsNotNone(editor.preview.pixmap())
        editor.apply()
        self.assertEqual(ref["source_path"], r"C:\private\角色参考.png")
        self.assertNotIn("path", ref)

    def test_legacy_reference_explains_that_original_path_was_not_recorded(self):
        ref = {
            "id": "cr_test",
            "enabled": True,
            "isPrivate": True,
            "image_b64": PNG_B64,
            "fileName": "角色参考.png",
            "side": "front",
            "strength": 1.0,
            "fidelity": 1.0,
            "role": "main",
        }
        editor = ReferenceEditor(ref, lambda: None)
        self.assertIn("旧数据未记录原始路径", editor.file_path.text())

    def test_delete_buttons_do_not_swallow_the_callback_argument(self):
        """``clicked`` passes ``checked`` into one-argument callbacks.

        The remove callbacks are written as ``lambda r=ref: ...``, so Qt used to
        overwrite the bound item with ``False`` and nothing was ever deleted.
        """
        ref = {"id": "cr_test", "isPrivate": True, "image_b64": PNG_B64,
               "side": "front", "strength": 1.0, "fidelity": 1.0, "role": "main"}
        block = {"id": "eb_test", "isPrivate": True, "text": "", "role": "main"}
        rule = {"id": "rp_test", "isPrivate": True, "kind": "replace",
                "from": "", "to": "", "role": "main"}
        seen = []
        cases = (
            (ReferenceEditor(ref, lambda r=ref: seen.append(r)), ref),
            (TextBlockEditor("特殊项", block, lambda b=block: seen.append(b)), block),
            (ReplacementEditor(rule, lambda r=rule: seen.append(r)), rule),
        )
        for editor, item in cases:
            with self.subTest(editor=type(editor).__name__):
                del seen[:]
                buttons = editor.findChildren(TransparentToolButton)
                self.assertEqual(len(buttons), 1)
                buttons[0].click()
                self.assertEqual(seen, [item])

    def test_preset_page_uses_immediate_qt_scroll_area(self):
        self.assertIs(PresetPage.__init__.__globals__["QScrollArea"], QScrollArea)
        self.assertNotIn("ScrollArea", PresetPage.__init__.__globals__)


if __name__ == "__main__":
    unittest.main()

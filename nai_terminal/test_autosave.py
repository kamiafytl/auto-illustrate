"""AutoSaveController regression tests (all fixture data; no private store access)."""
from __future__ import annotations

import unittest

try:
    from PySide6.QtCore import QCoreApplication
    from nai_terminal.gui.autosave import AutoSaveController
except ModuleNotFoundError:  # WSL test image intentionally has no Qt runtime.
    QCoreApplication = None
    AutoSaveController = None


class _Status:
    def __init__(self):
        self.value = ""

    def setText(self, value):
        self.value = value


class _ControlledExecutor:
    def __init__(self):
        self.tasks = []

    def submit(self, function, callback):
        self.tasks.append((function, callback))
        return len(self.tasks)

    def run_next(self):
        function, callback = self.tasks.pop(0)
        try:
            callback(function(), None)
        except Exception as exc:  # pragma: no cover - exercised by future failure tests
            callback(None, exc)


@unittest.skipIf(AutoSaveController is None, "PySide6 is not installed")
class AutoSaveControllerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QCoreApplication.instance() or QCoreApplication([])

    def test_keystroke_only_marks_revision_without_snapshot_scan(self):
        calls = []
        executor = _ControlledExecutor()
        controller = AutoSaveController(
            executor, lambda: calls.append("snapshot") or {"text": "fixture"},
            lambda _value: None, _Status(), delay=60_000)
        controller.seed({"large_fixture": "x" * 100_000})
        controller.changed()
        self.assertEqual(calls, [])
        self.assertTrue(controller.is_dirty())
        controller.save_now()
        self.assertEqual(calls, ["snapshot"])
        self.assertEqual(len(executor.tasks), 1)

    def test_flush_then_freezes_latest_revision_while_save_is_running(self):
        model = {"text": ""}
        written = []
        completed = []
        executor = _ControlledExecutor()
        controller = AutoSaveController(
            executor, lambda: model,
            lambda value: written.append(value["text"]), _Status(), delay=60_000)
        controller.seed()

        model["text"] = "第一版假数据"
        controller.changed()
        controller.save_now()
        model["text"] = "第二版最终假数据"
        controller.changed()
        controller.flush_then(lambda error: completed.append(error))

        self.assertEqual(len(executor.tasks), 2)
        executor.run_next()
        self.assertEqual(written, ["第一版假数据"])
        self.assertEqual(completed, [])
        executor.run_next()
        self.assertEqual(written, ["第一版假数据", "第二版最终假数据"])
        self.assertEqual(completed, [None])
        self.assertFalse(controller.is_dirty())


if __name__ == "__main__":
    unittest.main()

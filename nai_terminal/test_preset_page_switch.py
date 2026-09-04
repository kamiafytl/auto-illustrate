"""Preset-page switching regressions using synthetic, non-private data only."""
from __future__ import annotations

import copy
import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QApplication
    from nai_terminal.gui.preset_catalog import PresetCatalog
    from nai_terminal.gui.preset_page import PresetPage
    from nai_terminal.gui_store import new_preset
except ModuleNotFoundError:  # WSL test image intentionally has no Qt runtime.
    QApplication = None
    PresetCatalog = None
    PresetPage = None
    new_preset = None


class _ControlledExecutor:
    def __init__(self):
        self.tasks = []

    def submit(self, function, callback):
        self.tasks.append((function, callback))

    def run_next(self, injected_error=None):
        function, callback = self.tasks.pop(0)
        if injected_error is not None:
            callback(None, injected_error)
            return
        try:
            callback(function(), None)
        except Exception as exc:  # pragma: no cover - diagnostic path
            callback(None, exc)


class _ConfigStore:
    def __init__(self, presets):
        self.value = {"augmentation_presets": {
            "activeId": presets[0]["id"],
            "presets": copy.deepcopy(presets),
        }}

    def load(self):
        return copy.deepcopy(self.value)

    def save(self, value):
        self.value = copy.deepcopy(value)


class _PrivateStore:
    vault_mode = False

    def __init__(self, presets):
        self.values = {item["id"]: copy.deepcopy(item) for item in presets}
        self.saved = []

    def load_preset(self, _config, preset_id):
        return copy.deepcopy(self.values[preset_id])

    def save_preset(self, config_store, config, value):
        frozen = copy.deepcopy(value)
        self.values[frozen["id"]] = frozen
        self.saved.append(frozen)
        public = config.setdefault("augmentation_presets", {}).setdefault("presets", [])
        for index, item in enumerate(public):
            if item.get("id") == frozen["id"]:
                public[index] = copy.deepcopy(frozen)
                break
        config_store.save(config)
        return config


@unittest.skipIf(PresetPage is None, "PySide6/qfluentwidgets is not installed")
class PresetPageSwitchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_rapid_switch_saves_old_page_and_only_loads_latest_request(self):
        presets = []
        for preset_id in ("a", "b", "c"):
            value = new_preset(f"fixture-{preset_id}")
            value["id"] = preset_id
            presets.append(value)
        config = _ConfigStore(presets)
        private = _PrivateStore(presets)
        executor = _ControlledExecutor()
        page = PresetPage(config, private, executor)

        page.select_preset("a", make_active=False)
        executor.run_next()
        self.assertEqual(page.current["id"], "a")

        page.current["name"] = "fixture-a-edited"
        page.autosave.changed()
        page.select_preset("b", make_active=True)
        page.select_preset("c", make_active=True)
        self.assertFalse(page.editor_host.isEnabled())
        self.assertTrue(page.catalog.isEnabled())
        self.assertEqual(config.value["augmentation_presets"]["activeId"], "a")

        # First queued task freezes/saves A.  Its completion may only enqueue C.
        executor.run_next()
        self.assertEqual(private.saved[-1]["name"], "fixture-a-edited")
        self.assertEqual(len(executor.tasks), 1)
        executor.run_next()
        self.assertEqual(page.current["id"], "c")
        self.assertEqual(config.value["augmentation_presets"]["activeId"], "a")
        self.assertFalse(page.editor_host.isEnabled())
        executor.run_next()
        self.assertEqual(config.value["augmentation_presets"]["activeId"], "c")
        self.assertTrue(page.editor_host.isEnabled())
        page.deleteLater()

    def test_failed_old_save_keeps_old_editor_and_active_marker(self):
        presets = []
        for preset_id in ("a", "b"):
            value = new_preset(f"fixture-{preset_id}")
            value["id"] = preset_id
            presets.append(value)
        config = _ConfigStore(presets)
        private = _PrivateStore(presets)
        executor = _ControlledExecutor()
        page = PresetPage(config, private, executor)
        page.select_preset("a", make_active=False)
        executor.run_next()
        page.autosave.changed()

        page.select_preset("b", make_active=True)
        self.assertFalse(page.editor_host.isEnabled())
        with self.assertLogs(level="ERROR"):
            executor.run_next(RuntimeError("synthetic save failure"))

        self.assertEqual(page.current["id"], "a")
        self.assertEqual(config.value["augmentation_presets"]["activeId"], "a")
        self.assertEqual(page._active_id, "a")
        self.assertTrue(page.editor_host.isEnabled())
        page.deleteLater()

    def test_folder_grid_reflows_without_overlap(self):
        catalog = PresetCatalog()
        presets = []
        for group, count in (("常用", 3), ("委托", 2), ("创作", 3),
                             ("角色参考", 2), ("实验", 2), ("归档", 3), ("其他", 2)):
            for index in range(count):
                presets.append({"id": f"{group}-{index}", "name": f"假预设{index}",
                                "group": group, "enabled": True})
        catalog.set_presets(presets, "常用-0")

        for width, expected_columns in ((930, 3), (700, 2), (500, 1), (1400, 3)):
            catalog.resize(width, 1000)
            catalog.show()
            self.app.processEvents()
            self.assertEqual(catalog._columns, expected_columns)
            for index, card in enumerate(catalog.cards):
                self.assertTrue(all(chip.geometry().bottom() < card.body.height()
                                    for chip in card.chips))
                for other in catalog.cards[index + 1:]:
                    self.assertFalse(card.geometry().intersects(other.geometry()))
            self.assertLess(max(card.geometry().bottom() for card in catalog.cards),
                            catalog.height())
        catalog.deleteLater()


if __name__ == "__main__":
    unittest.main()

"""Responsive preset-catalog regressions using synthetic public data only."""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import QPoint
    from PySide6.QtWidgets import QApplication, QScrollArea, QVBoxLayout, QWidget
    from qfluentwidgets import ScrollArea, SmoothMode
    from nai_terminal.gui.app import disable_smooth_scrolling
    from nai_terminal.gui.preset_catalog import PresetCatalog
except ModuleNotFoundError:  # WSL test image intentionally has no Qt runtime.
    QApplication = None
    PresetCatalog = None


@unittest.skipIf(PresetCatalog is None, "PySide6/qfluentwidgets is not installed")
class PresetCatalogLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    @staticmethod
    def _presets():
        result = []
        for group, count in (("常用", 5), ("委托", 4), ("创作", 4), ("角色参考", 1)):
            for index in range(count):
                result.append({
                    "id": f"{group}-{index}",
                    "name": f"假预设-{index}",
                    "group": group,
                    "enabled": True,
                })
        return result

    def test_stale_wide_content_reflows_to_visible_viewport_and_back(self):
        """Reproduces maximize -> shrink while scroll content stays wide."""
        scroll = QScrollArea()
        scroll.setWidgetResizable(False)
        page = QWidget()
        page.resize(1420, 1200)
        layout = QVBoxLayout(page)
        catalog = PresetCatalog()
        catalog.set_presets(self._presets(), "常用-0")
        layout.addWidget(catalog)
        layout.addStretch(1)
        scroll.setWidget(page)
        scroll.resize(1450, 850)
        scroll.show()
        self.app.processEvents()
        self.assertEqual(catalog._columns, 3)

        # Keep the child at its maximized width to model the old Qt size-hint
        # loop.  The catalog must nevertheless respond to viewport width.
        scroll.resize(820, 850)
        page.resize(1420, 1200)
        self.app.processEvents()
        self.app.processEvents()
        self.assertEqual(catalog._columns, 2)
        visible_right = scroll.viewport().width()
        for card in catalog.cards:
            left = card.mapTo(scroll.viewport(), QPoint(0, 0)).x()
            self.assertGreaterEqual(left, 0)
            self.assertLessEqual(left + card.width(), visible_right)

        scroll.resize(1450, 850)
        self.app.processEvents()
        self.app.processEvents()
        self.assertEqual(catalog._columns, 3)
        scroll.deleteLater()

    def test_catalog_has_no_sticky_horizontal_minimum(self):
        catalog = PresetCatalog()
        catalog.set_presets(self._presets(), "常用-0")
        self.assertEqual(catalog.minimumSizeHint().width(), 0)
        catalog.deleteLater()

    def test_active_change_reuses_folder_and_capsule_widgets(self):
        catalog = PresetCatalog()
        presets = self._presets()
        catalog.set_presets(presets, "常用-0")
        cards = tuple(catalog.cards)
        chips = tuple(chip for card in catalog.cards for chip in card.chips)

        catalog.set_presets(presets, "常用-1")

        self.assertEqual(tuple(catalog.cards), cards)
        self.assertEqual(tuple(chip for card in catalog.cards for chip in card.chips), chips)
        self.assertTrue(next(chip for chip in chips if chip.preset_id == "常用-1")._active)
        catalog.deleteLater()

    def test_page_scroll_has_no_queued_inertia(self):
        page = QWidget()
        scroll = ScrollArea(page)
        disable_smooth_scrolling(page)
        self.assertEqual(
            scroll.scrollDelagate.verticalSmoothScroll.smoothMode,
            SmoothMode.NO_SMOOTH,
        )
        self.assertEqual(
            scroll.scrollDelagate.horizonSmoothScroll.smoothMode,
            SmoothMode.NO_SMOOTH,
        )
        page.deleteLater()


if __name__ == "__main__":
    unittest.main()

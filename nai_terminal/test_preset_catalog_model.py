from __future__ import annotations

import unittest

from nai_terminal.gui.preset_catalog_model import (grouped_presets, move_preset,
                                                     rename_group, reorder_group)


class PresetCatalogModelTests(unittest.TestCase):
    def setUp(self):
        self.presets = [
            {"id": "a", "name": "A", "group": "常用"},
            {"id": "b", "name": "B", "group": "常用"},
            {"id": "c", "name": "C", "group": "委托"},
            {"id": "d", "name": "D", "group": "创作"},
        ]

    def test_grouping_preserves_first_seen_and_item_order(self):
        grouped = grouped_presets(self.presets)
        self.assertEqual([name for name, _items in grouped], ["常用", "委托", "创作"])
        self.assertEqual([p["id"] for p in grouped[0][1]], ["a", "b"])

    def test_folder_rename_can_merge_without_losing_presets(self):
        result = rename_group(self.presets, "委托", "常用")
        self.assertEqual([p["id"] for p in result], ["a", "b", "c", "d"])
        self.assertEqual(result[2]["group"], "常用")
        self.assertEqual(self.presets[2]["group"], "委托")

    def test_folder_reorder_moves_the_complete_block(self):
        result = reorder_group(self.presets, "创作", "常用")
        self.assertEqual([p["id"] for p in result], ["d", "a", "b", "c"])

    def test_capsule_moves_within_and_across_folders(self):
        within = move_preset(self.presets, "b", "常用", "a")
        self.assertEqual([p["id"] for p in within], ["b", "a", "c", "d"])
        across = move_preset(self.presets, "a", "委托")
        self.assertEqual([p["id"] for p in across], ["b", "c", "a", "d"])
        self.assertEqual(next(p for p in across if p["id"] == "a")["group"], "委托")
        self.assertEqual(move_preset(self.presets, "a", "常用", "a"), self.presets)


if __name__ == "__main__":
    unittest.main()

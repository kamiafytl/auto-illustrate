"""Pure ordering helpers for the preset folder shelf.

This module deliberately has no Qt dependency.  The GUI uses it for optimistic
drag previews while tests can exercise the ordering contract on WSL.
"""
from __future__ import annotations

import copy
from collections.abc import Iterable


def grouped_presets(presets: Iterable[dict]) -> list[tuple[str, list[dict]]]:
    """Return presets grouped by ``group`` while preserving first-seen order."""
    order: list[str] = []
    groups: dict[str, list[dict]] = {}
    for preset in presets:
        if not isinstance(preset, dict):
            continue
        group = str(preset.get("group") or "")
        if group not in groups:
            order.append(group)
            groups[group] = []
        groups[group].append(preset)
    return [(group, groups[group]) for group in order]


def rename_group(presets: Iterable[dict], old_name: str, new_name: str) -> list[dict]:
    """Rename one folder.  Naming an existing folder intentionally merges it."""
    old_name, new_name = str(old_name or ""), str(new_name or "")
    result = copy.deepcopy(list(presets))
    for preset in result:
        if isinstance(preset, dict) and str(preset.get("group") or "") == old_name:
            preset["group"] = new_name
    return result


def reorder_group(presets: Iterable[dict], moved_group: str,
                  before_group: str | None) -> list[dict]:
    """Move a complete folder before another folder, or to the end."""
    grouped = grouped_presets(copy.deepcopy(list(presets)))
    moved_group = str(moved_group or "")
    before = None if before_group is None else str(before_group or "")
    moved = next((entry for entry in grouped if entry[0] == moved_group), None)
    if moved is None or moved_group == before:
        return [preset for _group, items in grouped for preset in items]
    rest = [entry for entry in grouped if entry[0] != moved_group]
    at = next((i for i, entry in enumerate(rest) if entry[0] == before), len(rest))
    rest.insert(at, moved)
    return [preset for _group, items in rest for preset in items]


def move_preset(presets: Iterable[dict], preset_id: str, target_group: str,
                before_id: str | None = None) -> list[dict]:
    """Move a capsule into a folder and place it before ``before_id``/at end."""
    result = copy.deepcopy(list(presets))
    preset_id, target_group = str(preset_id), str(target_group or "")
    if before_id is not None and str(before_id) == preset_id:
        return result
    moved = next((p for p in result
                  if isinstance(p, dict) and str(p.get("id") or "") == preset_id), None)
    if moved is None:
        return result
    result = [p for p in result
              if not (isinstance(p, dict) and str(p.get("id") or "") == preset_id)]
    moved["group"] = target_group

    if before_id:
        at = next((i for i, p in enumerate(result)
                   if isinstance(p, dict)
                   and str(p.get("id") or "") == str(before_id)
                   and str(p.get("group") or "") == target_group), -1)
        if at >= 0:
            result.insert(at, moved)
            return result

    same_group = [i for i, p in enumerate(result)
                  if isinstance(p, dict) and str(p.get("group") or "") == target_group]
    if same_group:
        result.insert(same_group[-1] + 1, moved)
    else:
        result.append(moved)
    return result

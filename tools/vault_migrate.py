#!/usr/bin/env python3
"""Migrate the private NAI preset/global-layer stores into vault.v1."""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from nai_terminal import vault


def _paths(root: Path) -> tuple[Path, Path, Path]:
    return (root / "data/nai_augment_private.json",
            root / "data/nai_character_layers_private.json",
            root / "data/nai_global_layer_private.json")


def _canonical(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _load_sources(root: Path) -> tuple[dict, dict, dict]:
    paths = _paths(root)
    # 两套既有私库仍是迁移前置；第三个全局层文件尚未创作时合法跳过。
    missing = [str(p) for p in paths[:2] if not p.is_file()]
    if missing:
        raise RuntimeError("缺少待迁移明文文件：" + ", ".join(missing))
    values = tuple(json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}
                   for p in paths)
    if not all(isinstance(v, dict) for v in values):
        raise RuntimeError("私有配置顶层必须是 JSON object")
    return values  # type: ignore[return-value]


def _verify(root: Path, dek: bytes, expected: tuple[dict, dict, dict]) -> None:
    actual = (vault.read_payload("aug_private", dek, root),
              vault.read_payload("char_layers_private", dek, root),
              vault.read_payload("global_layer", dek, root))
    if any(_canonical(a) != _canonical(e) for a, e in zip(actual, expected)):
        raise RuntimeError("vault roundtrip 校验失败")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NAI 私有预设 vault 迁移工具")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry", action="store_true", help="仅报告（默认）")
    modes.add_argument("--write", action="store_true", help="加密写入 vault")
    modes.add_argument("--purge-plaintext", action="store_true", help="校验后改名明文")
    modes.add_argument("--unlock", action="store_true", help="用密码重建 DPAPI DEK 缓存")
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    vault.PROJECT_ROOT = root
    paths = _paths(root)

    if not (args.write or args.purge_plaintext or args.unlock):
        print("DRY RUN：不会写入文件")
        for path in paths:
            print(f"将迁移：{path}（{'存在' if path.is_file() else '缺失'}）")
        print(f"目标：{root / vault.ENV_REL}")
        return 0

    if args.write:
        expected = _load_sources(root)
        password = getpass.getpass("设置 vault 密码：")
        confirm = getpass.getpass("再次输入密码：")
        if password != confirm:
            raise RuntimeError("两次密码输入不一致")
        dek = vault.create_or_update(password, expected[0], expected[1], root,
                                     global_layer=expected[2])
        _verify(root, dek, expected)
        vault.cache_dek_dpapi(dek)
        print("校验通过；确认后自行删除明文或运行 --purge-plaintext")
        return 0

    password = getpass.getpass("输入 vault 密码：")
    dek = vault.unlock_with_password(password, root)
    if args.unlock:
        vault.read_payload("aug_private", dek, root)
        vault.read_payload("char_layers_private", dek, root)
        vault.read_payload("global_layer", dek, root)
        vault.cache_dek_dpapi(dek)
        print("校验通过；DEK 缓存已重建")
        return 0

    expected = _load_sources(root)
    _verify(root, dek, expected)
    for path in paths:
        if path.exists():
            path.rename(path.with_name(path.name + ".migrated_bak"))
    print("校验通过；明文已改名为 .migrated_bak")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, vault.VaultAuthError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(1)

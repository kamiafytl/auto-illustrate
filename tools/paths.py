#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""路径单一真相源 loader（D1·系统优化工程）。

各工具 `import paths as PATHS` 后取层根，替代硬编码盘符路径：
    PATHS.PICS_ROOT / PATHS.WORKSPACE / PATHS.ORIG_COMPARE / PATHS.ARCHIVE / PATHS.ATLAS
真相源 = data/paths.json（改一处=全链路换路径）。层义见该文件 _layers。
注：NAI submit 管线的工作区路径独立走 data/nai_config.json 的 output_folder（须与 WORKSPACE 同步，见 linkage_map §一）。
"""
import os
import json

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PATHS_JSON = os.path.join(_ROOT, "data", "paths.json")


def load() -> dict:
    """读 data/paths.json 返回 dict（含 _doc/_layers/_sync 说明键 + 各层路径）。"""
    with open(_PATHS_JSON, encoding="utf-8") as f:
        return json.load(f)


def get(key: str) -> str:
    """取某层路径值（如 get('workspace')）。"""
    return _CFG[key]


_CFG = load()

# 层根常量（供各工具直接引用，值 = data/paths.json 当前原样）
PICS_ROOT = _CFG["pics_root"]         # 三层公共父目录 /…/ai-output
WORKSPACE = _CFG["workspace"]         # 易失层工作区 = nai-output（= nai_config.output_folder）
ORIG_COMPARE = _CFG["orig_compare"]   # 对照层 = reference
ARCHIVE = _CFG["archive"]             # 归档桶 = archive
ATLAS = _CFG["atlas"]                 # 永久层原图库 = atlas-downloads


if __name__ == "__main__":
    for k, v in _CFG.items():
        print(f"{k} = {v}")

"""NAI 出图终端 · 期一（队列内核）。

正式 server(HTTP 127.0.0.1:8747)+worker 只能由桌面 GUI 的「启动」按钮创建；
``python3 -m nai_terminal`` 常驻直启会被拒绝（``--once`` 仅供离线冒烟）。
契约层权威源：schemas/render_job.v1.json + tools/job_emitter.py（双向校验同源）。
隐私边界：本包只调 tools/submit_nai 的函数，隐私合并发生在其进程内部，本包不触碰
private 数据文件（详见 CLAUDE.md §9 / SPEC §八）。
"""

import sys as _sys
from pathlib import Path as _Path

# tools/ 加入 sys.path，使 adapter/worker/server 能 import submit_nai / job_emitter
_TOOLS = str(_Path(__file__).resolve().parent.parent / "tools")
if _TOOLS not in _sys.path:
    _sys.path.insert(0, _TOOLS)

__all__ = ["db", "estimate", "adapter", "worker", "server", "scrub", "main"]

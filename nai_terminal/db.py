"""SQLite 队列层（WAL + synchronous=FULL）。

铁律（SPEC §四）：只有 worker 线程写执行态，HTTP 线程只做入队事务与读；
入队(jobs+samples+event)必须同一事务。每个线程持有自己的 connection。

同时提供 Context（配置/路径中枢）：加载公开的 data/nai_config.json、解析 workspace
输出根、data/terminal/ 运行数据目录、token 文件。config 路径可注入=便于测试。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "data" / "nai_config.json"
DEFAULT_DATA_DIR = PROJECT_ROOT / "data" / "terminal"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------------------ Context

@dataclass
class Context:
    """终端运行上下文：公开配置 + 路径。config_path/data_dir 可注入（测试用）。"""

    config_path: Path
    data_dir: Path
    cfg: dict
    output_root: Path
    queue_paused: threading.Event = field(default_factory=threading.Event, repr=False)
    _cfg_lock: threading.RLock = field(
        default_factory=threading.RLock, init=False, repr=False)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "queue.db"

    @property
    def token_path(self) -> Path:
        # token 文件固定 data/terminal_token（SPEC §三）；测试注入独立 data_dir 时放其内
        if self.data_dir == DEFAULT_DATA_DIR:
            return PROJECT_ROOT / "data" / "terminal_token"
        return self.data_dir / "terminal_token"

    @property
    def private_error_log(self) -> Path:
        return self.data_dir / "private_error.log"

    @property
    def worker_lock(self) -> Path:
        return self.data_dir / "worker.lock"

    @property
    def terminal_config_path(self) -> Path:
        # app 内设配置（区别于公开的 data/nai_config.json）；仅存终端本机私有设定，如 meta 归档目录
        return self.data_dir / "config.json"

    @property
    def clean_staging_root(self) -> Path:
        """Clean 模式的私密落图暂存根。

        NAI 返回的带 meta/alpha 隐写原图只能先落在这里，绝不能先写进
        ``output_root`` 再原地清理。该路径固定属于终端私有 data_dir，不接受
        工单输入，也不会写入数据库、event 或 HTTP 响应。
        """
        return self.data_dir / "clean_staging"

    def meta_archive_dir(self) -> Path:
        """clean 去 meta 时【原版（带 meta + alpha 隐写）】的保密归档目录。

        读/建 data/terminal/config.json 的 `meta_archive_dir` 键（app 内设、不经工单、
        agent/工单不可指定）；缺则首次生成默认值 data/terminal/meta_archive/。整个
        data/terminal/ 已 gitignore。该路径绝不写入任何 event/artifacts/HTTP 响应。
        """
        cfgp = self.terminal_config_path
        tcfg: dict = {}
        if cfgp.exists():
            try:
                tcfg = json.loads(cfgp.read_text("utf-8"))
            except Exception:
                tcfg = {}
        mad = tcfg.get("meta_archive_dir")
        if not mad:
            mad = str(self.data_dir / "meta_archive")
            tcfg["meta_archive_dir"] = mad
            cfgp.parent.mkdir(parents=True, exist_ok=True)
            cfgp.write_text(json.dumps(tcfg, ensure_ascii=False, indent=2), encoding="utf-8")
        p = Path(mad)
        if not p.is_absolute():
            p = self.data_dir / p
        p.mkdir(parents=True, exist_ok=True)
        return p

    def clean_override(self) -> bool:
        """读取 App 内设的 Clean 二态开关；缺失、损坏或非法值均安全关闭。"""
        try:
            value = json.loads(self.terminal_config_path.read_text("utf-8")).get("clean_override")
        except Exception:
            return False
        return value if type(value) is bool else False

    def reload_cfg(self) -> dict:
        """从磁盘重新载入公开配置，并原子替换常驻进程看到的快照。

        GUI 会在 server/worker 常驻期间原子保存 ``nai_config.json``。不能把启动时
        的 ``cfg`` 永久当真，否则新建预设会被旧白名单拒绝，worker 也会继续提交
        旧公开壳。所有接单/估算/查询入口都调用本方法；锁只保护很短的读盘和引用
        替换，不会把私密正文放进 Context。
        """
        with self._cfg_lock:
            fresh = json.loads(self.config_path.read_text("utf-8"))
            if not isinstance(fresh, dict):
                raise ValueError("public config root must be an object")
            folder = fresh.get("output_folder", "output/nai")
            out = Path(folder)
            if not out.is_absolute():
                out = PROJECT_ROOT / out
            self.cfg = fresh
            self.output_root = out
            return fresh

    def connect(self) -> sqlite3.Connection:
        return connect(self.db_path)


def load_context(config_path: str | os.PathLike | None = None,
                 data_dir: str | os.PathLike | None = None) -> Context:
    cfg_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH
    ddir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
    ddir.mkdir(parents=True, exist_ok=True)
    cfg = json.loads(cfg_path.read_text("utf-8"))
    folder = cfg.get("output_folder", "output/nai")
    out = Path(folder)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    return Context(config_path=cfg_path, data_dir=ddir, cfg=cfg, output_root=out)


# ------------------------------------------------------------------ schema

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id           TEXT PRIMARY KEY,
    idempotency_key  TEXT UNIQUE NOT NULL,
    canonical_json   TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    status           TEXT NOT NULL,
    sort_key         REAL NOT NULL,
    preset_id        TEXT,
    preset_revision  TEXT,
    estimated_anlas  INTEGER NOT NULL DEFAULT 0,
    max_anlas        INTEGER NOT NULL DEFAULT 0,
    max_images       INTEGER NOT NULL DEFAULT 0,
    output_rel       TEXT,
    clean            INTEGER NOT NULL DEFAULT 0,
    error_summary    TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
    job_id     TEXT NOT NULL,
    frame_id   TEXT NOT NULL,
    sample_id  TEXT NOT NULL,
    seed       INTEGER NOT NULL,
    status     TEXT NOT NULL,
    attempt    INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, frame_id, sample_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     TEXT NOT NULL,
    frame_id   TEXT NOT NULL,
    sample_id  TEXT NOT NULL,
    path       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    job_id  TEXT,
    level   TEXT NOT NULL,
    code    TEXT NOT NULL,
    message TEXT
);
CREATE TABLE IF NOT EXISTS preset_revisions (
    revision         TEXT PRIMARY KEY,
    preset_id        TEXT NOT NULL,
    public_shell_json TEXT NOT NULL,
    created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, sort_key, created_at);
CREATE INDEX IF NOT EXISTS idx_samples_job ON samples(job_id);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, id);
"""


def connect(db_path: str | os.PathLike) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    conn.commit()


# ------------------------------------------------------------------ 入队（单事务）

def enqueue_job(conn: sqlite3.Connection, *, job: dict, canonical: str,
                estimated_anlas: int, sort_key: float,
                preset_id: str, output_rel: str) -> None:
    """jobs + samples + 一条 ACCEPTED event 单事务入库；status 直接 queued。"""
    now = utcnow()
    with conn:  # 事务：任一失败整体回滚
        conn.execute(
            """INSERT INTO jobs(job_id, idempotency_key, canonical_json, display_name,
                 status, sort_key, preset_id, preset_revision, estimated_anlas,
                 max_anlas, max_images, output_rel, clean, error_summary,
                 created_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (job["job_id"], job["idempotency_key"], canonical, job["display_name"],
             "queued", sort_key, preset_id, None, estimated_anlas,
             job["limits"]["max_anlas"], job["limits"]["max_images"], output_rel,
             1 if job.get("clean") else 0, None, now, now),
        )
        for f in job["frames"]:
            for s in f["samples"]:
                conn.execute(
                    """INSERT INTO samples(job_id, frame_id, sample_id, seed, status,
                         attempt, error, updated_at) VALUES(?,?,?,?,?,?,?,?)""",
                    (job["job_id"], f["frame_id"], s["sample_id"], s["seed"],
                     "pending", 0, None, now),
                )
        conn.execute(
            "INSERT INTO events(ts, job_id, level, code, message) VALUES(?,?,?,?,?)",
            (now, job["job_id"], "info", "ACCEPTED",
             f"queued images={job['limits']['max_images']} est_anlas={estimated_anlas}"),
        )


# ------------------------------------------------------------------ 读

def get_job(conn: sqlite3.Connection, job_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()


def get_job_by_idem(conn: sqlite3.Connection, key: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM jobs WHERE idempotency_key=?", (key,)).fetchone()


def list_jobs(conn: sqlite3.Connection, status: str | None, limit: int) -> list[sqlite3.Row]:
    if status:
        return conn.execute(
            "SELECT * FROM jobs WHERE status=? ORDER BY sort_key ASC, created_at ASC LIMIT ?",
            (status, limit)).fetchall()
    return conn.execute(
        "SELECT * FROM jobs ORDER BY sort_key ASC, created_at ASC LIMIT ?",
        (limit,)).fetchall()


def get_samples(conn: sqlite3.Connection, job_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM samples WHERE job_id=? ORDER BY frame_id, sample_id", (job_id,)).fetchall()


def get_artifacts(conn: sqlite3.Connection, job_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM artifacts WHERE job_id=? ORDER BY id", (job_id,)).fetchall()


def get_events(conn: sqlite3.Connection, job_id: str, limit: int = 200) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM events WHERE job_id=? ORDER BY id DESC LIMIT ?", (job_id, limit)).fetchall()


def queue_summary(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT status, COUNT(*) n FROM jobs GROUP BY status").fetchall()
    counts = {r["status"]: r["n"] for r in rows}
    running = conn.execute(
        "SELECT job_id, display_name, status FROM jobs "
        "WHERE status IN ('preparing','submitting','saving') "
        "ORDER BY updated_at ASC").fetchall()
    return {"counts": counts,
            "running": [dict(r) for r in running]}


def queue_position(conn: sqlite3.Connection, job_id: str) -> int | None:
    row = get_job(conn, job_id)
    if row is None or row["status"] != "queued":
        return None
    n = conn.execute(
        "SELECT COUNT(*) n FROM jobs WHERE status='queued' AND "
        "(sort_key < ? OR (sort_key = ? AND created_at < ?))",
        (row["sort_key"], row["sort_key"], row["created_at"])).fetchone()["n"]
    return int(n) + 1


# ------------------------------------------------------------------ 写（执行态：worker）

def set_job_status(conn: sqlite3.Connection, job_id: str, status: str,
                   error_summary: str | None = None,
                   preset_revision: str | None = None) -> None:
    with conn:
        if preset_revision is not None:
            conn.execute(
                "UPDATE jobs SET status=?, error_summary=COALESCE(?,error_summary), "
                "preset_revision=?, updated_at=? WHERE job_id=?",
                (status, error_summary, preset_revision, utcnow(), job_id))
        else:
            conn.execute(
                "UPDATE jobs SET status=?, error_summary=COALESCE(?,error_summary), "
                "updated_at=? WHERE job_id=?",
                (status, error_summary, utcnow(), job_id))


def set_job_sort_key(conn: sqlite3.Connection, job_id: str, sort_key: float) -> None:
    with conn:
        conn.execute("UPDATE jobs SET sort_key=?, updated_at=? WHERE job_id=?",
                     (sort_key, utcnow(), job_id))


def set_sample_status(conn: sqlite3.Connection, job_id: str, frame_id: str,
                      sample_id: str, status: str, *, error: str | None = None,
                      bump_attempt: bool = False) -> None:
    with conn:
        if bump_attempt:
            conn.execute(
                "UPDATE samples SET status=?, error=?, attempt=attempt+1, updated_at=? "
                "WHERE job_id=? AND frame_id=? AND sample_id=?",
                (status, error, utcnow(), job_id, frame_id, sample_id))
        else:
            conn.execute(
                "UPDATE samples SET status=?, error=?, updated_at=? "
                "WHERE job_id=? AND frame_id=? AND sample_id=?",
                (status, error, utcnow(), job_id, frame_id, sample_id))


def add_artifact(conn: sqlite3.Connection, *, job_id: str, frame_id: str,
                 sample_id: str, path: str, nbytes: int, sha256: str) -> None:
    with conn:
        conn.execute(
            "INSERT INTO artifacts(job_id, frame_id, sample_id, path, bytes, sha256, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (job_id, frame_id, sample_id, path, nbytes, sha256, utcnow()))


def add_event(conn: sqlite3.Connection, job_id: str | None, level: str,
              code: str, message: str | None = None) -> None:
    with conn:
        conn.execute(
            "INSERT INTO events(ts, job_id, level, code, message) VALUES(?,?,?,?,?)",
            (utcnow(), job_id, level, code, message))


def upsert_preset_revision(conn: sqlite3.Connection, *, revision: str,
                           preset_id: str, public_shell_json: str) -> None:
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO preset_revisions(revision, preset_id, public_shell_json, created_at) "
            "VALUES(?,?,?,?)",
            (revision, preset_id, public_shell_json, utcnow()))


def get_preset_revision(conn: sqlite3.Connection, revision: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM preset_revisions WHERE revision=?", (revision,)).fetchone()


def next_sort_key(conn: sqlite3.Connection) -> float:
    """默认 sort_key=当前 epoch 秒（FIFO：越早越小、越先跑）。"""
    return time.time()


def reset_nonsucceeded_samples(conn: sqlite3.Connection, job_id: str) -> None:
    """把该 job 里非 succeeded 的 sample 全部回 pending（resume/恢复用；succeeded 永不动）。"""
    with conn:
        conn.execute(
            "UPDATE samples SET status='pending', error=NULL, updated_at=? "
            "WHERE job_id=? AND status!='succeeded'",
            (utcnow(), job_id))

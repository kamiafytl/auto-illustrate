"""单写线程队列循环 + 崩溃恢复（SPEC §七）。

worker 是唯一写执行态的线程。取 queued 中 (sort_key,created_at) 最小者 → preparing
（绑 preset revision + 构建 payload）→ 逐帧逐 sample 经 adapter.run_sample 出图 → 落图核对
后登记 artifacts → 汇总 succeeded/partial/failed。每次状态迁移写 events（只进脱敏公开信息）。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from . import adapter, db, scrub


def _sha256_file(path: Path) -> tuple[int, str]:
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
            n += len(chunk)
    return n, h.hexdigest()


def recover(conn, ctx, *, log=print) -> None:
    """启动时崩溃恢复（SPEC §七）。preparing→queued；submitting/saving 烧钱→recovery_required、
    免费→queued 重跑未 succeeded；已 succeeded 的 sample 永不重跑。"""
    # 上次若在 NAI 返回后异常退出，带 meta 原图也只会留在私密 staging。
    # 单 worker 启动恢复时先清掉这些未完成暂存，绝不把它们搬到公开输出。
    shutil.rmtree(ctx.clean_staging_root, ignore_errors=True)

    rows = conn.execute(
        "SELECT job_id, status, estimated_anlas FROM jobs "
        "WHERE status IN ('preparing','submitting','saving')").fetchall()
    for r in rows:
        jid = r["job_id"]
        if r["status"] == "preparing":
            db.reset_nonsucceeded_samples(conn, jid)
            db.set_job_status(conn, jid, "queued")
            db.add_event(conn, jid, "warn", "RECOVERY_REQUEUE", "preparing→queued（启动恢复）")
        elif r["estimated_anlas"] and r["estimated_anlas"] > 0:
            db.set_job_status(conn, jid, "recovery_required")
            db.add_event(conn, jid, "warn", "RECOVERY_NEEDED",
                         "运行中崩溃且计费>0，等待 Owner resume 人工确认")
        else:
            db.reset_nonsucceeded_samples(conn, jid)
            db.set_job_status(conn, jid, "queued")
            db.add_event(conn, jid, "warn", "RECOVERY_REQUEUE",
                         "免费任务运行中崩溃，自动回队重跑未成 sample")


def _pick_next(conn) -> dict | None:
    row = conn.execute(
        "SELECT * FROM jobs WHERE status='queued' "
        "ORDER BY sort_key ASC, created_at ASC LIMIT 1").fetchone()
    return dict(row) if row else None


def _is_cancelled(conn, job_id: str) -> bool:
    row = db.get_job(conn, job_id)
    return bool(row and row["status"] == "cancelled")


class Worker(threading.Thread):
    def __init__(self, ctx, *, poll_interval: float = 0.3, log=print):
        super().__init__(name="nai-terminal-worker", daemon=True)
        self.ctx = ctx
        self.poll_interval = poll_interval
        self.log = log
        self._stop_event = threading.Event()
        self._opener = None
        self._opener_proxy = None

    def stop(self) -> None:
        self._stop_event.set()

    def _get_opener(self, cfg_snapshot: dict | None = None):
        cfg = cfg_snapshot if cfg_snapshot is not None else self.ctx.cfg
        proxy = cfg.get("proxy", "")
        if self._opener is None or proxy != self._opener_proxy:
            try:
                import submit_nai
                self._opener = submit_nai.make_opener(proxy)
                self._opener_proxy = proxy
            except Exception:
                self._opener = None
                self._opener_proxy = None
        return self._opener

    def _wait_if_paused(self) -> bool:
        """暂停时以可中断短等待挂起；返回是否已收到 stop。"""
        while self.ctx.queue_paused.is_set() and not self._stop_event.is_set():
            self._stop_event.wait(self.poll_interval)
        return self._stop_event.is_set()

    def run(self) -> None:
        conn = self.ctx.connect()
        try:
            recover(conn, self.ctx, log=self.log)
        except Exception as e:  # 恢复失败不阻塞启动
            self.log(f"[worker] 恢复异常: {e}")
        while not self._stop_event.is_set():
            if self._wait_if_paused():
                break
            try:
                job_row = _pick_next(conn)
            except Exception as e:
                self.log(f"[worker] 取队列异常: {e}")
                self._stop_event.wait(self.poll_interval)
                continue
            if not job_row:
                self._stop_event.wait(self.poll_interval)
                continue
            try:
                self.process_job(conn, job_row)
            except Exception as e:
                jid = job_row["job_id"]
                tid = scrub.new_trace_id()
                scrub.write_private_error(self.ctx.private_error_log, tid, repr(e))
                db.set_job_status(conn, jid, "failed",
                                  error_summary=scrub.public_error_summary("job_crashed", tid))
                db.add_event(conn, jid, "error", "JOB_FAILED",
                             scrub.public_error_summary("job_crashed", tid))
        conn.close()

    # ---------------------------------------------------------------- 单 job

    def process_job(self, conn, job_row: dict) -> None:
        jid = job_row["job_id"]
        job = json.loads(job_row["canonical_json"])   # 含全部 frames/augmentation/output
        aug = job["augmentation"]
        preset_id = aug["preset_id"]

        # One queued job gets exactly one public-config snapshot. ``Context`` is
        # shared with HTTP handlers, whose reload_cfg() replaces ctx.cfg whenever
        # the GUI saves. Keeping this local object prevents a mid-job edit from
        # changing the revision we bound, the global rules, or the actual submit.
        job_cfg = self.ctx.reload_cfg()
        configured_output = Path(job_cfg.get("output_folder", "output/nai"))
        job_output_root = (configured_output if configured_output.is_absolute()
                           else db.PROJECT_ROOT / configured_output).resolve()

        db.set_job_status(conn, jid, "preparing")
        db.add_event(conn, jid, "info", "PREPARING",
                     f"preset={preset_id}" if preset_id is not None else "preset=无加装(null)")

        # 绑 preset revision（期一=公开壳 hash；见 adapter.compute_preset_revision 偏离说明）
        shell = adapter.preset_public_shell(job_cfg, preset_id)
        bound_rev = None
        if shell is not None:
            bound_rev, shell_json = adapter.compute_preset_revision(shell)
            db.upsert_preset_revision(conn, revision=bound_rev, preset_id=preset_id,
                                      public_shell_json=shell_json)
            db.set_job_status(conn, jid, "preparing", preset_revision=bound_rev)

        # clean（去 meta 公开版）：期二 2d 真实现——落图后逐张灭 alpha 隐写 + 去文本块，
        # 原版另存 app 内设保密归档目录（不经工单、不入任何公开 event/HTTP 响应）。
        # Clean 只由 App 的二态开关决定。工单里的 legacy ``clean`` 字段为
        # schema 兼容保留，但不再拥有控制权，也不存在工单控制分支。
        job_clean = bool(job.get("clean"))
        clean_on = self.ctx.clean_override() is True
        if clean_on != job_clean:
            db.add_event(conn, jid, "info", "CLEAN_MODE",
                         "终端 Clean 开关：开" if clean_on else "终端 Clean 开关：关")
        archive_dir = self.ctx.meta_archive_dir() if clean_on else None
        if clean_on:
            public_root = job_output_root
            if (self._is_within(self.ctx.clean_staging_root, public_root) or
                    self._is_within(archive_dir, public_root)):
                raise adapter.AdapterError(
                    "Clean 私密暂存/原版归档目录不得位于 project 公开输出根内")
        clean_count = 0
        db.set_job_status(conn, jid, "submitting")
        db.add_event(conn, jid, "info", "SUBMITTING", None)

        samples = db.get_samples(conn, jid)
        by_key = {(s["frame_id"], s["sample_id"]): s for s in samples}
        total = len(samples)
        succeeded = sum(1 for s in samples if s["status"] == "succeeded")
        drift_logged = False

        for frame in job["frames"]:
            fid = frame["frame_id"]
            for smp in frame["samples"]:
                sid = smp["sample_id"]
                if self._wait_if_paused():
                    return
                if self._stop_event.is_set():
                    return
                if _is_cancelled(conn, jid):
                    db.add_event(conn, jid, "warn", "CANCELLED", "运行中检测到取消，停止")
                    return
                prev = by_key.get((fid, sid))
                if prev is not None and prev["status"] == "succeeded":
                    continue  # 已成永不重跑

                # PRESET_DRIFT 检查（执行时重算 hash 对比绑定值）
                if shell is not None and not drift_logged:
                    cur_shell = adapter.preset_public_shell(self.ctx.reload_cfg(), preset_id)
                    if cur_shell is not None:
                        cur_rev, _ = adapter.compute_preset_revision(cur_shell)
                        if cur_rev != bound_rev:
                            db.add_event(conn, jid, "warn", "PRESET_DRIFT",
                                         "预设公开壳执行时已变更，仍按绑定 revision 继续（期一已知限制）")
                            drift_logged = True

                db.set_sample_status(conn, jid, fid, sid, "submitting", bump_attempt=True)
                sample_stage = None
                try:
                    if clean_on:
                        sample_stage = self._new_clean_stage(jid, fid, sid)
                    saved = adapter.run_sample(
                        self.ctx, job, frame, smp,
                        opener=self._get_opener(job_cfg), log=self.log,
                        output_dir_override=sample_stage,
                        cfg_snapshot=job_cfg,
                        output_root_snapshot=job_output_root)
                    db.set_sample_status(conn, jid, fid, sid, "saving")
                    if clean_on:
                        # 原版始终在私密 staging；清理+复检全部成功后才原子发布。
                        saved = self._apply_clean(
                            archive_dir, sample_stage, job, fid, sid, saved,
                            public_root=job_output_root)
                        clean_count += len(saved)
                    valid = self._verify_and_register(conn, jid, fid, sid, saved)
                    if valid:
                        db.set_sample_status(conn, jid, fid, sid, "succeeded")
                        succeeded += 1
                    else:
                        db.set_sample_status(conn, jid, fid, sid, "failed",
                                             error="no valid artifact")
                        db.add_event(conn, jid, "error", "SAMPLE_FAILED",
                                     f"{fid}/{sid}: 落图核对不齐")
                except Exception as e:
                    tid = scrub.new_trace_id()
                    scrub.write_private_error(self.ctx.private_error_log, tid, repr(e))
                    db.set_sample_status(conn, jid, fid, sid, "failed",
                                         error=scrub.public_error_summary("submit_failed", tid))
                    db.add_event(conn, jid, "error", "SAMPLE_FAILED",
                                 scrub.public_error_summary("submit_failed", tid))
                finally:
                    if sample_stage is not None:
                        shutil.rmtree(sample_stage, ignore_errors=True)

        if clean_on and clean_count > 0:    # 每 job 一条汇总（噪音最小），绝不含归档路径
            db.add_event(conn, jid, "info", "CLEAN_APPLIED",
                         f"公开版去 meta 完成 {clean_count} 张（灭 alpha 隐写+去文本块，原版已归档保密路径）")

        db.set_job_status(conn, jid, "saving")
        if succeeded == total:
            db.set_job_status(conn, jid, "succeeded")
            db.add_event(conn, jid, "info", "JOB_SUCCEEDED", f"images={total}")
        elif succeeded > 0:
            db.set_job_status(conn, jid, "partial")
            db.add_event(conn, jid, "warn", "JOB_PARTIAL", f"{succeeded}/{total} 成功")
        else:
            db.set_job_status(conn, jid, "failed",
                              error_summary=scrub.public_error_summary("all_samples_failed", "-"))
            db.add_event(conn, jid, "error", "JOB_FAILED", f"0/{total} 成功")

    def _verify_and_register(self, conn, jid, fid, sid, saved: list[str]) -> bool:
        """逐一验证落图存在 + 尺寸>0，再登记 artifacts（bytes+sha256）。返回是否至少一张有效。"""
        ok = False
        for p in saved or []:
            path = Path(p)
            try:
                if not path.exists() or path.stat().st_size <= 0:
                    continue
                nbytes, digest = _sha256_file(path)
            except OSError:
                continue
            db.add_artifact(conn, job_id=jid, frame_id=fid, sample_id=sid,
                            path=str(path), nbytes=nbytes, sha256=digest)
            ok = True
        return ok

    def _new_clean_stage(self, jid: str, fid: str, sid: str) -> Path:
        """为一个 sample 建私密暂存目录；路径不含可控的原始 id。"""
        key = hashlib.sha256(f"{jid}\0{fid}\0{sid}".encode("utf-8")).hexdigest()
        stage = self.ctx.clean_staging_root / key
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True, mode=0o700)
        return stage

    @staticmethod
    def _is_within(path: Path, root: Path) -> bool:
        path = path.resolve()
        root = root.resolve()
        return path == root or root in path.parents

    @staticmethod
    def _atomic_private_copy(src: Path, dst: Path) -> None:
        """逐字节校验后原子落私密归档；失败不留下半截文件。"""
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(f".{dst.name}.{uuid.uuid4().hex}.part")
        try:
            shutil.copy2(src, tmp)
            src_size, src_sha = _sha256_file(src)
            dst_size, dst_sha = _sha256_file(tmp)
            if (src_size, src_sha) != (dst_size, dst_sha):
                raise adapter.AdapterError("clean 原版保密归档逐字节校验失败")
            os.replace(tmp, dst)
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()

    def _apply_clean(self, archive_dir: Path, stage_dir: Path, job: dict,
                     fid: str, sid: str, saved: list[str], *,
                     public_root: Path | None = None) -> list[str]:
        """在私密 staging 清理、复检，最后才原子发布 clean 图。

        原图从 NAI 开始就只写 ``data/terminal/clean_staging``。归档复制、去
        meta、复检或公开发布任一步失败，都会抛错并撤掉本 sample 已发布的
        clean 图；带 meta 原版从不进入 project 公开输出目录。返回值只含已经
        发布且复检通过的公开 clean 路径，供 artifacts 登记。
        """
        import strip_image_meta as SIM      # tools/ 已在 sys.path（见包 __init__）

        stage_root = Path(stage_dir).resolve()
        public_root = Path(public_root or self.ctx.output_root).resolve()
        public_dir = adapter.resolve_output_dir(public_root, job)
        if not self._is_within(public_dir, public_root):
            raise adapter.AdapterError("clean 公开输出目录越界")

        jid = job["job_id"]
        job_bucket = hashlib.sha256(jid.encode("utf-8")).hexdigest()[:24]
        archive_bucket = Path(archive_dir) / job_bucket
        clean_dir = stage_root / "clean"
        prepared: list[tuple[Path, Path]] = []
        names: set[str] = set()

        # 第一阶段完全在私密目录内完成：原版归档 → 清理 → 复检。
        for index, pth in enumerate(saved or []):
            src = Path(pth).resolve()
            if not self._is_within(src, stage_root):
                # submit 实现若违约把原版写进公开根，立即删除后失败；不能让它残留。
                if self._is_within(src, public_root):
                    with contextlib.suppress(OSError):
                        src.unlink()
                raise adapter.AdapterError("clean 原版落图位置越过私密暂存边界")
            try:
                if not src.is_file() or src.stat().st_size <= 0:
                    raise adapter.AdapterError("clean 私密暂存原图不存在或为空")
            except OSError as exc:
                raise adapter.AdapterError("clean 私密暂存原图不可读") from exc
            if src.name in names:
                raise adapter.AdapterError("clean 返回了重复的落图文件名")
            names.add(src.name)

            archive_key = hashlib.sha256(
                f"{fid}\0{sid}\0{index}\0{src.name}".encode("utf-8")
            ).hexdigest()[:20]
            archived = archive_bucket / f"{archive_key}_{src.name}"
            self._atomic_private_copy(src, archived)

            clean = clean_dir / f"{index:03d}_{src.name}"
            SIM.strip_one(src, clean)
            if not clean.is_file() or clean.stat().st_size <= 0 or not SIM.verify(clean):
                raise adapter.AdapterError(
                    f"clean 复检失败：清理副本仍含 meta/alpha 隐写（{fid}/{sid}）")
            prepared.append((clean, public_dir / src.name))

        if not prepared:
            return []

        # 第二阶段只搬运已复检的 clean 字节。公开临时文件本身也是 clean；
        # 全部异常路径都会清理临时文件并回滚本 sample 已发布的结果。
        public_dir.mkdir(parents=True, exist_ok=True)
        backups: dict[Path, Path | None] = {}
        public_temps: list[Path] = []
        published: list[Path] = []
        backup_dir = stage_root / "backups"
        try:
            for index, (_clean, final) in enumerate(prepared):
                if final.is_symlink() or (final.exists() and not final.is_file()):
                    raise adapter.AdapterError("clean 公开目标不是普通文件")
                if final.exists():
                    if SIM.verify(final):
                        backup = backup_dir / f"{index:03d}_{final.name}"
                        shutil.copy2(final, backup)
                        if not SIM.verify(backup):
                            raise adapter.AdapterError("clean 既有公开文件备份校验失败")
                        backups[final] = backup
                    else:
                        # 清掉旧版本遗留的公开带 meta 文件；先收入同一私密归档。
                        legacy_key = hashlib.sha256(
                            f"legacy\0{fid}\0{sid}\0{index}\0{final.name}".encode("utf-8")
                        ).hexdigest()[:20]
                        self._atomic_private_copy(
                            final, archive_bucket / f"{legacy_key}_legacy_{final.name}")
                        final.unlink()
                        backups[final] = None

            for clean, final in prepared:
                tmp = public_dir / (
                    f".{final.stem}.{uuid.uuid4().hex}.clean-tmp{final.suffix}")
                public_temps.append(tmp)
                shutil.copy2(clean, tmp)
                if not tmp.is_file() or tmp.stat().st_size <= 0 or not SIM.verify(tmp):
                    raise adapter.AdapterError("clean 公开发布前复检失败")
                os.replace(tmp, final)
                public_temps.remove(tmp)
                published.append(final)
            return [str(path) for path in published]
        except Exception:
            for path in reversed(published):
                with contextlib.suppress(OSError):
                    path.unlink()
                backup = backups.get(path)
                if backup is not None and backup.exists():
                    restore_tmp = public_dir / (
                        f".{path.stem}.{uuid.uuid4().hex}.restore-tmp{path.suffix}")
                    try:
                        shutil.copy2(backup, restore_tmp)
                        if not SIM.verify(restore_tmp):
                            raise adapter.AdapterError("clean 回滚备份复检失败")
                        os.replace(restore_tmp, path)
                    finally:
                        with contextlib.suppress(OSError):
                            restore_tmp.unlink()
            raise
        finally:
            for tmp in public_temps:
                with contextlib.suppress(OSError):
                    tmp.unlink()

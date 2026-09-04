"""HTTP 接口层（SPEC §五）。ThreadingHTTPServer 绑 127.0.0.1:8747。

全端点：Authorization: Bearer <token> + Host 头须 127.0.0.1/localhost（防 DNS rebinding）
+ body 上限 64MB。HTTP 线程只做入队事务与读（执行态由 worker 独占）。
接收端校验一律经 tools/job_emitter（validate_job/canonicalize_job/白名单）=双向同源。
"""

from __future__ import annotations

import json
import os
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import db, estimate

MAX_BODY = 64 * 1024 * 1024
DEFAULT_PORT = int(os.environ.get("NAI_TERMINAL_PORT", "8747"))
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


def ensure_token(ctx) -> str:
    """读/建终端 token（32 hex，0600）。"""
    p = ctx.token_path
    if p.exists():
        tok = p.read_text("utf-8").strip()
        if tok:
            return tok
    p.parent.mkdir(parents=True, exist_ok=True)
    tok = secrets.token_hex(16)
    p.write_text(tok, encoding="utf-8")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return tok


class TerminalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, ctx, token):
        super().__init__(addr, Handler)
        self.ctx = ctx
        self.token = token


class Handler(BaseHTTPRequestHandler):
    server_version = "NAITerminal/1"

    # ----------------------------------------------------------- 基础工具
    def log_message(self, *args):  # 静音默认 stderr 访问日志
        pass

    @property
    def ctx(self):
        return self.server.ctx

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code: int, error_code: str, message: str) -> None:
        self._send(code, {"error": error_code, "message": message})

    def _check_host(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip().strip("[]")
        return host in {h.strip("[]") for h in ALLOWED_HOSTS} or host == "127.0.0.1"

    def _check_auth(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        return secrets.compare_digest(auth[7:].strip(), self.server.token)

    def _guard(self) -> bool:
        """Host + Auth 双闸。通过返回 True，否则已发响应返回 False。"""
        if not self._check_host():
            self._err(403, "BAD_HOST", "Host 头非本机地址（防 DNS rebinding）")
            return False
        if not self._check_auth():
            self._err(401, "UNAUTHORIZED", "缺少或错误的 Bearer token")
            return False
        return True

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._err(413, "BODY_TOO_LARGE", f"body 超过 {MAX_BODY} 字节上限")
            return None
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._err(400, "BAD_JSON", f"body JSON 解析失败: {e}")
            return None

    def _reload_public_cfg(self) -> dict | None:
        """每次使用公开壳前刷新磁盘快照；失败时只回公开错误，不泄露文件内容。"""
        try:
            return self.ctx.reload_cfg()
        except Exception:
            self._err(503, "CONFIG_RELOAD_FAILED", "公开配置暂时无法载入，请检查终端保存状态后重试")
            return None

    # ----------------------------------------------------------- 路由
    def do_GET(self):
        if not self._guard():
            return
        parts, qs = self._route()
        try:
            if parts == ["v1", "queue"]:
                return self._get_queue()
            if len(parts) == 2 and parts[0] == "v1" and parts[1] == "jobs":
                return self._list_jobs(qs)
            if len(parts) == 3 and parts[:2] == ["v1", "jobs"]:
                return self._get_job(parts[2])
            if len(parts) == 4 and parts[:2] == ["v1", "jobs"] and parts[3] == "echo":
                return self._get_echo(parts[2])
        except Exception as e:
            return self._err(500, "INTERNAL", f"{type(e).__name__}")
        self._err(404, "NOT_FOUND", "未知端点")

    def do_POST(self):
        if not self._guard():
            return
        parts, _ = self._route()
        try:
            if parts == ["v1", "jobs"]:
                return self._post_job()
            if parts == ["v1", "queue", "pause"]:
                return self._post_queue_pause()
            if len(parts) == 4 and parts[:2] == ["v1", "jobs"]:
                action = parts[3]
                if action == "cancel":
                    return self._post_cancel(parts[2])
                if action == "priority":
                    return self._post_priority(parts[2])
                if action == "resume":
                    return self._post_resume(parts[2])
        except Exception as e:
            return self._err(500, "INTERNAL", f"{type(e).__name__}")
        self._err(404, "NOT_FOUND", "未知端点")

    def _route(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        return parts, parse_qs(u.query)

    # ----------------------------------------------------------- POST /v1/jobs
    def _post_job(self):
        import job_emitter as JE
        job = self._read_body()
        if job is None:
            return
        if not isinstance(job, dict):
            return self._err(400, "BAD_BODY", "工单必须是 JSON 对象")

        # Idempotency-Key 头须 == body.idempotency_key
        hdr_key = self.headers.get("Idempotency-Key")
        body_key = job.get("idempotency_key")
        if not hdr_key or hdr_key != body_key:
            return self._err(400, "IDEMPOTENCY_KEY_MISMATCH",
                             "Idempotency-Key 头必须与 body.idempotency_key 一致")

        # 先算 canonical 做幂等对账（对已存在 key：同 canonical→replay、异→409；
        # 偏离 SPEC 排序说明见文件尾注：内容寻址键下这是 409 唯一可达路径）
        try:
            canonical = JE.canonicalize_job(job).decode("utf-8")
        except JE.EmitterError as e:
            return self._err(422, "VALIDATION", str(e))

        # GUI 可在 server/worker 常驻时新建、改名或启停预设。接单白名单与预算必须
        # 使用本次请求开始时的磁盘公开壳，不能沿用进程启动时的旧 cfg。
        cfg = self._reload_public_cfg()
        if cfg is None:
            return

        conn = self.ctx.connect()
        try:
            existing = db.get_job_by_idem(conn, body_key)
            if existing is not None:
                if existing["canonical_json"] == canonical:
                    return self._send(200, {
                        "replayed": True,
                        "job_id": existing["job_id"],
                        "status": existing["status"],
                        "queue_position": db.queue_position(conn, existing["job_id"]),
                        "estimated_anlas": existing["estimated_anlas"],
                        "estimated_images": existing["max_images"],
                        "status_url": f"/v1/jobs/{existing['job_id']}",
                        "echo_url": f"/v1/jobs/{existing['job_id']}/echo",
                    })
                return self._err(409, "IDEMPOTENCY_CONFLICT",
                                 "同 Idempotency-Key 已存在但 body 不同（拒绝覆盖）")

            # 结构 + 语义 + 白名单 + 幂等键自洽（job_emitter 权威校验）
            try:
                JE.validate_job(job)
            except JE.EmitterError as e:
                return self._err(422, "VALIDATION", str(e))

            # preset 必须存在且 enabled（禁回落首个预设）；v1.1: preset_id=null（无加装）跳过该校验
            preset_id = job["augmentation"]["preset_id"]
            preset = None
            if preset_id is not None:
                preset = estimate.find_preset(cfg, preset_id)
                if not estimate.preset_enabled(preset):
                    return self._err(422, "PRESET_INVALID",
                                     f"preset_id 无效或未启用: {preset_id}（禁止回落首个预设）")

            # 预算：保守估算超 max_anlas → 拒单（终端不砍量）
            est, _rev = estimate.estimate_anlas(job, cfg)
            if est > job["limits"]["max_anlas"]:
                return self._err(422, "BUDGET_EXCEEDED",
                                 f"预估 {est} Anlas 超 max_anlas={job['limits']['max_anlas']}，"
                                 f"整单拒绝（请 Owner 确认预算或减量）")

            extras_report = (estimate.match_extras(preset, job["augmentation"].get("extras") or [])
                             if preset else {"matched": [], "injected": [], "not_found": []})
            sort_key = db.next_sort_key(conn)
            db.enqueue_job(conn, job=job, canonical=canonical, estimated_anlas=est,
                           sort_key=sort_key, preset_id=preset_id,
                           output_rel=job["output"]["relative_path"])
            jid = job["job_id"]
            return self._send(202, {
                "job_id": jid,
                "status": "queued",
                "queue_position": db.queue_position(conn, jid),
                "accepted_at": db.utcnow(),
                "estimated_images": job["limits"]["max_images"],
                "estimated_anlas": est,
                "extras_report": extras_report,
                "status_url": f"/v1/jobs/{jid}",
                "echo_url": f"/v1/jobs/{jid}/echo",
            })
        finally:
            conn.close()

    # ----------------------------------------------------------- GET /v1/jobs/{id}
    def _get_job(self, job_id: str):
        cfg = self._reload_public_cfg()
        if cfg is None:
            return
        conn = self.ctx.connect()
        try:
            row = db.get_job(conn, job_id)
            if row is None:
                return self._err(404, "NOT_FOUND", "job 不存在")
            samples = db.get_samples(conn, job_id)
            arts = db.get_artifacts(conn, job_id)
            job = json.loads(row["canonical_json"])
            preset = self._preset_shell_for(conn, row, job, cfg)
            extras_report = (estimate.match_extras(preset, job["augmentation"].get("extras") or [])
                             if preset else {"matched": [], "injected": [], "not_found": []})

            root = str(self.ctx.output_root.resolve())
            arts_by = {}
            for a in arts:
                p = a["path"]
                rel = os.path.relpath(p, root) if p.startswith(root) else p
                arts_by.setdefault(a["frame_id"], []).append(
                    {"sample_id": a["sample_id"], "path": rel,
                     "bytes": a["bytes"], "sha256": a["sha256"]})

            smp_by = {}
            for s in samples:
                smp_by.setdefault(s["frame_id"], []).append(
                    {"sample_id": s["sample_id"], "seed": s["seed"], "status": s["status"],
                     "attempt": s["attempt"], "error": s["error"]})

            counts = {}
            for s in samples:
                counts[s["status"]] = counts.get(s["status"], 0) + 1

            frames_out = []
            for f in job["frames"]:
                fid = f["frame_id"]
                frames_out.append({
                    "frame_id": fid,
                    "output_name": f["output_name"],
                    "samples": smp_by.get(fid, []),
                    "artifacts": arts_by.get(fid, []),
                })
            return self._send(200, {
                "job_id": job_id,
                "status": row["status"],
                "display_name": row["display_name"],
                "estimated_anlas": row["estimated_anlas"],
                "max_anlas": row["max_anlas"],
                "max_images": row["max_images"],
                "output": {"root": "workspace", "relative_path": row["output_rel"]},
                "preset": {"id": row["preset_id"], "revision": row["preset_revision"]},
                "extras_report": extras_report,
                "progress": {"total": len(samples), **counts},
                "frames": frames_out,
                "error": row["error_summary"],
            })
        finally:
            conn.close()

    # ----------------------------------------------------------- GET /v1/jobs (list)
    def _list_jobs(self, qs):
        status = (qs.get("status") or [None])[0]
        try:
            limit = int((qs.get("limit") or ["50"])[0])
        except ValueError:
            limit = 50
        limit = max(1, min(limit, 500))
        conn = self.ctx.connect()
        try:
            rows = db.list_jobs(conn, status, limit)
            out = [{
                "job_id": r["job_id"], "status": r["status"], "display_name": r["display_name"],
                "sort_key": r["sort_key"], "estimated_anlas": r["estimated_anlas"],
                "max_images": r["max_images"], "created_at": r["created_at"],
            } for r in rows]
            return self._send(200, {"jobs": out, "count": len(out)})
        finally:
            conn.close()

    # ----------------------------------------------------------- GET /v1/jobs/{id}/echo
    def _get_echo(self, job_id: str):
        """脱敏回显：仅公开 prompt 全文 + 每角色 caption/center/view + 预设 id/名/revision
        + 注入位置占位符 + 每帧参考(有无/张数/预估 Anlas)。永不返回参考图 b64/隐私正文。"""
        cfg = self._reload_public_cfg()
        if cfg is None:
            return
        conn = self.ctx.connect()
        try:
            row = db.get_job(conn, job_id)
            if row is None:
                return self._err(404, "NOT_FOUND", "job 不存在")
            job = json.loads(row["canonical_json"])
            aug = job["augmentation"]
            preset = self._preset_shell_for(conn, row, job, cfg)
            preset_name = preset.get("name") if preset else None
            extras_report = (estimate.match_extras(preset, aug.get("extras") or [])
                             if preset else {"matched": [], "injected": [], "not_found": []})

            # v1.1: preset_id=null（无加装）不注入预设占位
            placeholders = ["__PRIVATE_PRESET__"] if aug.get("preset_id") is not None else []
            if aug.get("global_layer"):
                placeholders.append("__PRIVATE_GLOBAL__")
            for x in extras_report["injected"]:
                placeholders.append(f"__PRIVATE_EXTRA:{x}__")

            frames_out = []
            for f in job["frames"]:
                cr = f.get("char_reference")
                nsamp = len(f.get("samples") or [])
                frames_out.append({
                    "frame_id": f["frame_id"],
                    "output_name": f["output_name"],
                    "base_positive": f["prompt"]["base_positive"],
                    "base_negative": f["prompt"]["base_negative"],
                    "characters": [{
                        "slot_id": c["slot_id"], "caption": c["caption"],
                        "negative": c["negative"], "center": c["center"], "view": c["view"],
                        "cast_id": c.get("cast_id"),
                    } for c in f["prompt"]["characters"]],
                    "char_reference": {
                        "present": cr is not None,
                        "count": 1 if cr is not None else 0,
                        "estimated_anlas": (estimate.ANLAS_PER_REF_SAMPLE * nsamp) if cr is not None else 0,
                    },
                })
            return self._send(200, {
                "job_id": job_id,
                "display_name": row["display_name"],
                "preset": {"id": aug["preset_id"], "name": preset_name,
                           "revision": row["preset_revision"]},
                "extras_report": extras_report,
                "injection_placeholders": placeholders,
                "frames": frames_out,
            })
        finally:
            conn.close()

    # ----------------------------------------------------------- 控制端点
    def _post_cancel(self, job_id: str):
        conn = self.ctx.connect()
        try:
            row = db.get_job(conn, job_id)
            if row is None:
                return self._err(404, "NOT_FOUND", "job 不存在")
            if row["status"] in ("queued", "recovery_required"):
                db.set_job_status(conn, job_id, "cancelled")
                db.add_event(conn, job_id, "info", "CANCELLED", "Owner 手动取消")
                return self._send(200, {"job_id": job_id, "status": "cancelled"})
            if row["status"] in ("preparing", "submitting", "saving"):
                return self._err(409, "CANCEL_RUNNING", "运行中任务期一不支持取消")
            return self._err(409, "CANCEL_INVALID", f"当前状态 {row['status']} 不可取消")
        finally:
            conn.close()

    def _post_priority(self, job_id: str):
        body = self._read_body()
        if body is None:
            return
        if not isinstance(body, dict) or not isinstance(body.get("sort_key"), (int, float)):
            return self._err(400, "BAD_BODY", "需 {sort_key: float}")
        conn = self.ctx.connect()
        try:
            row = db.get_job(conn, job_id)
            if row is None:
                return self._err(404, "NOT_FOUND", "job 不存在")
            db.set_job_sort_key(conn, job_id, float(body["sort_key"]))
            db.add_event(conn, job_id, "info", "PRIORITY", f"sort_key={body['sort_key']}")
            return self._send(200, {"job_id": job_id, "sort_key": float(body["sort_key"]),
                                    "queue_position": db.queue_position(conn, job_id)})
        finally:
            conn.close()

    def _post_resume(self, job_id: str):
        conn = self.ctx.connect()
        try:
            row = db.get_job(conn, job_id)
            if row is None:
                return self._err(404, "NOT_FOUND", "job 不存在")
            if row["status"] != "recovery_required":
                return self._err(409, "RESUME_INVALID",
                                 f"仅 recovery_required 可 resume（当前 {row['status']}）")
            db.reset_nonsucceeded_samples(conn, job_id)
            db.set_job_status(conn, job_id, "queued")
            db.add_event(conn, job_id, "info", "RESUMED", "Owner 人工确认续跑，仅重跑未成 sample")
            return self._send(200, {"job_id": job_id, "status": "queued"})
        finally:
            conn.close()

    def _post_queue_pause(self):
        body = self._read_body()
        if body is None:
            return
        if not isinstance(body, dict) or type(body.get("paused")) is not bool:
            return self._err(400, "BAD_BODY", "需 {paused: bool}")
        paused = body["paused"]
        if paused:
            self.ctx.queue_paused.set()
        else:
            self.ctx.queue_paused.clear()
        conn = self.ctx.connect()
        try:
            db.add_event(conn, None, "info",
                         "QUEUE_PAUSED" if paused else "QUEUE_RESUMED",
                         "Owner 暂停队列" if paused else "Owner 恢复队列")
        finally:
            conn.close()
        return self._send(200, {"paused": paused})

    # ----------------------------------------------------------- GET /v1/queue
    def _get_queue(self):
        conn = self.ctx.connect()
        try:
            return self._send(200, {**db.queue_summary(conn),
                                    "paused": self.ctx.queue_paused.is_set(),
                                    "clean_enabled": self.ctx.clean_override() is True})
        finally:
            conn.close()

    # ----------------------------------------------------------- 辅助
    def _preset_shell_for(self, conn, row, job, cfg):
        """优先用 job 绑定 revision 的快照公开壳（稳定），否则回落当前 cfg。"""
        rev = row["preset_revision"]
        if rev:
            pr = db.get_preset_revision(conn, rev)
            if pr:
                try:
                    return json.loads(pr["public_shell_json"])
                except Exception:
                    pass
        return estimate.find_preset(cfg, job["augmentation"]["preset_id"])


def make_server(ctx, port: int | None = None) -> TerminalHTTPServer:
    token = ensure_token(ctx)
    conn = ctx.connect()
    try:
        db.init_db(conn)
    finally:
        conn.close()
    bind_port = DEFAULT_PORT if port is None else port
    return TerminalHTTPServer(("127.0.0.1", bind_port), ctx, token)

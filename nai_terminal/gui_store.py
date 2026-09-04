"""NAI 终端 GUI 的无 Qt 业务层。

本模块只处理公开壳、私库拆合、本机配置和 loopback HTTP。私文内容不会被放进
异常消息；GUI、worker 和测试均可在不导入 Qt 的情况下复用这里的契约。
"""
from __future__ import annotations

import copy
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from . import vault


VALID_ROLES = {"main", "f1", "f2", "other"}
VALID_UI_THEMES = {"auto", "light", "dark"}
MANAGED_PID_PREFIX = "__MANAGED_PID__="
GUI_OWNER_LEASE_VERSION = 1
GUI_OWNER_MAX_AGE_SECONDS = 10.0
_ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def canonical_content(value: Any) -> str:
    """Return a stable, whitespace-free representation for save de-duplication."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_changed(value: Any, last_canonical: str | None) -> tuple[bool, str]:
    """Pure debounce decision: return whether *value* differs and its new token."""
    current = canonical_content(value)
    return current != last_canonical, current


@dataclass(frozen=True)
class ManagedProcessCommand:
    """One exact child owned by the launcher."""

    program: str
    arguments: tuple[str, ...]
    marker: str
    signature: str
    health_url: str
    launcher: str = ""

    def qprocess_command(self) -> tuple[str, list[str]]:
        return self.program, list(self.arguments)


@dataclass
class GuiOwnerLease:
    """A heartbeat proving that one visible GUI instance owns the worker.

    The lease is intentionally stored outside the repository.  The Linux-side
    launcher watches its mtime and stops the worker if the GUI crashes or is
    killed before ``closeEvent`` can run.
    """

    path: Path
    token: str

    @classmethod
    def create(cls, state_dir: str | os.PathLike[str]) -> "GuiOwnerLease":
        directory = Path(state_dir)
        directory.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(24)
        path = directory / f"worker-owner-{os.getpid()}-{token[:10]}.json"
        payload = {"version": GUI_OWNER_LEASE_VERSION,
                   "owner_pid": os.getpid(), "token": token}
        with path.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        return cls(path=path, token=token)

    def heartbeat(self) -> None:
        # Missing/replaced leases are not silently recreated: fail closed so a
        # worker can never outlive the ownership proof it started with.
        if not validate_gui_owner_lease(self.path, self.token,
                                        max_age_seconds=None):
            raise OSError("GUI ownership lease is missing or invalid")
        os.utime(self.path, None)

    def close(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def validate_gui_owner_lease(path: str | os.PathLike[str], token: str, *,
                             max_age_seconds: float | None = GUI_OWNER_MAX_AGE_SECONDS) -> bool:
    """Return whether *path* still proves ownership by *token*.

    This is a lifecycle guard, not a security boundary.  The random token
    prevents accidentally adopting a stale file from another GUI session.
    """
    try:
        lease_path = Path(path)
        stat = lease_path.stat()
        payload = json.loads(lease_path.read_text("utf-8"))
        if not isinstance(payload, dict):
            return False
        if payload.get("version") != GUI_OWNER_LEASE_VERSION:
            return False
        stored = payload.get("token")
        if not isinstance(stored, str) or not isinstance(token, str):
            return False
        if not secrets.compare_digest(stored, token):
            return False
        if max_age_seconds is not None:
            age = max(0.0, time.time() - stat.st_mtime)
            if age > max_age_seconds:
                return False
        return True
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


@dataclass(frozen=True)
class DetachedCommand:
    """A visible launcher shortcut that is never treated as a managed service.

    VSCode, the ComfyUI launcher and the user's other workspaces outlive this
    window.  Keeping them separate from ``ManagedProcessCommand`` prevents the
    terminal from ever trying to stop software it does not own.
    """

    program: str
    arguments: tuple[str, ...] = ()
    working_directory: str = ""

    def qprocess_command(self) -> tuple[str, list[str], str]:
        return self.program, list(self.arguments), self.working_directory


NODE_BIN = "/home/user/local/node/bin"
WEB_PORT = 3001
WORKER_PORT = 8747


def managed_service_spec(service: str, root: str) -> dict[str, Any]:
    """受管服务的唯一定义（GUI 与 Linux 侧启动垫片共用）。

    argv 是纯参数列表，不经 shell——跨 wsl.exe 的引号在实测中会错位。
    """
    root = str(root).rstrip("/") or "/"
    if service == "worker":
        return {"cwd": root, "argv": ["python3", "-u", "-m", "nai_terminal"], "env": {}}
    if service == "vite":
        # 打包后的 Windows 应用不会继承用户交互式 WSL 的 PATH，Node 一律用绝对路径。
        # 直接跑 vite 的 bin，不经 npx：npx 走 `npm exec`，会把真正的 vite 放进**另一个
        # 进程组**（实测），按我们持有的组停止就打不到它，孤儿继续霸占 3001 端口。
        return {
            "cwd": root + "/webapp",
            "argv": [f"{NODE_BIN}/node", "node_modules/vite/bin/vite.js",
                     "--host", "0.0.0.0", "--port", str(WEB_PORT), "--strictPort"],
            "env": {"PATH": f"{NODE_BIN}:{os.environ.get('PATH', '/usr/bin:/bin')}"},
        }
    raise ValueError(f"unknown managed service: {service}")


def _managed_wsl_command(service: str, root: str, *, signature: str,
                         health_url: str, owner_lease: str, owner_token: str,
                         distro: str = "Ubuntu-24.04") -> ManagedProcessCommand:
    """经 Linux 侧垫片启动一个受管服务与同组的租约守护进程。

    垫片会 setsid 自立进程组、报出组长 PID，再启动同组服务并监视 GUI 心跳。
    GUI 记录的 PID 始终是精确进程组组长；日志、退出码沿 wsl.exe 直通，停止按组
    精确命中。根因与旧 shell/exec 版的塌陷见 `nai_terminal/managed_launch.py`。
    """
    launcher = f"{str(root).rstrip('/')}/nai_terminal/managed_launch.py"
    arguments = ["-d", distro, "--", "python3", "-u", launcher, "run", service,
                 "--root", str(root), "--owner-lease", str(owner_lease),
                 "--owner-token", str(owner_token)]
    return ManagedProcessCommand("wsl.exe", tuple(arguments), f"owner-nai-{service}",
                                 signature, health_url, launcher)


def managed_process_commands(root: str = "/home/user/auto-illustrate", *,
                             owner_lease: str, owner_token: str) -> dict[str, Any]:
    """Return the only launcher commands used by the GUI.

    Services are unbuffered, have a unique process group, and are stopped by
    exact PID after command-line validation.  No wildcard process killing is
    exposed here.
    """
    root = str(root).rstrip("/")
    if not str(owner_lease).startswith("/"):
        raise ValueError("managed owner lease must be an absolute WSL path")
    if not owner_token:
        raise ValueError("managed owner token is required")
    distro = "Ubuntu-24.04"
    # ``code`` resolves to Code.exe on this Windows installation; unlike a
    # .cmd shim it can be launched directly by QProcess.
    code = "code"
    chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    comfy_root = r"D:\AI\ComfyUI-aki"
    return {
        "worker": _managed_wsl_command(
            "worker", root, signature="nai_terminal",
            health_url=f"http://localhost:{WORKER_PORT}/v1/queue",
            owner_lease=owner_lease, owner_token=owner_token),
        "vite": _managed_wsl_command(
            "vite", root, signature="vite",
            # On this WSL installation the Windows localhost forwarder is
            # reachable by the hostname but not by the literal 127.0.0.1.
            health_url=f"http://localhost:{WEB_PORT}/",
            owner_lease=owner_lease, owner_token=owner_token),

        # The remaining entries are launch-only shortcuts.  They deliberately
        # have no stop command and are never included in ProcessSupervisor.
        "wsl": DetachedCommand("wsl.exe", ("-d", distro, "--", "true")),
        "owner_ai": DetachedCommand(
            code, ("--remote", f"wsl+{distro}", root)),
        "owner_ai_claude": DetachedCommand(
            code, ("--remote", f"wsl+{distro}", root,
                   "--command", "claude-code.openPanel")),
        "comfy_launcher": DetachedCommand(
            comfy_root + r"\绘世启动器.exe", (), comfy_root),
        "owner_project": DetachedCommand(
            code, ("--remote", f"wsl+{distro}", "/home/user/project")),
        "owner_project_claude": DetachedCommand(
            code, ("--remote", f"wsl+{distro}", "/home/user/project",
                   "--command", "claude-code.openPanel")),
        "owner_life": DetachedCommand(
            code, ("--remote", f"wsl+{distro}", "/home/user/side-project")),
        "owner_life_claude": DetachedCommand(
            code, ("--remote", f"wsl+{distro}", "/home/user/side-project",
                   "--command", "claude-code.openPanel")),
        "chrome_cdp": DetachedCommand(
            chrome, ("--remote-debugging-port=9223", "--remote-allow-origins=*",
                     r"--user-data-dir=C:\Users\user\ChromeDebug")),
    }


def _validate_stop_request(pid: int, signature: str, signal: str) -> None:
    if type(pid) is not int or pid <= 1:
        raise ValueError("managed PID must be a positive integer")
    if not signature or not re.fullmatch(r"[A-Za-z0-9_.-]+", signature):
        raise ValueError("invalid managed process signature")
    if signal not in {"TERM", "KILL"}:
        raise ValueError("invalid managed process signal")


def managed_stop_command(pid: int, signature: str, *, launcher: str,
                         signal: str = "TERM",
                         distro: str = "Ubuntu-24.04") -> tuple[str, list[str]]:
    """Build an exact, fail-closed stop command for one managed process group.

    Like the start command this is a plain argument list handed to the Linux-side
    helper: a shell script would have to survive wsl.exe's command-line rebuild,
    which measurably mangles nested quotes.
    """
    _validate_stop_request(pid, signature, signal)
    return "wsl.exe", ["-d", distro, "--", "python3", "-u", str(launcher), "stop",
                       "--pid", str(pid), "--signature", signature, "--signal", signal]


def process_group_members(pgid: int) -> list[str]:
    """Return the command lines of every live process in group *pgid* (Linux)."""
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            # /proc/<pid>/stat: field 5 is the process group id.  The comm field
            # may contain spaces and parentheses, so split after the last ')'.
            stat = (entry / "stat").read_text("utf-8", "replace")
            fields = stat[stat.rindex(")") + 1:].split()
            if int(fields[2]) != pgid:
                continue
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ")
        except (OSError, ValueError, IndexError):
            continue
        members.append(cmdline.decode("utf-8", "replace").strip())
    return members


def stop_managed_group(pid: int, signature: str, signal: str = "TERM") -> int:
    """Signal one managed process group after checking its identity (Linux side).

    Identity is checked against the whole group, not just the leader: a service
    can outlive its group leader, and looking only at /proc/<pid> would then
    report "already gone" while the real process still holds its port.

    Returns a process exit code: 0 = signalled or already gone, 3 = refused
    because the live group does not carry our signature.
    """
    _validate_stop_request(pid, signature, signal)
    members = process_group_members(pid)
    if not members:
        return 0
    if not any(signature in member for member in members):
        return 3
    import signal as signal_module
    os.killpg(pid, getattr(signal_module, "SIG" + signal))
    return 0


def strip_terminal_escapes(value: str) -> str:
    """Remove terminal colour/control sequences before showing public logs."""
    return _ANSI_ESCAPE.sub("", str(value or ""))


def trim_log_lines(lines: Iterable[str], incoming: str = "", limit: int = 1200) -> list[str]:
    """Append decoded process output while retaining only the newest complete lines."""
    merged = [str(line).rstrip("\r\n") for line in lines]
    clean = strip_terminal_escapes(incoming)
    merged.extend(clean.replace("\r\n", "\n").replace("\r", "\n").splitlines())
    if limit <= 0:
        return []
    return merged[-limit:]


def _new_id(prefix: str) -> str:
    """Return the compact IDs used by the augmentation editor."""
    import uuid
    return prefix + uuid.uuid4().hex[:12]


def role_to_char_index(role: str) -> int:
    """Mirror the web editor's derived role slot (stored, not consumed here)."""
    return 2 if role == "f2" else 3 if role == "other" else 1


def win_to_wsl_path(path: str) -> str:
    """Convert a folder chosen by a Windows dialog to the worker's WSL path."""
    value = str(path or "").strip()
    if not value:
        return ""
    normalized = value.replace("\\", "/")
    match = re.match(r"^//wsl\.localhost/[^/]+(?P<path>/.*)?$", normalized,
                     flags=re.IGNORECASE)
    if match:
        return match.group("path") or "/"
    drive = re.match(r"^(?P<drive>[A-Za-z]):(?P<path>/.*)?$", normalized)
    if drive:
        suffix = drive.group("path") or "/"
        return f"/mnt/{drive.group('drive').lower()}{suffix}"
    return value if value.startswith("/") else normalized


def _base_block() -> dict:
    return {"text": "", "enabled": False, "isPrivate": True,
            "position": "prefix", "role": "main"}


def new_character(index: int) -> dict:
    return {"id": _new_id("ac_"), "name": f"角色{index}", "enabled": True,
            "isPrivate": True, "text": "", "negative": "", "front_text": "",
            "position": "prefix", "x": 0.5, "y": 0.5, "char_index": 1,
            "role": "main", "extras": []}


def new_extra_block(kind: str) -> dict:
    return {"id": _new_id("eb_"),
            "kind": "negative" if kind == "negative" else "positive",
            "text": "", "role": "main", "position": "prefix",
            "isPrivate": True, "enabled": True}


def new_replacement_rule() -> dict:
    return {"id": _new_id("r_"), "from": "", "to": "", "enabled": True,
            "wholeWord": True, "isPrivate": True, "role": "main",
            "kind": "replace", "scope": "all"}


def new_preset(name: str = "新预设") -> dict:
    """Create a blank terminal-semantic preset (new units default to prefix)."""
    return {"id": _new_id("p_"), "name": str(name), "enabled": True, "group": "",
            "base_positive": _base_block(), "base_negative": _base_block(),
            "extra_blocks": [], "chars": [], "char_references": [],
            "replacements": {"enabled": True, "rules": []}}


def clone_preset(source: dict, name: str | None = None) -> dict:
    """Deep-clone a preset while replacing every private-blob identity."""
    cloned = copy.deepcopy(source)
    cloned["id"] = _new_id("p_")
    cloned["name"] = name if name is not None else f"{source.get('name') or '预设'} 副本"
    for block in cloned.get("extra_blocks") or []:
        if isinstance(block, dict):
            block["id"] = _new_id("eb_")
    for char in cloned.get("chars") or []:
        if not isinstance(char, dict):
            continue
        char["id"] = _new_id("ac_")
        for extra in char.get("extras") or []:
            if isinstance(extra, dict):
                extra["id"] = _new_id("eb_")
    for ref in cloned.get("char_references") or []:
        if isinstance(ref, dict):
            ref["id"] = _new_id("cr_")
    replacements = cloned.get("replacements")
    if isinstance(replacements, dict):
        for rule in replacements.get("rules") or []:
            if isinstance(rule, dict):
                rule["id"] = _new_id("r_")
    return cloned


class StoreError(Exception):
    """配置或私库状态不合法。"""


class VaultLockedError(StoreError):
    """vault 尚未在本进程解锁。"""


class QueueUnavailable(StoreError):
    """本机 worker HTTP 当前不可用。"""


def _read_object(path: Path, *, missing_ok: bool = False) -> dict:
    if missing_ok and not path.exists():
        return {}
    try:
        value = json.loads(path.read_text("utf-8"))
    except Exception:
        raise StoreError(f"配置文件无法读取：{path.name}") from None
    if not isinstance(value, dict):
        raise StoreError(f"配置文件格式错误：{path.name}")
    return value


def _write_object(path: Path, value: dict) -> None:
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    vault._atomic_write(path, raw)


class ConfigStore:
    """公开 ``data/nai_config.json`` 的读取与原子写入。"""

    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        self.path = self.root / "data/nai_config.json"

    def load(self) -> dict:
        return _read_object(self.path)

    def save(self, value: dict) -> None:
        if not isinstance(value, dict):
            raise StoreError("公开配置必须是对象")
        _write_object(self.path, value)


class PrivateStore:
    """加装私库的明文/vault 双轨读写与公开壳拆合。"""

    FILENAMES = {
        "aug_private": "nai_augment_private.json",
        "char_layers_private": "nai_character_layers_private.json",
        "global_layer": "nai_global_layer_private.json",
    }

    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        self._dek: bytes | None = None

    @property
    def vault_mode(self) -> bool:
        return vault.vault_exists(self.root)

    @property
    def unlocked(self) -> bool:
        return not self.vault_mode or self._dek is not None

    def _plain_path(self, name: str) -> Path:
        return self.root / "data" / self.FILENAMES[name]

    def _assert_exclusive(self) -> None:
        if self.vault_mode and any(self._plain_path(name).exists() for name in self.FILENAMES):
            raise StoreError("vault 与明文私有配置同时存在：必须先完成迁移收尾")

    def unlock(self, password: str) -> None:
        self._assert_exclusive()
        if not self.vault_mode:
            return
        self._dek = vault.unlock_with_password(password, self.root)

    def unlock_cached(self) -> bool:
        """Try the CurrentUser DPAPI cache without exposing cached key material."""
        self._assert_exclusive()
        if not self.vault_mode:
            return True
        dek = vault.load_dek_from_dpapi(self.root)
        if dek is None:
            return False
        try:
            # Authentication is checked before the cached key becomes live.
            vault.read_payload("aug_private", dek, self.root)
        except Exception:
            return False
        self._dek = dek
        return True

    def cache_unlocked(self) -> None:
        """Persist only the unlocked DEK through Windows DPAPI, never the password."""
        if self.vault_mode and self._dek is None:
            raise VaultLockedError("vault 尚未解锁")
        if self._dek is not None:
            vault.cache_dek_dpapi(self._dek, self.root)

    def lock(self) -> None:
        self._dek = None

    def read_all(self) -> dict[str, dict]:
        self._assert_exclusive()
        if self.vault_mode:
            if self._dek is None:
                raise VaultLockedError("vault 尚未解锁")
            return {name: vault.read_payload(name, self._dek, self.root)
                    for name in self.FILENAMES}
        return {name: _read_object(self._plain_path(name), missing_ok=True)
                for name in self.FILENAMES}

    def write_all(self, payloads: dict[str, dict]) -> None:
        self._assert_exclusive()
        values = {name: payloads.get(name, {}) for name in self.FILENAMES}
        if not all(isinstance(value, dict) for value in values.values()):
            raise StoreError("私库 payload 必须是对象")
        if self.vault_mode:
            if self._dek is None:
                raise VaultLockedError("vault 尚未解锁")
            vault.create_or_update(
                self._dek, values["aug_private"], values["char_layers_private"],
                self.root, global_layer=values["global_layer"])
            return
        for name, value in values.items():
            _write_object(self._plain_path(name), value)

    def migrate_reference_metadata(self, config_store: ConfigStore) -> bool:
        """Move legacy public reference filenames/paths into the private blob.

        Older configs stored ``fileName`` in the public preset shell.  The GUI
        now displays both filename and source path, so they must travel with the
        encrypted/private image rather than becoming new public metadata.  The
        private write happens first: a failed public-shell save can only leave a
        harmless duplicate for the next retry, never lose the user's metadata.
        """
        cfg = config_store.load()
        store = cfg.get("augmentation_presets")
        presets = store.get("presets") if isinstance(store, dict) else None
        if not isinstance(presets, list):
            return False
        pending = []
        for preset in presets:
            if not isinstance(preset, dict):
                continue
            preset_id = str(preset.get("id") or "")
            if not preset_id:
                continue
            for ref in preset.get("char_references") or []:
                if not isinstance(ref, dict):
                    continue
                rid = str(ref.get("id") or "")
                file_name = ref.get("fileName", "") or ""
                source_path = ref.get("source_path", "") or ""
                if rid and (file_name or source_path):
                    pending.append((preset_id, ref, rid, file_name, source_path))
        # The normal path after the one-time migration avoids opening the large
        # private image store at all, preserving fast desktop startup.
        if not pending:
            return False
        payloads = self.read_all()
        aug = payloads.get("aug_private")
        if not isinstance(aug, dict):
            raise StoreError("加装私库格式错误")
        for preset_id, ref, rid, file_name, source_path in pending:
            body = aug.get(preset_id)
            if not isinstance(body, dict):
                body = {}
                aug[preset_id] = body
            meta = body.get("charref_meta")
            if not isinstance(meta, dict):
                meta = {}
                body["charref_meta"] = meta
            existing = meta.get(rid)
            if not isinstance(existing, dict):
                existing = {}
                meta[rid] = existing
            if file_name and not existing.get("fileName"):
                existing["fileName"] = file_name
            if source_path and not existing.get("source_path"):
                existing["source_path"] = source_path
            ref["fileName"] = ""
            ref.pop("source_path", None)
        self.write_all(payloads)
        config_store.save(cfg)
        return True

    def delete_augmentation_blob(self, preset_id: str) -> None:
        """Point-delete one preset blob without running either private-store GC."""
        self._assert_exclusive()
        if self.vault_mode:
            payloads = self.read_all()
            payloads["aug_private"].pop(str(preset_id), None)
            self.write_all(payloads)
            return
        path = self._plain_path("aug_private")
        aug_private = _read_object(path, missing_ok=True)
        aug_private.pop(str(preset_id), None)
        _write_object(path, aug_private)

    @staticmethod
    def _preset_shell(cfg: dict, preset_id: str | None) -> dict:
        store = cfg.get("augmentation_presets")
        presets = store.get("presets") if isinstance(store, dict) else None
        if not isinstance(presets, list) or not presets:
            raise StoreError("没有可编辑的预设")
        wanted = preset_id or store.get("activeId")
        preset = next((p for p in presets if isinstance(p, dict) and p.get("id") == wanted), None)
        if preset is None:
            preset = next((p for p in presets if isinstance(p, dict)), None)
        if preset is None:
            raise StoreError("没有可编辑的预设")
        return preset

    def load_preset(self, cfg: dict, preset_id: str | None = None) -> dict:
        """镜像 ``submit_nai._active_preset`` 合并一个预设。"""
        preset = self._preset_shell(cfg, preset_id)
        payloads = self.read_all()
        private = payloads["aug_private"].get(str(preset.get("id")), {})
        if not isinstance(private, dict):
            private = {}
        out = copy.deepcopy(preset)
        for key in ("base_positive", "base_negative"):
            block = out.get(key)
            if isinstance(block, dict) and block.get("isPrivate"):
                block["text"] = private.get(key, "") or ""

        private_chars = private.get("chars") if isinstance(private.get("chars"), dict) else {}
        private_extras = (private.get("char_extras")
                          if isinstance(private.get("char_extras"), dict) else {})
        chars = []
        for source in out.get("chars") or []:
            if not isinstance(source, dict):
                continue
            char = copy.deepcopy(source)
            body = private_chars.get(char.get("id"), {})
            if not isinstance(body, dict):
                body = {}
            if char.get("isPrivate"):
                char["text"] = body.get("text", "") or ""
                char["negative"] = body.get("negative", "") or ""
            if "front_text" in char or "front_text" in body:
                char["front_text"] = body.get("front_text", "") or ""
            if isinstance(char.get("extras"), list):
                for extra in char["extras"]:
                    if isinstance(extra, dict) and extra.get("isPrivate"):
                        extra["text"] = private_extras.get(extra.get("id"), "") or ""
            chars.append(char)
        out["chars"] = chars

        private_extra = private.get("extra") if isinstance(private.get("extra"), dict) else {}
        blocks = []
        for source in out.get("extra_blocks") or []:
            if not isinstance(source, dict):
                continue
            block = copy.deepcopy(source)
            if block.get("isPrivate"):
                block["text"] = private_extra.get(block.get("id"), "") or ""
            blocks.append(block)
        out["extra_blocks"] = blocks

        private_images = (private.get("charref_images")
                          if isinstance(private.get("charref_images"), dict) else {})
        private_meta = (private.get("charref_meta")
                        if isinstance(private.get("charref_meta"), dict) else {})
        refs = out.get("char_references")
        legacy = not isinstance(refs, list)
        if legacy:
            old = out.get("char_reference")
            refs = [old] if isinstance(old, dict) else []
        merged_refs = []
        for source in refs:
            if not isinstance(source, dict):
                continue
            ref = copy.deepcopy(source)
            if ref.get("isPrivate"):
                rid = str(ref.get("id") or "")
                ref["image_b64"] = ((private.get("charref_image", "") or "") if legacy else
                                    (private_images.get(rid, "") or ""))
                meta = private_meta.get(rid, {})
                if not isinstance(meta, dict):
                    meta = {}
                # Public filename values from older configs are accepted once
                # as a migration fallback.  The next save moves both values
                # into the private blob and removes them from the public shell.
                ref["fileName"] = meta.get("fileName", ref.get("fileName", "")) or ""
                ref["source_path"] = meta.get(
                    "source_path", ref.get("source_path", "")) or ""
            merged_refs.append(ref)
        out["char_references"] = merged_refs

        replacements = out.get("replacements")
        if isinstance(replacements, dict):
            bodies = private.get("repl") if isinstance(private.get("repl"), dict) else {}
            rules = []
            for source in replacements.get("rules") or []:
                if not isinstance(source, dict):
                    continue
                rule = copy.deepcopy(source)
                if rule.get("isPrivate"):
                    body = bodies.get(rule.get("id"), {})
                    if isinstance(body, dict):
                        rule["from"] = body.get("from", "") or ""
                        rule["to"] = body.get("to", "") or ""
                        if rule.get("kind") == "delete":
                            rule["word"] = body.get("word", body.get("from", "")) or ""
                rules.append(rule)
            out["replacements"] = {**replacements, "rules": rules}
        return out

    @staticmethod
    def split_preset(merged: dict) -> tuple[dict, dict]:
        """把编辑视图拆成全私化公开壳和 ``aug_private[presetId]`` blob。"""
        shell = copy.deepcopy(merged)
        body: dict[str, Any] = {}
        for key in ("base_positive", "base_negative"):
            block = shell.get(key)
            if isinstance(block, dict):
                body[key] = block.get("text", "") or ""
                block["text"] = ""
                block["isPrivate"] = True

        char_bodies, char_extras = {}, {}
        for char in shell.get("chars") or []:
            if not isinstance(char, dict):
                continue
            cid = str(char.get("id") or "")
            if cid:
                char_bodies[cid] = {
                    "text": char.get("text", "") or "",
                    "negative": char.get("negative", "") or "",
                    "front_text": char.get("front_text", "") or "",
                }
            char["text"], char["negative"], char["front_text"] = "", "", ""
            char["isPrivate"] = True
            for extra in char.get("extras") or []:
                if isinstance(extra, dict):
                    eid = str(extra.get("id") or "")
                    if eid:
                        char_extras[eid] = extra.get("text", "") or ""
                    extra["text"] = ""
                    extra["isPrivate"] = True
        body["chars"] = char_bodies
        body["char_extras"] = char_extras

        extras = {}
        for block in shell.get("extra_blocks") or []:
            if isinstance(block, dict):
                bid = str(block.get("id") or "")
                if bid:
                    extras[bid] = block.get("text", "") or ""
                block["text"] = ""
                block["isPrivate"] = True
        body["extra"] = extras

        images, reference_meta = {}, {}
        for ref in shell.get("char_references") or []:
            if isinstance(ref, dict):
                rid = str(ref.get("id") or "")
                images[rid] = ref.get("image_b64", "") or ""
                if rid:
                    reference_meta[rid] = {
                        "fileName": ref.get("fileName", "") or "",
                        "source_path": ref.get("source_path", "") or "",
                    }
                ref["image_b64"] = ""
                # Keep the historical empty shell key because submit_nai's
                # faithful payload shape includes it; only the value is secret.
                ref["fileName"] = ""
                ref.pop("source_path", None)
                ref["isPrivate"] = True
                ref.setdefault("side", "front")
        body["charref_images"] = images
        body["charref_meta"] = reference_meta
        shell.pop("char_reference", None)

        repl_bodies = {}
        replacements = shell.get("replacements")
        if isinstance(replacements, dict):
            for rule in replacements.get("rules") or []:
                if not isinstance(rule, dict):
                    continue
                rid = str(rule.get("id") or "")
                kind = rule.get("kind") or "replace"
                if rid:
                    if kind == "delete":
                        repl_bodies[rid] = {"word": rule.get("word", rule.get("from", "")) or ""}
                    else:
                        repl_bodies[rid] = {"from": rule.get("from", "") or "",
                                           "to": rule.get("to", "") or ""}
                rule["from"], rule["to"] = "", ""
                if "word" in rule or kind == "delete":
                    rule["word"] = ""
                rule["isPrivate"] = True
                rule.setdefault("kind", kind)
                rule.setdefault("scope", "all")
        body["repl"] = repl_bodies
        return shell, body

    def save_preset(self, config_store: ConfigStore, cfg: dict, merged: dict) -> dict:
        preset_id = str(merged.get("id") or "")
        if not preset_id:
            raise StoreError("预设缺少 id")
        shell, body = self.split_preset(merged)
        new_cfg = copy.deepcopy(cfg)
        store = new_cfg.get("augmentation_presets")
        presets = store.get("presets") if isinstance(store, dict) else None
        if not isinstance(presets, list):
            raise StoreError("预设公开壳格式错误")
        for index, old in enumerate(presets):
            if isinstance(old, dict) and str(old.get("id") or "") == preset_id:
                presets[index] = shell
                break
        else:
            presets.append(shell)
        payloads = self.read_all()
        payloads["aug_private"][preset_id] = body
        self.write_all(payloads)
        config_store.save(new_cfg)
        return new_cfg

    def load_global(self, cfg: dict) -> dict:
        shell = cfg.get("global_layer")
        shell = copy.deepcopy(shell) if isinstance(shell, dict) else {"enabled": False, "rules": []}
        private = self.read_all()["global_layer"]
        bodies = private.get("rules") if isinstance(private.get("rules"), dict) else private
        if not isinstance(bodies, dict):
            bodies = {}
        rules = []
        for source in shell.get("rules") or []:
            if not isinstance(source, dict):
                continue
            rule = copy.deepcopy(source)
            body = bodies.get(str(rule.get("id") or ""), {})
            if not isinstance(body, dict):
                body = {}
            if (rule.get("kind") or "replace") == "delete":
                rule["word"] = body.get("word", "") or ""
            else:
                rule["from"] = body.get("from", "") or ""
                rule["to"] = body.get("to", "") or ""
            rules.append(rule)
        shell["rules"] = rules
        return shell

    def save_global(self, config_store: ConfigStore, cfg: dict, merged: dict) -> dict:
        shell = {"enabled": bool(merged.get("enabled")), "rules": []}
        bodies = {}
        for source in merged.get("rules") or []:
            if not isinstance(source, dict):
                continue
            rule = copy.deepcopy(source)
            rid = str(rule.get("id") or "")
            if not rid:
                raise StoreError("全局规则缺少 id")
            kind = rule.get("kind") or "replace"
            shell["rules"].append({"id": rid, "kind": kind,
                                   "scope": rule.get("scope") or "all",
                                   "enabled": bool(rule.get("enabled", True))})
            bodies[rid] = ({"word": rule.get("word", "") or ""} if kind == "delete" else
                           {"from": rule.get("from", "") or "", "to": rule.get("to", "") or ""})
        new_cfg = copy.deepcopy(cfg)
        new_cfg["global_layer"] = shell
        payloads = self.read_all()
        payloads["global_layer"] = {"rules": bodies}
        self.write_all(payloads)
        config_store.save(new_cfg)
        return new_cfg


def delete_preset(config_store: ConfigStore, cfg: dict, preset_id: str,
                  private_store: PrivateStore | None = None) -> dict:
    """Delete one public shell and exactly its own augmentation-private blob.

    ``char_layers_private`` is deliberately outside this operation.  The optional
    store lets the GUI reuse an unlocked vault; plain-file callers need only the
    three arguments from the public contract.
    """
    new_cfg = copy.deepcopy(cfg)
    store = new_cfg.get("augmentation_presets")
    presets = store.get("presets") if isinstance(store, dict) else None
    if not isinstance(presets, list):
        raise StoreError("预设公开壳格式错误")
    wanted = str(preset_id)
    remaining = [p for p in presets
                 if not (isinstance(p, dict) and str(p.get("id") or "") == wanted)]
    if len(remaining) == len(presets):
        raise StoreError("没有找到要删除的预设")
    store["presets"] = remaining
    if str(store.get("activeId") or "") == wanted:
        first_enabled = next((p for p in remaining
                              if isinstance(p, dict) and p.get("enabled") is not False), None)
        store["activeId"] = first_enabled.get("id") if first_enabled else None
    private = private_store or PrivateStore(config_store.root)
    private.delete_augmentation_blob(wanted)
    config_store.save(new_cfg)
    return new_cfg


class TerminalConfig:
    """``data/terminal/config.json`` 中 GUI 可编辑的本机设置。"""

    def __init__(self, root: str | os.PathLike[str]):
        self.root = Path(root)
        self.path = self.root / "data/terminal/config.json"

    def load(self) -> dict:
        value = _read_object(self.path, missing_ok=True)
        override = value.get("clean_override")
        # ``clean_override`` is the legacy on-disk key.  The GUI no longer has a
        # three-state override: a missing/old-null/invalid value migrates to Off.
        enabled = override if type(override) is bool else False
        return {**value,
                "meta_archive_dir": value.get("meta_archive_dir", ""),
                "clean_override": enabled,
                "ui_theme": (value.get("ui_theme") if value.get("ui_theme") in VALID_UI_THEMES
                             else "auto")}

    def save(self, *, meta_archive_dir: str, clean_override: bool,
             ui_theme: str | None = None) -> None:
        if type(clean_override) is not bool:
            raise StoreError("Clean 开关必须是 true 或 false")
        value = _read_object(self.path, missing_ok=True)
        value["meta_archive_dir"] = str(meta_archive_dir).strip()
        value["clean_override"] = clean_override
        if ui_theme is not None:
            if ui_theme not in VALID_UI_THEMES:
                raise StoreError("ui_theme 必须是 auto、light 或 dark")
            value["ui_theme"] = ui_theme
        _write_object(self.path, value)


class QueueClient:
    """只访问本机 NAI terminal 控制端点的 urllib 客户端。"""

    def __init__(self, root: str | os.PathLike[str],
                 base_url: str = "http://localhost:8747", timeout: float = 3.0):
        self.root = Path(root)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _token(self) -> str:
        try:
            token = (self.root / "data/terminal_token").read_text("utf-8").strip()
        except OSError:
            raise QueueUnavailable("终端未启动") from None
        if not token:
            raise QueueUnavailable("终端未启动")
        return token

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        raw = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self.base_url + path, data=raw, method=method,
            headers={"Authorization": "Bearer " + self._token(),
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            raise QueueUnavailable("终端未启动") from None
        if not isinstance(value, dict):
            raise QueueUnavailable("终端响应格式错误")
        return value

    def queue(self) -> dict:
        return self._request("GET", "/v1/queue")

    def jobs(self, limit: int = 100) -> dict:
        return self._request("GET", "/v1/jobs?" + urllib.parse.urlencode({"limit": limit}))

    def job(self, job_id: str) -> dict:
        return self._request("GET", f"/v1/jobs/{job_id}")

    def cancel(self, job_id: str) -> dict:
        return self._request("POST", f"/v1/jobs/{job_id}/cancel", {})

    def priority(self, job_id: str, sort_key: float) -> dict:
        return self._request("POST", f"/v1/jobs/{job_id}/priority", {"sort_key": sort_key})

    def resume(self, job_id: str) -> dict:
        return self._request("POST", f"/v1/jobs/{job_id}/resume", {})

    def pause(self, paused: bool) -> dict:
        return self._request("POST", "/v1/queue/pause", {"paused": bool(paused)})

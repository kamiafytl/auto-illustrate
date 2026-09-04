"""Private-preset vault (vault.v1).

Passwords are used only to derive a KEK; payloads and reference blobs are encrypted
with a random DEK.  Secrets are deliberately excluded from exception messages.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_REL = Path("data/vault/presets.env.json")
DPAPI_REL = Path("data/terminal/dek.dpapi")
KDF_N, KDF_R, KDF_P = 2**15, 8, 1
PAYLOAD_NAMES = ("aug_private", "char_layers_private", "global_layer")

# 常驻 worker 的解密缓存。key 只含项目路径和 payload 名；value 只活在本进程内，
# 不写日志、不经 HTTP。revision 是【密文 envelope】的 SHA-256，因此 GUI 原子换档后
# 下一次读取会自动失效，同时未改动时不重复解密正文。
_PAYLOAD_CACHE_LOCK = threading.RLock()
_PAYLOAD_CACHE: dict[tuple[str, str], tuple[bytes, bytes, dict]] = {}


class VaultAuthError(Exception):
    """The supplied vault password did not authenticate."""


def _root(root: str | os.PathLike[str] | None) -> Path:
    return Path(root) if root is not None else PROJECT_ROOT


def _env_path(root=None) -> Path:
    return _root(root) / ENV_REL


def invalidate_payload_cache(root=None) -> None:
    """丢弃某项目的进程内明文缓存（保存端可显式调用；跨进程另由 revision 检测）。"""
    root_key = str(_root(root).resolve())
    with _PAYLOAD_CACHE_LOCK:
        for key in [k for k in _PAYLOAD_CACHE if k[0] == root_key]:
            del _PAYLOAD_CACHE[key]


def vault_exists(root=None) -> bool:
    return _env_path(root).is_file()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.b64decode(value, validate=True)


def _derive_kek(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=KDF_N,
                          r=KDF_R, p=KDF_P, dklen=32, maxmem=128 * 1024 * 1024)


def _seal_json(value: dict, dek: bytes) -> dict[str, str]:
    nonce = os.urandom(12)
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return {"nonce_b64": _b64(nonce), "ct_b64": _b64(AESGCM(dek).encrypt(nonce, raw, None))}


def _open_json(box: dict, dek: bytes) -> dict:
    raw = AESGCM(dek).decrypt(_unb64(box["nonce_b64"]), _unb64(box["ct_b64"]), None)
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("vault payload is not an object")
    return value


def _unique_ref_id(wanted: str, raw: bytes, used: dict[str, bytes]) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in wanted) or "ref"
    candidate = safe
    if candidate in used and used[candidate] != raw:
        candidate = f"{safe}-{hashlib.sha256(raw).hexdigest()[:12]}"
    used[candidate] = raw
    return candidate


def _extract_refs(value: Any, used: dict[str, bytes]) -> Any:
    if isinstance(value, list):
        return [_extract_refs(v, used) for v in value]
    if not isinstance(value, dict):
        return value
    out = {}
    for key, item in value.items():
        if key == "charref_images" and isinstance(item, dict):
            images = {}
            for ref_id, b64_value in item.items():
                if isinstance(b64_value, str):
                    raw = _unb64(b64_value)
                    rid = _unique_ref_id(str(ref_id), raw, used)
                    images[ref_id] = {"__vault_ref__": rid}
                else:
                    images[ref_id] = _extract_refs(b64_value, used)
            out[key] = images
        elif key == "charref_image" and isinstance(item, str):
            raw = _unb64(item)
            rid = _unique_ref_id("legacy-" + hashlib.sha256(raw).hexdigest()[:16], raw, used)
            out[key] = {"__vault_ref__": rid}
        else:
            out[key] = _extract_refs(item, used)
    return out


def _restore_refs(value: Any, dek: bytes, env: dict, root: Path) -> Any:
    if isinstance(value, list):
        return [_restore_refs(v, dek, env, root) for v in value]
    if not isinstance(value, dict):
        return value
    if list(value) == ["__vault_ref__"]:
        rid = value["__vault_ref__"]
        rel = env["refs"][rid]["file"]
        blob = (root / "data/vault" / rel).read_bytes()
        if len(blob) < 13:
            raise ValueError("invalid vault ref blob")
        raw = AESGCM(dek).decrypt(blob[:12], blob[12:], None)
        return _b64(raw)
    return {k: _restore_refs(v, dek, env, root) for k, v in value.items()}


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def create_or_update(password_or_dek, aug_private: dict, char_layers: dict, root=None,
                     global_layer: dict | None = None):
    """Create/update a vault and return its DEK.

    A bytes DEK is accepted for offline/test updates of an existing vault; its
    existing password wrapping metadata is retained.
    """
    root_path = _root(root)
    path = _env_path(root_path)
    if path.exists():
        _atomic_write(path.with_name(path.name + ".prev"), path.read_bytes())
    old = json.loads(path.read_text("utf-8")) if path.exists() else None
    if isinstance(password_or_dek, (bytes, bytearray)):
        dek = bytes(password_or_dek)
        if len(dek) != 32 or old is None:
            raise ValueError("a 32-byte DEK can update only an existing vault")
        kdf, wrapped = old["kdf"], old["wrapped_dek"]
    elif isinstance(password_or_dek, str):
        dek = os.urandom(32)
        salt, nonce = os.urandom(16), os.urandom(12)
        kek = _derive_kek(password_or_dek, salt)
        wrapped = {"nonce_b64": _b64(nonce), "ct_b64": _b64(AESGCM(kek).encrypt(nonce, dek, None))}
        kdf = {"alg": "scrypt", "salt_b64": _b64(salt), "n": KDF_N, "r": KDF_R, "p": KDF_P}
    else:
        raise TypeError("password_or_dek must be str or bytes")

    refs: dict[str, bytes] = {}
    aug = _extract_refs(aug_private, refs)
    chars = _extract_refs(char_layers, refs)
    global_rules = _extract_refs(global_layer or {}, refs)
    refs_dir = root_path / "data/vault/refs"
    ref_index = {}
    for rid, raw in refs.items():
        nonce = os.urandom(12)
        _atomic_write(refs_dir / f"{rid}.enc", nonce + AESGCM(dek).encrypt(nonce, raw, None))
        ref_index[rid] = {"file": f"refs/{rid}.enc"}
    env = {
        "version": "vault.v1", "kdf": kdf, "wrapped_dek": wrapped,
        "payloads": {"aug_private": _seal_json(aug, dek),
                     "char_layers_private": _seal_json(chars, dek),
                     "global_layer": _seal_json(global_rules, dek)},
        "refs": ref_index,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write(path, (json.dumps(env, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    invalidate_payload_cache(root_path)
    return dek


def unlock_with_password(password: str, root=None) -> bytes:
    try:
        env = json.loads(_env_path(root).read_text("utf-8"))
        kdf = env["kdf"]
        if kdf.get("alg") != "scrypt":
            raise ValueError("unsupported vault KDF")
        kek = hashlib.scrypt(password.encode("utf-8"), salt=_unb64(kdf["salt_b64"]),
                             n=int(kdf["n"]), r=int(kdf["r"]), p=int(kdf["p"]),
                             dklen=32, maxmem=128 * 1024 * 1024)
        box = env["wrapped_dek"]
        return AESGCM(kek).decrypt(_unb64(box["nonce_b64"]), _unb64(box["ct_b64"]), None)
    except InvalidTag as exc:
        raise VaultAuthError("vault password authentication failed") from None


def cache_dek_dpapi(dek: bytes, root=None) -> None:
    if len(dek) != 32:
        raise ValueError("DEK must be 32 bytes")
    script = ("Add-Type -AssemblyName System.Security; "
              f"$d=[Convert]::FromBase64String('{_b64(dek)}'); "
              "$p=[Security.Cryptography.ProtectedData]::Protect($d,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
              "[Convert]::ToBase64String($p)")
    try:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script],
                                capture_output=True, text=True, check=True)
    except Exception:
        # CalledProcessError includes the command (and therefore the DEK argument).
        raise RuntimeError("DPAPI protection failed") from None
    protected = result.stdout.strip()
    base64.b64decode(protected, validate=True)
    _atomic_write(_root(root) / DPAPI_REL, (protected + "\n").encode("ascii"))


def load_dek_from_dpapi(root=None) -> bytes | None:
    path = _root(root) / DPAPI_REL
    if not path.exists():
        return None
    try:
        protected = path.read_text("ascii").strip()
        base64.b64decode(protected, validate=True)
        script = ("Add-Type -AssemblyName System.Security; "
                  f"$p=[Convert]::FromBase64String('{protected}'); "
                  "$d=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
                  "[Convert]::ToBase64String($d)")
        result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script],
                                capture_output=True, text=True, check=True)
        dek = base64.b64decode(result.stdout.strip(), validate=True)
        return dek if len(dek) == 32 else None
    except Exception:
        return None


def read_payload(name: str, dek: bytes, root=None) -> dict:
    if name not in PAYLOAD_NAMES:
        raise KeyError(name)
    root_path = _root(root)
    env = json.loads(_env_path(root_path).read_text("utf-8"))
    # vault.v1 旧 envelope 没有第三 payload；全局层默认关闭时视为空正文，原 vault 可原样解锁。
    if name == "global_layer" and name not in env.get("payloads", {}):
        return {}
    value = _open_json(env["payloads"][name], dek)
    return _restore_refs(value, dek, env, root_path)


def read_payload_cached(name: str, dek: bytes, root=None) -> dict:
    """读取私密 payload，并按密文 envelope revision 自动复用/失效。

    每次只读取并哈希密文 envelope；正文只在 revision 或 DEK 真正变化时解密。
    GUI 的 ``create_or_update`` 使用原子换档且每次重封 payload，所以跨进程的常驻
    worker 无需重启，也无需开放任何「读私密正文」接口。
    """
    if name not in PAYLOAD_NAMES:
        raise KeyError(name)
    root_path = _root(root)
    raw = _env_path(root_path).read_bytes()
    revision = hashlib.sha256(raw).digest()
    dek_id = hashlib.sha256(b"nai-terminal-vault-cache\0" + bytes(dek)).digest()
    key = (str(root_path.resolve()), name)
    with _PAYLOAD_CACHE_LOCK:
        cached = _PAYLOAD_CACHE.get(key)
        if cached is not None and cached[0] == revision and cached[1] == dek_id:
            return cached[2]

    env = json.loads(raw.decode("utf-8"))
    if name == "global_layer" and name not in env.get("payloads", {}):
        value = {}
    else:
        value = _open_json(env["payloads"][name], dek)
        value = _restore_refs(value, dek, env, root_path)
    with _PAYLOAD_CACHE_LOCK:
        # 同一 root/name 永远只留一份正文，换档立即释放旧引用。
        _PAYLOAD_CACHE[key] = (revision, dek_id, value)
    return value

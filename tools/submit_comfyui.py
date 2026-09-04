#!/usr/bin/env python3
"""ComfyUI提交工具 — 方案C核心脚本

合并公开prompt + 隐私prompt → 提交到ComfyUI。
CC调用此脚本提交workflow，隐私block从文件注入，不进CC上下文。

用法:
  python3 tools/submit_comfyui.py submit <workflow.json>          # 提交并立即返回
  python3 tools/submit_comfyui.py submit <workflow.json> --wait   # 提交并等待完成
"""
import json
import sys
import time
import re
import urllib.request
import urllib.error
from pathlib import Path

TOOLS_DIR = Path(__file__).parent
PROJECT_ROOT = TOOLS_DIR.parent
CONFIG_PATH = TOOLS_DIR / "comfyui_env.json"
PRIVATE_BLOCKS_PATH = PROJECT_ROOT / "data" / "private_blocks.json"

WAIT_POLL_INTERVAL = 2  # 秒
WAIT_TIMEOUT = 10 * 60  # 10分钟


def get_windows_host_ip() -> str:
    try:
        with open("/etc/resolv.conf") as f:
            for line in f:
                if line.strip().startswith("nameserver"):
                    return line.strip().split()[1]
    except FileNotFoundError:
        pass
    return "localhost"


def get_comfyui_url() -> str:
    with open(CONFIG_PATH) as f:
        config = json.load(f)
    env = config["env"]
    url = config[env]["comfyui_url"]
    if "{{WINDOWS_HOST_IP}}" in url:
        url = url.replace("{{WINDOWS_HOST_IP}}", get_windows_host_ip())
    return url.rstrip("/")


def api_get(path: str) -> dict:
    url = f"{get_comfyui_url()}{path}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def api_post(path: str, data: dict) -> dict:
    url = f"{get_comfyui_url()}{path}"
    payload = json.dumps(data).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def load_private_blocks() -> dict:
    """读取隐私block文件，返回 {block_key: text} 字典"""
    if not PRIVATE_BLOCKS_PATH.exists():
        return {}
    try:
        data = json.loads(PRIVATE_BLOCKS_PATH.read_text("utf-8"))
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, IOError):
        pass
    return {}


def inject_private_blocks(workflow: dict, private_blocks: dict) -> int:
    """扫描workflow所有节点的text字段，替换 __PRIVATE_xxx__ 占位符。

    占位符格式: __PRIVATE_style__, __PRIVATE_character__ 等
    替换规则:
    - 如果text只包含占位符: 替换为隐私block文本
    - 如果text包含公开内容+占位符: 公开内容保留，占位符替换为隐私文本，用逗号连接

    返回替换的占位符数量。
    """
    pattern = re.compile(r"__PRIVATE_(\w+)__")
    replaced = 0

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        text = inputs.get("text")
        if not isinstance(text, str):
            continue

        matches = pattern.findall(text)
        if not matches:
            continue

        new_text = text
        for block_key in matches:
            placeholder = f"__PRIVATE_{block_key}__"
            private_text = private_blocks.get(block_key, "")
            new_text = new_text.replace(placeholder, private_text)
            replaced += 1

        # 清理多余逗号和空格
        new_text = re.sub(r",\s*,", ",", new_text)
        new_text = re.sub(r"^\s*,\s*", "", new_text)
        new_text = re.sub(r"\s*,\s*$", "", new_text)
        new_text = new_text.strip()

        inputs["text"] = new_text

    return replaced


def wait_for_completion(prompt_id: str) -> bool:
    """轮询等待指定prompt完成。返回True=成功，False=失败/超时。"""
    start = time.time()
    while time.time() - start < WAIT_TIMEOUT:
        time.sleep(WAIT_POLL_INTERVAL)
        try:
            history = api_get(f"/history/{prompt_id}")
            if prompt_id in history:
                entry = history[prompt_id]
                status = entry.get("status", {})
                if status.get("completed", False):
                    return True
                if status.get("status_str") == "error":
                    print(f"✗ 执行出错", file=sys.stderr)
                    msgs = status.get("messages", [])
                    for msg in msgs:
                        if isinstance(msg, list) and len(msg) >= 2:
                            print(f"  {msg[0]}: {msg[1]}", file=sys.stderr)
                    return False
        except urllib.error.URLError:
            pass  # ComfyUI可能还在处理，继续等
    print(f"✗ 等待超时（{WAIT_TIMEOUT}秒）", file=sys.stderr)
    return False


def cmd_submit(workflow_path: str, wait: bool = False):
    """提交workflow到ComfyUI，自动注入隐私block。"""
    # 1. 读取workflow
    with open(workflow_path) as f:
        workflow = json.load(f)

    # 2. 读取隐私blocks
    private_blocks = load_private_blocks()

    # 3. 注入隐私block
    injected = inject_private_blocks(workflow, private_blocks)
    if injected > 0:
        print(f"  隐私block注入: {injected}个占位符已替换")

    # 4. 提交到ComfyUI
    try:
        result = api_post("/prompt", {"prompt": workflow})
        prompt_id = result.get("prompt_id", "?")
        print(f"✓ 已提交到ComfyUI")
        print(f"  prompt_id: {prompt_id}")
    except urllib.error.URLError as e:
        print(f"✗ 提交失败: {e}", file=sys.stderr)
        sys.exit(1)

    # 5. 可选等待完成
    if wait:
        print(f"  等待完成中...")
        success = wait_for_completion(prompt_id)
        if success:
            print(f"✓ 执行完成")
        else:
            sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd == "submit":
        if len(sys.argv) < 3:
            print("用法: submit_comfyui.py submit <workflow.json> [--wait]")
            sys.exit(1)
        workflow_path = sys.argv[2]
        wait = "--wait" in sys.argv[3:]
        cmd_submit(workflow_path, wait)
    else:
        print(f"未知命令: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()

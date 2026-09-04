#!/usr/bin/env python3
"""轻量机翻服务：本地零依赖 HTTP 服务 + 单页界面，走 DeepSeek OpenAI 兼容接口。

设计要点：
- 只用标准库（http.server + urllib），启动 <1s，不依赖 webapp/vite。
- api_key 只在服务端读取，绝不下发浏览器（同 webapp translate 插件的红线）。
- 流式（SSE）转发，边翻边显示；末包带 usage，界面按 DeepSeek 价目估算花费。
- 与 data/translation_config.json（tag 翻译用的旧 key）完全隔离，各用各的额度。

用法：
    python3 tools/mt/server.py            # 前台启动，默认 http://127.0.0.1:8848
    python3 tools/mt/server.py --port 9000 --open
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "data" / "mt_config.json"
INDEX_PATH = Path(__file__).resolve().parent / "index.html"

# 目标语言 → 给模型的指令片段（auto 由服务端先判语种，再落到下面某一条，绝不让模型自己猜）
TARGETS: dict[str, str] = {
    "zh": "译成简体中文。",
    "ja": "译成自然地道的日语（普通の日本語表現、直訳臭を避ける）。",
    "en": "译成自然的英语。",
}

LANG_NAMES = {"ja": "日语", "zh": "中文", "en": "英语", "ko": "韩语", "ru": "俄语", "unknown": "未知"}

# auto 模式的方向表：源语种 → 目标语种。中日互译，其余一律进中文。
AUTO_ROUTE = {"ja": "zh", "zh": "ja", "en": "zh", "ko": "zh", "ru": "zh", "unknown": "zh"}

# 日语特有的新字体汉字/记号：出现即可判日语（简体与繁体中文都没有这些字形）。
# 用于「整句无假名的日语」这一唯一盲区，如「今日出発」。
JP_ONLY = set("々〆ヶ〻円発売駅変対実図広価伝働仮沢桜経済会党区帰応学覚渋歴戦鉄医")


def detect_lang(text: str) -> str:
    """确定性语种判定（不调模型）。规则按优先级短路，任何一步命中即返回。"""
    kana = hangul = cyrillic = han = latin = 0
    jp_only_hit = False
    for ch in text:
        code = ord(ch)
        if 0x3040 <= code <= 0x30FF and code != 0x30FB:      # 平假名 + 片假名（排除中点・）
            kana += 1
        elif 0xAC00 <= code <= 0xD7AF or 0x1100 <= code <= 0x11FF:
            hangul += 1
        elif 0x0400 <= code <= 0x04FF:
            cyrillic += 1
        elif 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            han += 1
            if ch in JP_ONLY:
                jp_only_hit = True
        elif ch.isascii() and ch.isalpha():
            latin += 1

    if kana:                       # 出现假名 = 日语，中日混排也判日语
        return "ja"
    if hangul:
        return "ko"
    if jp_only_hit:                # 无假名但有日语专用字形
        return "ja"
    if han:                        # 纯汉字 = 中文
        return "zh"
    if cyrillic:
        return "ru"
    if latin:
        return "en"
    return "unknown"

SYSTEM_PROMPT = (
    "你是一台高质量机器翻译引擎，服务于创作与平台运营场景。规则：\n"
    "1. 只输出译文本身，不加解释、不加引号、不加“译文：”之类前缀，不加评论。\n"
    "2. 忠实原意与语气，保留原文的换行、列表、编号、标点风格与占位符（如 __PRIVATE_xxx__、{name}、<tag>）原样不译。\n"
    "3. 专有名词（作品名/平台名/角色名）优先用通行译名，没有通行译名才保留原文；行业术语要译（如「立ち絵」→「立绘」「差分」→「差分图」）。\n"
    "4. 除占位符与无通行译名的专有名词外，必须逐句翻译，禁止把输入原样返回。\n"
    "5. 输入若本身已是目标语言，则做润色级的同语言改写，不要拒绝作答。\n"
)

# 元/百万 token（DeepSeek 官方价目，估算用，非精确账单）
PRICING = {
    "deepseek-v4-flash": {"in": 0.5, "out": 1.5},
    "deepseek-v4-pro": {"in": 3.0, "out": 12.0},
}


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"缺配置文件：{CONFIG_PATH}\n请写入 {{\"api_key\": \"sk-...\"}}")
    except json.JSONDecodeError as exc:
        sys.exit(f"配置文件不是合法 JSON：{CONFIG_PATH}（{exc}）")
    key = os.environ.get("DEEPSEEK_API_KEY") or cfg.get("api_key", "")
    if not key or key.startswith("待"):
        sys.exit(f"配置里没有可用 api_key：{CONFIG_PATH}")
    cfg["api_key"] = key
    cfg.setdefault("base_url", "https://api.deepseek.com")
    cfg.setdefault("chat_completions_path", "/chat/completions")
    cfg.setdefault("model", "deepseek-v4-flash")
    cfg.setdefault("model_options", list(PRICING))
    return cfg


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    config: dict = {}

    # 默认日志太吵，只留错误
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        pass

    # ---------- 基础响应工具 ----------
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data: dict) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    # ---------- 路由 ----------
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            try:
                self._send(200, INDEX_PATH.read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"index.html missing", "text/plain; charset=utf-8")
        elif path == "/api/meta":
            self._json(200, {"model": self.config["model"], "model_options": self.config["model_options"], "pricing": PRICING})
        elif path == "/api/balance":
            self._balance()
        else:
            self._send(404, b"not found", "text/plain; charset=utf-8")

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/api/translate":
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "请求体不是合法 JSON"})
            return
        text = (payload.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "text 为空"})
            return
        target = payload.get("target")
        if target not in TARGETS:
            target = "auto"
        model = payload.get("model") if payload.get("model") in self.config["model_options"] else self.config["model"]
        extra = (payload.get("note") or "").strip()
        self._translate_stream(text, target, model, extra)

    # ---------- 具体实现 ----------
    def _api_request(self, path: str, body: dict | None = None) -> urllib.request.Request:
        url = self.config["base_url"].rstrip("/") + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
        req.add_header("Authorization", f"Bearer {self.config['api_key']}")
        if data:
            req.add_header("Content-Type", "application/json")
        return req

    def _balance(self) -> None:
        try:
            with urllib.request.urlopen(self._api_request("/user/balance"), timeout=15) as resp:
                data = json.loads(resp.read())
            info = (data.get("balance_infos") or [{}])[0]
            self._json(200, {"balance": info.get("total_balance"), "currency": info.get("currency", "CNY")})
        except Exception as exc:  # noqa: BLE001 — 余额只是装饰，失败不该影响翻译
            self._json(200, {"error": str(exc)[:200]})

    def _sse(self, event: str, data: dict) -> None:
        self.wfile.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _translate_stream(self, text: str, target: str, model: str, extra: str) -> None:
        # 源语种一律由服务端判定：auto 时决定译向，手动时只用于界面显示
        src_lang = detect_lang(text)
        tgt_lang = AUTO_ROUTE[src_lang] if target == "auto" else target
        instruction = TARGETS[tgt_lang]
        if src_lang == tgt_lang:
            instruction += "（输入已是目标语言，做润色级改写即可）"
        if extra:
            instruction += f"\n补充要求：{extra}"
        body = {
            "model": model,
            "temperature": 1.0,
            "stream": True,
            "stream_options": {"include_usage": True},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT + "\n本次任务：" + instruction},
                {"role": "user", "content": text},
            ],
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self._sse("lang", {
            "src": src_lang, "tgt": tgt_lang,
            "src_name": LANG_NAMES.get(src_lang, src_lang), "tgt_name": LANG_NAMES.get(tgt_lang, tgt_lang),
            "auto": target == "auto",
        })
        try:
            with urllib.request.urlopen(self._api_request(self.config["chat_completions_path"], body), timeout=180) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        obj = json.loads(chunk)
                    except json.JSONDecodeError:
                        continue
                    choices = obj.get("choices") or []
                    if choices:
                        piece = (choices[0].get("delta") or {}).get("content")
                        if piece:
                            self._sse("delta", {"t": piece})
                    if obj.get("usage"):
                        self._sse("usage", obj["usage"])
            self._sse("done", {"model": model})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            self._sse("error", {"message": f"DeepSeek {exc.code}: {detail}"})
        except Exception as exc:  # noqa: BLE001
            self._sse("error", {"message": str(exc)[:300]})
        finally:
            self.close_connection = True


def main() -> None:
    parser = argparse.ArgumentParser(description="轻量机翻服务（DeepSeek）")
    parser.add_argument("--port", type=int, default=8848)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    Handler.config = load_config()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"[机翻] 已启动 → {url}   模型 {Handler.config['model']}   Ctrl+C 停止", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[机翻] 已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

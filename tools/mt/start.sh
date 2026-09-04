#!/usr/bin/env bash
# 轻量机翻界面：启动本地服务并在 Windows 默认浏览器打开。
# 已在跑就不重复起，直接开页面（随时点、随时用）。
set -u
PORT="${MT_PORT:-8848}"
URL="http://127.0.0.1:${PORT}/"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! curl -s -m 2 -o /dev/null "${URL}api/meta"; then
  nohup python3 "$ROOT/tools/mt/server.py" --port "$PORT" >"$ROOT/tools/mt/.server.log" 2>&1 &
  for _ in $(seq 1 30); do
    curl -s -m 1 -o /dev/null "${URL}api/meta" && break
    sleep 0.2
  done
fi

if command -v explorer.exe >/dev/null 2>&1; then
  explorer.exe "$URL" >/dev/null 2>&1 || true   # WSL：交给 Windows 默认浏览器
else
  python3 -m webbrowser "$URL" >/dev/null 2>&1 || true
fi
echo "[机翻] $URL"

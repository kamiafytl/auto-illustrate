#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图片文件夹批量高清放大（ComfyUI 4x 放大模型）。

链路：上传源图 → UpscaleModelLoader + ImageUpscaleWithModel（x4）
      → SaveImage(x4) / ImageScaleBy 0.5 → SaveImage(x2)
      → 经 /view 取回写入输出目录（默认=源文件夹并列命名 <名>_x4.png / <名>_x2.png；
      给 --outdir-x4/--outdir-x2 则分目录落盘、文件名保持原名）。
x2 即 x4 缩小一倍（lanczos），不另跑模型 —— 与 psd_batch_upscale.py 同手法。

注意：过 ComfyUI 后输出为 RGB，NAI 的 alpha LSB 隐写 meta 会消失（原图保留在源夹，考古走原图）。

用法:
  python3 tools/comfyui_batch_upscale.py --dir "<图片夹>"
  python3 tools/comfyui_batch_upscale.py --dir "<...>" --only-x4
  python3 tools/comfyui_batch_upscale.py --dir "<...>" --outdir-x4 "<夹>/x4" --outdir-x2 "<夹>/x2"
细则见 internal-docs / creation_env.md。
"""
import argparse, json, sys, time, urllib.request, urllib.parse, uuid
from pathlib import Path

EXTS = {".png", ".jpg", ".jpeg", ".webp"}
SUFFIXES = ("_x4", "_x2")

IP = next(l.split()[1] for l in open("/etc/resolv.conf") if l.strip().startswith("nameserver"))
CU = f"http://{IP}:8188"


def cu_upload(path: Path, subfolder: str) -> str:
    b = uuid.uuid4().hex
    data = path.read_bytes()
    body = b""
    for k, v in [(b"subfolder", subfolder.encode()), (b"overwrite", b"true")]:
        body += b"--" + b.encode() + b"\r\nContent-Disposition: form-data; name=\"" + k + b"\"\r\n\r\n" + v + b"\r\n"
    body += b"--" + b.encode() + b"\r\nContent-Disposition: form-data; name=\"image\"; filename=\"" + path.name.encode() + b"\"\r\n"
    body += b"Content-Type: image/png\r\n\r\n" + data + b"\r\n--" + b.encode() + b"--\r\n"
    req = urllib.request.Request(CU + "/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.loads(r.read())
        return (j.get("subfolder", "") + "/" + j["name"]).lstrip("/")


def build_wf(img_ref: str, model: str, want_x2: bool) -> dict:
    wf = {
        "1": {"class_type": "LoadImage", "inputs": {"image": img_ref}},
        "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model}},
        "3": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "owner_upscale/x4"}},
    }
    if want_x2:
        wf["5"] = {"class_type": "ImageScaleBy",
                   "inputs": {"image": ["3", 0], "upscale_method": "lanczos", "scale_by": 0.5}}
        wf["6"] = {"class_type": "SaveImage", "inputs": {"images": ["5", 0], "filename_prefix": "owner_upscale/x2"}}
    return wf


def cu_submit(wf: dict) -> str:
    payload = json.dumps({"prompt": wf, "client_id": uuid.uuid4().hex}).encode()
    req = urllib.request.Request(CU + "/prompt", data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["prompt_id"]


def cu_wait(pid: str, timeout: int = 900) -> dict:
    """返回 {节点id: [image_info,...]}"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        with urllib.request.urlopen(CU + f"/history/{pid}", timeout=30) as r:
            h = json.loads(r.read())
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI 执行失败: {json.dumps(st, ensure_ascii=False)[:500]}")
            outs = {nid: node.get("images", []) for nid, node in h[pid].get("outputs", {}).items()}
            if any(outs.values()):
                return outs
        time.sleep(2)
    raise TimeoutError(f"等待超时: {pid}")


def cu_fetch(im: dict, dest: Path) -> None:
    q = urllib.parse.urlencode({"filename": im["filename"],
                                "subfolder": im.get("subfolder", ""),
                                "type": im.get("type", "output")})
    with urllib.request.urlopen(CU + "/view?" + q, timeout=300) as r:
        dest.write_bytes(r.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="源图片文件夹")
    ap.add_argument("--outdir", default=None, help="输出目录（默认=源文件夹）")
    ap.add_argument("--outdir-x4", default=None, help="x4 单独输出目录（给出即进入分目录模式：文件名保持原名，不加 _x4 后缀）")
    ap.add_argument("--outdir-x2", default=None, help="x2 单独输出目录（同上）")
    ap.add_argument("--model", default="4x-AnimeSharp.pth")
    ap.add_argument("--only-x4", action="store_true", help="只出 x4，不出 x2")
    ap.add_argument("--overwrite", action="store_true", help="已存在也重跑")
    ap.add_argument("--list", action="store_true", help="只列清单不跑")
    args = ap.parse_args()

    src = Path(args.dir)
    if not src.is_dir():
        print(f"目录不存在: {src}", file=sys.stderr); return 1
    out = Path(args.outdir) if args.outdir else src
    split = bool(args.outdir_x4 or args.outdir_x2)
    out4 = Path(args.outdir_x4) if args.outdir_x4 else out
    out2 = Path(args.outdir_x2) if args.outdir_x2 else out
    for d in {out4, out2}:
        d.mkdir(parents=True, exist_ok=True)

    files = sorted(p for p in src.iterdir()
                   if p.is_file() and p.suffix.lower() in EXTS and not p.stem.endswith(SUFFIXES))
    print(f"源目录: {src}\nx4 输出: {out4}\nx2 输出: {out2}\n模型: {args.model}\n候选 {len(files)} 张")
    if args.list:
        for p in files: print("  ", p.name)
        return 0

    want_x2 = not args.only_x4
    sub = "owner_upscale_in"
    ok = skip = fail = 0
    t_all = time.time()
    for i, p in enumerate(files, 1):
        d4 = out4 / (f"{p.stem}.png" if split else f"{p.stem}_x4.png")
        d2 = out2 / (f"{p.stem}.png" if split else f"{p.stem}_x2.png")
        need4 = args.overwrite or not d4.exists()
        need2 = want_x2 and (args.overwrite or not d2.exists())
        if not need4 and not need2:
            skip += 1; print(f"[{i}/{len(files)}] 跳过（已存在） {p.name}"); continue
        t0 = time.time()
        try:
            ref = cu_upload(p, sub)
            pid = cu_submit(build_wf(ref, args.model, want_x2))
            outs = cu_wait(pid)
            for nid, images in outs.items():
                if not images: continue
                dest = d4 if nid == "4" else d2
                cu_fetch(images[0], dest)
            ok += 1
            sz = ", ".join(f"{d.name}={d.stat().st_size/1048576:.1f}MB" for d in (d4, d2) if d.exists())
            print(f"[{i}/{len(files)}] ✓ {p.name}  {time.time()-t0:.1f}s  {sz}")
        except Exception as e:
            fail += 1
            print(f"[{i}/{len(files)}] ✗ {p.name}: {e}", file=sys.stderr)
    print(f"\n完成: 成功 {ok} / 跳过 {skip} / 失败 {fail}，耗时 {time.time()-t_all:.0f}s")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    sys.exit(main())

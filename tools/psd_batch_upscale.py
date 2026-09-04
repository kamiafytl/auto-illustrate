#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PSD 批量高清 2x：画布+内容翻倍，底层原图换成 AI 放大版（矢量文字/形状层无损）。
链路：Photoshop导出底层→ComfyUI 4x放大模型→缩0.5=净2x→Photoshop缩放PSD+回填底层→另存 <dir>_2x。
驱动=命令行把 jsx 交给正在运行的 Photoshop（免COM；自动跳过已打开文档）。
跨盘：ComfyUI 输出在 E: (WSL读不到)→用 /view HTTP 取回写 C:。
前置：Photoshop 已开着、ComfyUI 已开（装好 4x 放大模型）。
用法: python3 tools/psd_batch_upscale.py --dir "<PSD文件夹>" --all
      python3 tools/psd_batch_upscale.py --dir "<...>" --indices 0,3,5
      python3 tools/psd_batch_upscale.py --dir "<...>" --list
细则/踩坑全量见 internal-docs。
"""
import argparse, json, subprocess, sys, time, urllib.request, urllib.parse, uuid
from pathlib import Path

PS_EXE = r"C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe"
WORK = Path("/mnt/c/Users/user/AppData/Local/Temp/psd_upscale_work")
BASE = WORK / "base"; BASE2X = WORK / "base_2x"

def win(p: Path) -> str:
    s = str(p); assert s.startswith("/mnt/c/"), f"需在 C: 盘: {p}"; return "C:/" + s[len("/mnt/c/"):]

IP = next(l.split()[1] for l in open("/etc/resolv.conf") if l.strip().startswith("nameserver"))
CU = f"http://{IP}:8188"

def cu_upload(path, subfolder):
    b=uuid.uuid4().hex; data=path.read_bytes(); body=b""
    for k,v in [(b"subfolder",subfolder.encode()),(b"overwrite",b"true")]:
        body+=b"--"+b.encode()+b"\r\nContent-Disposition: form-data; name=\""+k+b"\"\r\n\r\n"+v+b"\r\n"
    body+=b"--"+b.encode()+b"\r\nContent-Disposition: form-data; name=\"image\"; filename=\""+path.name.encode()+b"\"\r\n"
    body+=b"Content-Type: image/png\r\n\r\n"+data+b"\r\n--"+b.encode()+b"--\r\n"
    req=urllib.request.Request(CU+"/upload/image",data=body,headers={"Content-Type":f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req,timeout=60) as r:
        j=json.loads(r.read()); return (j.get("subfolder","")+"/"+j["name"]).lstrip("/")

def cu_submit(img_ref, model):
    wf={"1":{"class_type":"LoadImage","inputs":{"image":img_ref}},
        "2":{"class_type":"UpscaleModelLoader","inputs":{"model_name":model}},
        "3":{"class_type":"ImageUpscaleWithModel","inputs":{"upscale_model":["2",0],"image":["1",0]}},
        "5":{"class_type":"ImageScaleBy","inputs":{"image":["3",0],"upscale_method":"lanczos","scale_by":0.5}},
        "6":{"class_type":"SaveImage","inputs":{"images":["5",0],"filename_prefix":"psd_base_2x/tmp"}}}
    payload=json.dumps({"prompt":wf,"client_id":uuid.uuid4().hex}).encode()
    req=urllib.request.Request(CU+"/prompt",data=payload,headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=30) as r: return json.loads(r.read())["prompt_id"]

def cu_wait_fetch(pid,out_path,timeout=300):
    t0=time.time()
    while time.time()-t0<timeout:
        with urllib.request.urlopen(CU+f"/history/{pid}",timeout=15) as r: h=json.loads(r.read())
        if pid in h:
            for node in h[pid].get("outputs",{}).values():
                for im in node.get("images",[]):
                    q=urllib.parse.urlencode({"filename":im["filename"],"subfolder":im.get("subfolder",""),"type":im.get("type","output")})
                    with urllib.request.urlopen(CU+"/view?"+q,timeout=60) as r2: out_path.write_bytes(r2.read())
                    return True
        time.sleep(2)
    return False

JSX_COMMON = r'''
app.displayDialogs = DialogModes.NO;
app.preferences.rulerUnits = Units.PIXELS;
var WORK = "%WORK%";
function readManifest(p){ var f=File(p); f.encoding="UTF8"; f.open("r"); var t=f.read(); f.close();
  var L=t.split("\n"); var o=[]; for(var i=0;i<L.length;i++){ var s=L[i].replace(/[\r\n]+$/,""); if(s.length) o.push(s.split("\t")); } return o; }
function isOpen(path){ var tg=File(path).fsName; for(var i=0;i<app.documents.length;i++){ try{ if(app.documents[i].fullName.fsName==tg) return true; }catch(e){} } return false; }
function findBase(doc){ var W=doc.width.value,H=doc.height.value,res=null;
  function rec(ls){ for(var i=0;i<ls.length;i++){ var l=ls[i]; if(l.typename=="LayerSet") rec(l.layers);
    else if(l.kind==LayerKind.NORMAL){ var b=l.bounds; var x0=b[0].value,y0=b[1].value,x1=b[2].value,y1=b[3].value;
      if(x0<=1&&y0<=1&&x1>=W-1&&y1>=H-1){ res=l; } } } } rec(doc.layers); return res; }
function marker(n,t){ var d=File(WORK+"/"+n); d.encoding="UTF8"; d.open("w"); d.write(t); d.close(); }
'''
JSX_A = JSX_COMMON + r'''
var jobs=readManifest(WORK+"/manifest_A.txt"); var log=File(WORK+"/passA_log.txt"); log.encoding="UTF8"; log.open("w");
for(var j=0;j<jobs.length;j++){ var idx=jobs[j][0],psd=jobs[j][1],basePng=jobs[j][2]; var doc=null;
  try{ if(isOpen(psd)){ log.writeln(idx+"\tSKIP_OPEN"); continue; }
    doc=app.open(File(psd)); var base=findBase(doc);
    if(!base){ log.writeln(idx+"\tNO_BASE"); doc.close(SaveOptions.DONOTSAVECHANGES); continue; }
    var bn=base.name;
    var nd=app.documents.add(doc.width,doc.height,doc.resolution,"b",NewDocumentMode.RGB,DocumentFill.TRANSPARENT);
    app.activeDocument=doc; base.duplicate(nd,ElementPlacement.PLACEATBEGINNING); app.activeDocument=nd; nd.flatten();
    nd.saveAs(File(basePng),new PNGSaveOptions(),true,Extension.LOWERCASE);
    nd.close(SaveOptions.DONOTSAVECHANGES); doc.close(SaveOptions.DONOTSAVECHANGES); log.writeln(idx+"\tOK\t"+bn);
  }catch(e){ log.writeln(idx+"\tERR\t"+e); try{doc.close(SaveOptions.DONOTSAVECHANGES);}catch(_){} } }
log.close(); marker("passA_DONE.txt","done");
'''
JSX_B = JSX_COMMON + r'''
function placeEmbedded(path){ var id=charIDToTypeID("Plc "); var d=new ActionDescriptor();
  d.putPath(charIDToTypeID("null"),new File(path)); d.putEnumerated(charIDToTypeID("FTcs"),charIDToTypeID("QCSt"),charIDToTypeID("Qcsa"));
  executeAction(id,d,DialogModes.NO); return app.activeDocument.activeLayer; }
var jobs=readManifest(WORK+"/manifest_B.txt"); var log=File(WORK+"/passB_log.txt"); log.encoding="UTF8"; log.open("w");
for(var j=0;j<jobs.length;j++){ var idx=jobs[j][0],psd=jobs[j][1],b2x=jobs[j][2],outPsd=jobs[j][3]; var doc=null;
  try{ if(isOpen(psd)){ log.writeln(idx+"\tSKIP_OPEN"); continue; }
    doc=app.open(File(psd)); var base=findBase(doc);
    if(!base){ log.writeln(idx+"\tNO_BASE"); doc.close(SaveOptions.DONOTSAVECHANGES); continue; }
    doc.resizeImage(UnitValue(doc.width.value*2,"px"),UnitValue(doc.height.value*2,"px"),doc.resolution,ResampleMethod.BICUBICSMOOTHER);
    var placed=placeEmbedded(b2x); placed.rasterize(RasterizeType.ENTIRELAYER);
    var pb=placed.bounds; placed.translate(-pb[0].value,-pb[1].value);
    placed.move(base,ElementPlacement.PLACEBEFORE); base.remove(); placed.name="base_2x";
    var o=new PhotoshopSaveOptions(); o.layers=true; o.embedColorProfile=true; o.alphaChannels=true; o.annotations=false; o.spotColors=false;
    doc.saveAs(File(outPsd),o,true,Extension.LOWERCASE); doc.close(SaveOptions.DONOTSAVECHANGES); log.writeln(idx+"\tOK");
  }catch(e){ log.writeln(idx+"\tERR\t"+e); try{doc.close(SaveOptions.DONOTSAVECHANGES);}catch(_){} } }
log.close(); marker("passB_DONE.txt","done");
'''

def run_jsx(txt, done, timeout=1800):
    """经 COM /Automation 实例同步执行 jsx（比命令行交接可靠）。需先关掉普通PS。"""
    jp=WORK/(done.replace("_DONE.txt","")+".jsx"); jp.write_text(txt.replace("%WORK%",win(WORK)),encoding="utf-8-sig")
    d=WORK/done
    if d.exists(): d.unlink()
    ps=("try { $app=[Runtime.InteropServices.Marshal]::GetActiveObject('Photoshop.Application.200') } "
        "catch { try { $app=New-Object -ComObject Photoshop.Application.200 } catch { Write-Output 'NO_PS'; exit 1 } } "
        f"$app.DoJavaScriptFile('{win(jp)}'); Write-Output 'OK'")
    r=subprocess.run(["powershell.exe","-NoProfile","-Command",ps],capture_output=True,text=True,timeout=timeout)
    if "NO_PS" in (r.stdout+r.stderr):
        print("!! 无法驱动 Photoshop：请先【关闭】Photoshop（工具会自启一个 /Automation 自动化实例再跑）"); return False
    return d.exists()

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--dir",required=True); ap.add_argument("--model",default="4x-AnimeSharp.pth")
    ap.add_argument("--indices",default=""); ap.add_argument("--all",action="store_true"); ap.add_argument("--list",action="store_true")
    a=ap.parse_args()
    SRC=Path(a.dir); OUT=SRC.parent/(SRC.name+"_2x")
    for d in (WORK,BASE,BASE2X,OUT): d.mkdir(parents=True,exist_ok=True)
    psds=sorted(SRC.glob("*.psd"))
    if a.list:
        for i,p in enumerate(psds): print(f"{i:2d}  {p.name}");
        return
    sel=list(range(len(psds))) if a.all else [int(x) for x in a.indices.split(",") if x.strip()!=""]
    jobs=[(i,psds[i]) for i in sel]
    print(f"处理 {len(jobs)} 个 @ {SRC.name}  模型={a.model}",flush=True)
    (WORK/"manifest_A.txt").write_text("\n".join(f"{i}\t{win(SRC/p.name)}\t{win(BASE/f'job{i:02d}.png')}" for i,p in jobs),encoding="utf-8")
    print("① Photoshop 导出底层...",flush=True)
    if not run_jsx(JSX_A,"passA_DONE.txt"): print("!! Pass A 超时",(WORK/'passA_log.txt').read_text('utf-8')); return
    print((WORK/"passA_log.txt").read_text("utf-8"),flush=True)
    print("② ComfyUI 4x→缩0.5=净2x...",flush=True)
    manB=[]
    for i,p in jobs:
        bp=BASE/f"job{i:02d}.png"
        if not bp.exists(): print(f"  [{i}] 底层缺，跳"); continue
        pid=cu_submit(cu_upload(bp,"psd_base"),a.model); out2x=BASE2X/f"job{i:02d}.png"
        ok=cu_wait_fetch(pid,out2x)
        print(f"  [{i}] {p.name} -> {'ok' if ok else '失败'}",flush=True)
        if ok: manB.append(f"{i}\t{win(SRC/p.name)}\t{win(out2x)}\t{win(OUT/p.name)}")
    (WORK/"manifest_B.txt").write_text("\n".join(manB),encoding="utf-8")
    print("③ Photoshop 缩放+回填+另存...",flush=True)
    if not run_jsx(JSX_B,"passB_DONE.txt"): print("!! Pass B 超时",(WORK/'passB_log.txt').read_text('utf-8')); return
    print((WORK/"passB_log.txt").read_text("utf-8"),flush=True); print("完成 →",OUT,flush=True)

if __name__=="__main__": main()

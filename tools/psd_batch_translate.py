#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PSD 批量文字层翻译：把 <dir> 的可编辑文字层译成目标语言，落到副本夹 <dir>_<lang>。
按「文字层深度优先索引」对齐（提取/回填两趟同一遍历顺序，不靠字符串匹配，抗重复/换行）。
三步：
  1) python3 tools/psd_batch_translate.py --dir "<PSD夹>" --lang 日语 --extract
     → 复制副本 + JSX 抽每层原文到 WORK/tl_extract/{idx}_{k}.txt
  2) CC 读 tl_extract 逐条翻译，写 WORK/tl_trans/{idx}_{k}.txt（\\r 换行；缺文件=该层不改）
  3) python3 tools/psd_batch_translate.py --dir "<PSD夹>" --lang 日语 --write
     → JSX 读 tl_trans 回填 textItem.contents + 存盘副本
注意：目标语言字形要被 PSD 文字层字体支持（否则豆腐块），必要时先在 PS 统一字体。
细则见 internal-docs。
"""
import argparse, shutil, subprocess, time
from pathlib import Path

PS_EXE = r"C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe"
WORK = Path("/mnt/c/Users/user/AppData/Local/Temp/psd_translate_work")
EXT = WORK/"tl_extract"; TRN = WORK/"tl_trans"

def win(p): s=str(p); assert s.startswith("/mnt/c/"),f"需C:盘:{p}"; return "C:/"+s[len("/mnt/c/"):]

COMMON = r'''
app.displayDialogs=DialogModes.NO; app.preferences.rulerUnits=Units.PIXELS; app.preferences.typeUnits=TypeUnits.POINTS; var WORK="%WORK%";
function readManifest(p){ var f=File(p); f.encoding="UTF8"; f.open("r"); var t=f.read(); f.close();
  var L=t.split("\n"); var o=[]; for(var i=0;i<L.length;i++){ var s=L[i].replace(/[\r\n]+$/,""); if(s.length) o.push(s.split("\t")); } return o; }
function isOpen(path){ var tg=File(path).fsName; for(var i=0;i<app.documents.length;i++){ try{ if(app.documents[i].fullName.fsName==tg) return true; }catch(e){} } return false; }
function collectType(doc){ var out=[]; function rec(ls){ for(var i=0;i<ls.length;i++){ var l=ls[i];
  if(l.typename=="LayerSet") rec(l.layers); else if(l.kind==LayerKind.TEXT) out.push(l); } } rec(doc.layers); return out; }
function writeTxt(p,t){ var f=File(p); f.encoding="UTF8"; f.open("w"); f.write(t); f.close(); }
function readTxt(p){ var f=File(p); if(!f.exists) return null; f.encoding="UTF8"; f.open("r"); var t=f.read(); f.close(); return t; }
function marker(n,t){ writeTxt(WORK+"/"+n,t); }
'''
JSX_EXTRACT = COMMON + r'''
var jobs=readManifest(WORK+"/tl_manifest.txt");
for(var j=0;j<jobs.length;j++){ var idx=jobs[j][0],psd=jobs[j][1]; var doc=null;
  try{ if(isOpen(psd)) continue; doc=app.open(File(psd)); var ts=collectType(doc);
    for(var k=0;k<ts.length;k++){ writeTxt(WORK+"/tl_extract/"+idx+"_"+k+".txt",ts[k].textItem.contents); }
    doc.close(SaveOptions.DONOTSAVECHANGES);
  }catch(e){ try{doc.close(SaveOptions.DONOTSAVECHANGES);}catch(_){} } }
marker("tl_extract_DONE.txt","done");
'''
JSX_WRITE = COMMON + r'''
var FONT="%FONT%"; var SCALE=parseFloat("%SCALE%");
var jobs=readManifest(WORK+"/tl_manifest.txt"); var log=File(WORK+"/tl_write_log.txt"); log.encoding="UTF8"; log.open("w");
for(var j=0;j<jobs.length;j++){ var idx=jobs[j][0],psd=jobs[j][1],src=jobs[j][2]; var doc=null; var n=0;
  try{ if(isOpen(psd)){ log.writeln(idx+"\tSKIP_OPEN"); continue; }
    var sizes=null, leads=null;  // 字号+行距基准=中文原版(幂等,不随重跑累积缩)
    if(SCALE!=1 && src){ var sd=app.open(File(src)); var st=collectType(sd); sizes=[]; leads=[];
      for(var s=0;s<st.length;s++){ var ti=st[s].textItem; sizes.push(ti.size);
        var ld=null; try{ if(!ti.useAutoLeading) ld=ti.leading; }catch(e){} leads.push(ld); }
      sd.close(SaveOptions.DONOTSAVECHANGES); }
    doc=app.open(File(psd)); var ts=collectType(doc);
    var SFAC=1;  // 标定 textItem.size 写入倍率(PS坑:2x文档里写入值会被缩,设100读回看实际比例)
    if(sizes&&ts.length>0){ try{ var o0=ts[0].textItem.size; ts[0].textItem.size=100; SFAC=100/parseFloat(ts[0].textItem.size); ts[0].textItem.size=o0; }catch(e){ SFAC=1; } }
    for(var k=0;k<ts.length;k++){ var jp=readTxt(WORK+"/tl_trans/"+idx+"_"+k+".txt");
      if(jp!=null&&jp.length){ jp=jp.replace(/\r\n/g,"\n").replace(/\r/g,"\n").replace(/\n/g,String.fromCharCode(13));
        if(FONT.length){ try{ ts[k].textItem.font=FONT; }catch(e){} }
        if(sizes&&sizes[k]!=null){ try{ ts[k].textItem.size=parseFloat(sizes[k])*SCALE*SFAC; }catch(e){}
          try{ if(leads[k]!=null){ ts[k].textItem.useAutoLeading=false; ts[k].textItem.leading=parseFloat(leads[k])*SCALE*SFAC; } }catch(e){} }
        ts[k].textItem.contents=jp; n++; } }
    var o=new PhotoshopSaveOptions(); o.layers=true; o.embedColorProfile=true; o.alphaChannels=true; o.annotations=false; o.spotColors=false;
    doc.saveAs(File(psd),o,true,Extension.LOWERCASE); doc.close(SaveOptions.DONOTSAVECHANGES); log.writeln(idx+"\tOK\t"+n+"条");
  }catch(e){ log.writeln(idx+"\tERR\t"+e); try{doc.close(SaveOptions.DONOTSAVECHANGES);}catch(_){} } }
log.close(); marker("tl_write_DONE.txt","done");
'''

def run_jsx(txt,done,timeout=1800,font="",scale="1"):
    """经 COM /Automation 实例同步执行 jsx（比命令行交接可靠）。需先关掉普通PS或已有自动化实例。"""
    jp=WORK/(done.replace("_DONE.txt","")+".jsx"); jp.write_text(txt.replace("%WORK%",win(WORK)).replace("%FONT%",font).replace("%SCALE%",scale),encoding="utf-8-sig")
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
    ap=argparse.ArgumentParser(); ap.add_argument("--dir",required=True); ap.add_argument("--lang",default="日语")
    ap.add_argument("--extract",action="store_true"); ap.add_argument("--write",action="store_true")
    ap.add_argument("--font",default=""); ap.add_argument("--scale",default="1"); a=ap.parse_args()
    SRC=Path(a.dir); JP=SRC.parent/(SRC.name+"_"+a.lang)
    for d in (WORK,EXT,TRN): d.mkdir(parents=True,exist_ok=True)
    def manifest():
        jps=sorted(JP.glob("*.psd")); (WORK/"tl_manifest.txt").write_text("\n".join(f"{i}\t{win(p)}\t{win(SRC/p.name)}" for i,p in enumerate(jps)),encoding="utf-8"); return jps
    if a.extract:
        JP.mkdir(exist_ok=True)
        for f in sorted(SRC.glob("*.psd")): shutil.copy2(f,JP/f.name)
        print(f"复制 {len(list(JP.glob('*.psd')))} 个 → {JP.name}"); manifest()
        for f in EXT.glob("*.txt"): f.unlink()
        print("JSX 提取原文...")
        ok=run_jsx(JSX_EXTRACT,"tl_extract_DONE.txt")
        print(f"{'完成' if ok else '超时'}，抽出 {len(list(EXT.glob('*.txt')))} 条 → {EXT}\n下一步：CC 读该目录逐条翻译写 {TRN}/{{idx}}_{{k}}.txt，再 --write")
    elif a.write:
        manifest(); print(f"JSX 回填... 字体={a.font or '(不改)'} 字号×{a.scale}(基准=中文原版)")
        ok=run_jsx(JSX_WRITE,"tl_write_DONE.txt",font=a.font,scale=a.scale)
        print(("完成:" if ok else "超时:")+"\n"+(WORK/"tl_write_log.txt").read_text("utf-8")); print("→",JP)

if __name__=="__main__": main()

import { type Plugin } from 'vite'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'

export function ratingPlugin(rootDir: string): Plugin {
  const newCopyId = () => 'copy_' + randomUUID().slice(0, 8)
  const newCompId = () => 'comp_' + randomUUID().slice(0, 8)
  // 路径单一真相源 = data/paths.json（D1·系统优化工程）。读失败则回退到现路径字面值（零回归）。
  const PATHS_FALLBACK = {
    workspace: '/mnt/c/Users/user/Pictures/ai-output/nai-output',
    orig_compare: '/mnt/c/Users/user/Pictures/ai-output/reference',
  }
  const loadPaths = (): { workspace: string; orig_compare: string } => {
    try {
      const p = JSON.parse(fs.readFileSync(path.resolve(rootDir, '../data/paths.json'), 'utf-8'))
      return {
        workspace: p.workspace || PATHS_FALLBACK.workspace,
        orig_compare: p.orig_compare || PATHS_FALLBACK.orig_compare,
      }
    } catch { return PATHS_FALLBACK }
  }
  const _PATHS = loadPaths()
  const RATING_BASE = _PATHS.workspace
  // 原图对照专用根目录：与 RATING_BASE 同相对路径镜像存原图。评分系统只扫 RATING_BASE 的出图，
  // 比对时按出图文件夹的相对路径 + 页号(_pNN) 自动到这里匹配原图（原图左 / 出图右）。
  const ORIG_BASE = _PATHS.orig_compare
  const TRACKING = path.resolve(rootDir, '../tracking')
  // 懒狗出图系统 单图骨架库(存储手册 internal-docs)。库自包含=预览图复制进 public,扛测试夹清理。
  const LAZY_DIR = path.resolve(rootDir, '../data/lazydog')
  const FACETS_FILE = path.join(LAZY_DIR, 'facets.json')
  const SHOTS_FILE = path.join(LAZY_DIR, 'shots.json')
  const CATS_FILE = path.join(LAZY_DIR, 'categories.json')
  // 套图库:帧本体(LazyShot[],按 source.folder 分套)。导入时追加,平时只读。
  const SETS_FILE = path.join(LAZY_DIR, 'sets.json')
  // 套图级元数据(键=setId=source.folder):套序/帧序/封面/改名/软删。所有高频改动只写这里,与洗 shots.json 零冲突。
  const SETS_META_FILE = path.join(LAZY_DIR, 'sets_meta.json')
  const PREVIEW_DIR = path.resolve(rootDir, 'public/images/lazydog')
  const THUMB_DIR   = path.resolve(rootDir, 'public/lazydog-thumbs')
  // 缩略图文件名 = preview 文件名去扩展 + .jpg（路径相对 webapp/public）
  const thumbNameFor = (previewName: string) => previewName.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg'
  const thumbRelFor  = (previewName: string) => 'lazydog-thumbs/' + thumbNameFor(previewName)
  // 生成缩略图（调 Python PIL）；失败静默不阻塞入库
  const generateThumb = (srcPath: string, previewName: string): string | undefined => {
    try {
      fs.mkdirSync(THUMB_DIR, { recursive: true })
      const dst = path.join(THUMB_DIR, thumbNameFor(previewName))
      const r = spawnSync('python3', [
        path.resolve(rootDir, '../tools/lazydog_make_thumb.py'), srcPath, dst,
      ], { timeout: 15000 })
      return r.status === 0 ? thumbRelFor(previewName) : undefined
    } catch { return undefined }
  }
  const MIME: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
  const isImg = (f: string) => /\.(png|webp|jpe?g)$/i.test(f)
  const pageOf = (f: string) => { const m = f.match(/_p(\d+)/i) ?? f.match(/^p(\d+)/i); return m ? parseInt(m[1], 10) : -1 }
  const seedOf = (f: string) => { const m = f.match(/seed(\d+)/i); return m ? parseInt(m[1], 10) : undefined }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadShots = (): any[] => { try { return JSON.parse(fs.readFileSync(SHOTS_FILE, 'utf-8')) } catch { return [] } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saveShots = (arr: any[]) => { fs.mkdirSync(LAZY_DIR, { recursive: true }); fs.writeFileSync(SHOTS_FILE, JSON.stringify(arr, null, 2), 'utf-8') }
  // 图库大类→中类树。文件缺失时种子化(示例分类,id=原名)。
  const CAT_SEED = {
    version: 1,
    groups: [
      { id: '人物立绘', name: '人物立绘', subs: [{ id: '半身', name: '半身' }, { id: '全身', name: '全身' }] },
      { id: '场景插画', name: '场景插画', subs: [] },
      { id: '构图实验', name: '构图实验', subs: [] },
      { id: '风格测试', name: '风格测试', subs: [] },
      { id: '未分类', name: '未分类', subs: [] },
    ],
  }
  const loadCats = () => {
    try { return JSON.parse(fs.readFileSync(CATS_FILE, 'utf-8')) }
    catch { fs.mkdirSync(LAZY_DIR, { recursive: true }); fs.writeFileSync(CATS_FILE, JSON.stringify(CAT_SEED, null, 2), 'utf-8'); return CAT_SEED }
  }
  // 套图分类树(与单图 categories.json 同结构、独立文件;复刻/标准/原创三类套图共用。内容由用户自建,缺失=空树)
  const SET_CATS_FILE = path.join(LAZY_DIR, 'set_categories.json')
  const SET_CAT_SEED = { version: 1, groups: [] as unknown[] }
  const loadSetCats = () => {
    try { return JSON.parse(fs.readFileSync(SET_CATS_FILE, 'utf-8')) }
    catch { fs.mkdirSync(LAZY_DIR, { recursive: true }); fs.writeFileSync(SET_CATS_FILE, JSON.stringify(SET_CAT_SEED, null, 2), 'utf-8'); return SET_CAT_SEED }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadSets = (): any[] => { try { return JSON.parse(fs.readFileSync(SETS_FILE, 'utf-8')) } catch { return [] } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saveSets = (arr: any[]) => { fs.mkdirSync(LAZY_DIR, { recursive: true }); fs.writeFileSync(SETS_FILE, JSON.stringify(arr, null, 2), 'utf-8') }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadSetsMeta = (): Record<string, any> => { try { const d = JSON.parse(fs.readFileSync(SETS_META_FILE, 'utf-8')); return d?.sets ?? {} } catch { return {} } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saveSetsMeta = (m: Record<string, any>) => { fs.mkdirSync(LAZY_DIR, { recursive: true }); fs.writeFileSync(SETS_META_FILE, JSON.stringify({ version: 1, sets: m }, null, 2), 'utf-8') }
  // 三类套图·引用型组合(标准套图/原创套图;lazydog_storage §4.8)。纯引用,缺失种子化空表。
  const COMPS_FILE = path.join(LAZY_DIR, 'compositions.json')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadComps = (): any[] => { try { const d = JSON.parse(fs.readFileSync(COMPS_FILE, 'utf-8')); return Array.isArray(d?.items) ? d.items : [] } catch { return [] } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saveComps = (items: any[]) => { fs.mkdirSync(LAZY_DIR, { recursive: true }); fs.writeFileSync(COMPS_FILE, JSON.stringify({ version: 1, items }, null, 2), 'utf-8') }
  // 删预览前的引用计数(铁律③):某 preview 路径仍被任何 shots(含 copy 副本)/sets/sets_meta.extraFrames 共享 → 不 unlink 文件。
  // comps 是纯引用(不持 preview),孤儿引用不阻止删除、也不保活文件。
  const previewInUse = (preview?: string): boolean => {
    if (!preview) return false
    if (loadShots().some(s => s?.preview === preview)) return true
    if (loadSets().some(s => s?.preview === preview)) return true
    for (const m of Object.values(loadSetsMeta())) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (((m as any)?.extraFrames ?? []).some((f: any) => f?.preview === preview)) return true
    }
    return false
  }
  const unlinkPreviewIfFree = (preview?: string, thumb?: string) => {
    if (!preview || previewInUse(preview)) return
    try { fs.unlinkSync(path.resolve(rootDir, 'public', preview)) } catch { /* 预览已不在 */ }
    if (thumb) try { fs.unlinkSync(path.resolve(rootDir, 'public', thumb)) } catch { /* 缩略图已不在 */ }
  }
  // 把帧条目按 source.folder 分套,叠加 meta(套序/帧序/封面/改名/软删),组装成套图对象数组
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildSets = (frames: any[], meta: Record<string, any>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byFolder = new Map<string, any[]>()
    for (const f of frames) {
      const sid = f?.source?.folder || ''
      const arr = byFolder.get(sid) ?? []; arr.push(f); byFolder.set(sid, arr)
    }
    const sets = [...byFolder.entries()].map(([id, fr]) => {
      const m = meta[id] ?? {}
      const fo: Record<string, number> = m.frameOrder ?? {}
      const fm: Record<string, { tags?: string[]; note?: string }> = m.frameMeta ?? {}
      const order2 = (x: { id: string; source?: { page?: number }; created?: string }) =>
        fo[x.id] ?? (x.source?.page ?? Number.MAX_SAFE_INTEGER)
      // 套图显式成员:自然帧 − removed + extraFrames(粘进来的副本,存 sets_meta)
      const removed = new Set<string>(m.removed ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const merged = [...fr.filter((f: any) => !removed.has(f?.id)), ...(m.extraFrames ?? [])]
      // 帧级 meta(tags/note)叠加在读侧(只存 sets_meta,绝不回写 sets.json)
      const sorted = merged.slice().sort((a, b) =>
        order2(a) - order2(b) || ((a.created ?? '') < (b.created ?? '') ? -1 : 1))
        .map(f => ({ ...f, tags: fm[f.id]?.tags ?? f.tags ?? [], note: fm[f.id]?.note ?? f.note ?? '' }))
      const coverFrame = (m.cover && sorted.find(x => x.id === m.cover)) || sorted[0]
      return {
        id,
        title: m.title || fr[0]?.source?.work || id.split('/').pop() || id,
        work: fr[0]?.source?.work || '',
        cover: coverFrame?.thumb || coverFrame?.preview || '',
        coverId: coverFrame?.id || '',
        count: sorted.length,
        frames: sorted,
        tags: m.tags ?? [],
        order: m.order,
        // 套图分类(大中小三层,存 sets_meta;空=待部署区)。前端按此分桶,同单图架构。
        category: m.category ?? '',
        subcategory: m.subcategory ?? '',
        subsubcategory: m.subsubcategory ?? '',
        trashed: !!m.trashed,
        trashedAt: m.trashedAt,
      }
    })
    sets.sort((a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      a.title.localeCompare(b.title, 'zh'))
    return sets
  }
  const safeName = (s: string) => s.replace(/[\\/]/g, '_').replace(/[^\w.\-一-鿿ぁ-ヿ]/g, '_')
  // 给某出图文件夹(相对 RATING_BASE)建原图索引（原图在 ORIG_BASE 同相对路径下）：
  // byPage=「页号→首个原图」旧规则；files=全量文件名，供前缀精确匹配（组合套图 _sNN 跨套页号撞车，2026-07-13 百合comp 实锤）
  const origMapFor = (folder: string): { byPage: Record<number, string>; files: string[] } => {
    const dir = path.join(ORIG_BASE, folder)
    const byPage: Record<number, string> = {}
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter(isImg)
      for (const f of files) { const p = pageOf(f); if (p >= 0 && byPage[p] === undefined) byPage[p] = f }
    } catch { /* 无原图目录 */ }
    return { byPage, files }
  }
  // 嵌套子文件夹：folder 为相对 BASE 的路径（'/' 分隔，如 `复刻整理/v1`）；落盘文件名把 '/' 折成 '_'
  // 顶层文件夹无 '/' → 文件名与旧版完全一致（向后兼容，CC 旧评分 json 不受影响）
  const ratingFile = (folder: string) => path.join(TRACKING, `评分_${folder.replace(/[\\/]/g, '_')}.json`)
  const loadRatings = (folder: string): Record<string, { score?: unknown; comment?: string }> => {
    try { return JSON.parse(fs.readFileSync(ratingFile(folder), 'utf-8')) } catch { return {} }
  }
  return {
    name: 'rating-api',
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url as string | undefined
        if (!url?.startsWith('/api/rating')) return next()
        const u = new URL(url, 'http://localhost')
        const send = (data: unknown, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(data))
        }
        const readBody = (): Promise<string> => new Promise(r => {
          let b = ''
          req.on('data', (c: Buffer | undefined) => { if (c) b += c.toString() })
          req.on('end', () => r(b))
        })
        try {
          if (u.pathname === '/api/rating/folders') {
            if (!fs.existsSync(RATING_BASE)) return send({ folders: [] })
            // 递归收集「直接含图片」的目录（含版本子文件夹如 `复刻整理/v1`），深度上限防失控
            const out: { name: string; count: number; mtime: number }[] = []
            const walk = (rel: string, depth: number) => {
              const abs = path.join(RATING_BASE, rel)
              let entries: import('fs').Dirent[]
              try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
              const count = entries.filter(e => e.isFile() && isImg(e.name)).length
              if (rel && count > 0) out.push({ name: rel, count, mtime: fs.statSync(abs).mtimeMs })
              if (depth <= 0) return
              // 跳过遗留 _原图 子目录（旧版手动配对结构；现原图已迁到 ORIG_BASE，不再作可选组）
              // 跳过 _待删除 前缀夹（两级删除制 drawing_workflow §五.10：盘上留 30 天缓冲，但不再出现在评分/导入下拉挡视线）
              for (const e of entries) if (e.isDirectory() && e.name !== '_原图' && !e.name.startsWith('_待删除')) walk(rel ? `${rel}/${e.name}` : e.name, depth - 1)
            }
            walk('', 3)
            // mtime 倒序=Owner 钦定不许改（新跑的在最上面才找得到，2026-07-08）；乱序观感来自 CC 合并文件扰动旧夹 mtime，治法=合并后 touch -d 还原，别动排序
            out.sort((a, b) => b.mtime - a.mtime)
            return send({ folders: out })
          }
          if (u.pathname === '/api/rating/list') {
            const folder = u.searchParams.get('folder') || ''
            const dir = path.join(RATING_BASE, folder)
            // 自然排序：数字段按数值比（p2 在 p10 前、1.png 在 10.png 前），不依赖出图端零填充
            const natSort = (a: string, b: string) => a.localeCompare(b, 'zh', { numeric: true })
            const images = fs.existsSync(dir) ? fs.readdirSync(dir).filter(isImg).sort(natSort) : []
            // 比对=路径自动匹配：先「原图名(去扩展)=出图名前缀」精确配（组合套图 AW_sNN_pNN 页号跨套撞车,seq 才唯一），
            // 再回退旧「同页号(_pNN)」规则（旧夹原图名与出图名不同源=前缀必不中,行为零变）。
            // origs[出图名] = 原图文件名|null（null=该页无原图，前端比对仍可开、左侧提示无原图）。
            const { byPage, files: origFiles } = origMapFor(folder)
            const stems = origFiles.map(f => [f.replace(/\.(png|webp|jpe?g)$/i, ''), f] as const)
              .sort((a, b) => b[0].length - a[0].length)   // 最长 stem 优先，防短名误吞长名
            const origs: Record<string, string | null> = {}
            for (const im of images) {
              const exact = stems.find(([s]) => im.startsWith(s))
              const p = pageOf(im)
              origs[im] = exact ? exact[1] : (p >= 0 && byPage[p] !== undefined) ? byPage[p] : null
            }
            const hasOrig = Object.values(origs).some(Boolean)
            return send({ images, ratings: loadRatings(folder), origs, hasOrig })
          }
          if (u.pathname === '/api/rating/orig') {
            const folder = u.searchParams.get('folder') || ''
            const name = u.searchParams.get('name') || ''
            const fp = path.resolve(ORIG_BASE, folder, name)
            if (fp.startsWith(path.resolve(ORIG_BASE) + path.sep) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
              res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' })
              return res.end(fs.readFileSync(fp))
            }
            return send({ error: 'orig not found' }, 404)
          }
          if (u.pathname === '/api/rating/img') {
            const folder = u.searchParams.get('folder') || ''
            const name = u.searchParams.get('name') || ''
            const fp = path.resolve(RATING_BASE, folder, name)
            // 安全：解析后必须落在 BASE 内，防 `..` 目录穿越（兼容嵌套子文件夹）
            if (fp.startsWith(path.resolve(RATING_BASE) + path.sep) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
              res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' })
              return res.end(fs.readFileSync(fp))
            }
            return send({ error: 'not found' }, 404)
          }
          if (u.pathname === '/api/rating/rate' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const folder = String(d.folder || '')
            const file = String(d.file || '')
            const ratings = loadRatings(folder)
            const rec: { score?: unknown; comment?: string } = ratings[file] || {}
            if (d.score !== undefined && d.score !== null) rec.score = d.score
            if (d.comment !== undefined && d.comment !== null) rec.comment = d.comment
            const clean = Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== null && v !== ''))
            if (Object.keys(clean).length) ratings[file] = clean
            else delete ratings[file]
            fs.mkdirSync(TRACKING, { recursive: true })
            fs.writeFileSync(ratingFile(folder), JSON.stringify(ratings, null, 2), 'utf-8')
            return send({ ratings })
          }
          // ===== 懒狗出图系统：七面词表 + 单图骨架库 =====
          if (u.pathname === '/api/rating/facets') {
            try { return send(JSON.parse(fs.readFileSync(FACETS_FILE, 'utf-8'))) }
            catch { return send({ version: 0, facets: [] }) }
          }
          // 全量读库(懒狗单图浏览器用):返回整个 shots.json(LazyShot[])
          if (u.pathname === '/api/rating/shots-all') {
            return send({ shots: loadShots() })
          }
          // 散图库大类→中类树:读 / 整树覆盖保存(增删改名/排序前端发整棵树)
          if (u.pathname === '/api/rating/categories') {
            return send(loadCats())
          }
          if (u.pathname === '/api/rating/categories-save' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            if (!Array.isArray(d.groups)) return send({ error: 'groups[] required' }, 400)
            const version = Number(d.version) || 1
            fs.mkdirSync(LAZY_DIR, { recursive: true })
            fs.writeFileSync(CATS_FILE, JSON.stringify({ version, groups: d.groups }, null, 2), 'utf-8')
            return send({ ok: true, groups: d.groups })
          }
          // 套图分类树(复刻/标准/原创三类套图共用,独立于单图):读 / 整树覆盖(前端发整棵树,同 categories-save)
          if (u.pathname === '/api/rating/set-categories') {
            return send(loadSetCats())
          }
          if (u.pathname === '/api/rating/set-categories-save' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            if (!Array.isArray(d.groups)) return send({ error: 'groups[] required' }, 400)
            const version = Number(d.version) || 1
            fs.mkdirSync(LAZY_DIR, { recursive: true })
            fs.writeFileSync(SET_CATS_FILE, JSON.stringify({ version, groups: d.groups }, null, 2), 'utf-8')
            return send({ ok: true, groups: d.groups })
          }
          // 编辑单图(懒狗浏览器用):按 id 合并 facets/blocks/title/note/status,bump updated。不碰 preview/source/id
          if (u.pathname === '/api/rating/shot-update' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const id = String(d.id || '')
            if (!id) return send({ error: 'id required' }, 400)
            const shots = loadShots()
            const idx = shots.findIndex(s => s?.id === id)
            if (idx < 0) return send({ error: 'shot not found' }, 404)
            const s = shots[idx]
            if (d.facets !== undefined) s.facets = d.facets
            if (d.blocks !== undefined) s.blocks = d.blocks
            if (d.title !== undefined) s.title = d.title
            if (d.note !== undefined) s.note = d.note
            if (d.status !== undefined) s.status = d.status
            if (d.category !== undefined) s.category = d.category
            if (d.subcategory !== undefined) s.subcategory = d.subcategory
            if (d.subsubcategory !== undefined) s.subsubcategory = d.subsubcategory
            if (d.clip !== undefined) { if (d.clip) s.clip = true; else delete s.clip }
            if (d.tags !== undefined) s.tags = d.tags
            if (d.order !== undefined) s.order = d.order
            if (d.trashed !== undefined) {
              s.trashed = d.trashed
              if (d.trashed) s.trashedAt = new Date().toISOString(); else delete s.trashedAt
            }
            s.updated = new Date().toISOString()
            shots[idx] = s
            saveShots(shots)
            return send({ ok: true, shot: s })
          }
          // 散图库拖拽排版(批量):一次提交受影响条目的 {id,category,order},合并写回。
          if (u.pathname === '/api/rating/shots-arrange' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const items: { id: string; category?: string; subcategory?: string; subsubcategory?: string; clip?: boolean; order?: number }[] = Array.isArray(d.items) ? d.items : []
            const shots = loadShots()
            const byId = new Map(shots.map((s, i) => [s?.id, i]))
            const now = new Date().toISOString()
            for (const it of items) {
              const i = byId.get(String(it.id || ''))
              if (i === undefined) continue
              if (it.category !== undefined) shots[i].category = it.category
              if (it.subcategory !== undefined) shots[i].subcategory = it.subcategory
              if (it.subsubcategory !== undefined) shots[i].subsubcategory = it.subsubcategory
              if (it.clip !== undefined) { if (it.clip) shots[i].clip = true; else delete shots[i].clip }
              if (it.order !== undefined) shots[i].order = it.order
              shots[i].updated = now
            }
            saveShots(shots)
            return send({ ok: true, count: items.length })
          }
          // 当前文件夹各图的入库状态 + 已录 facets（前端载图时一起拿，显示 ✓入库/回填已选）
          if (u.pathname === '/api/rating/shots') {
            const folder = u.searchParams.get('folder') || ''
            const byFile: Record<string, { facets: unknown; status: string; note?: string; category?: string; subcategory?: string; subsubcategory?: string; tags?: string[] }> = {}
            for (const s of loadShots()) {
              if (!folder || s?.source?.folder === folder) byFile[s.source.file] = { facets: s.facets, status: s.status, note: s.note, category: s.category, subcategory: s.subcategory, subsubcategory: s.subsubcategory, tags: s.tags }
            }
            return send({ shots: byFile })
          }
          // 入库/更新：Owner 在评分面板打标后提交。复制预览图进 public(库自包含)，upsert shots.json。
          // blocks(固定维度 tag) 留空 → CC 读 meta 自动录入(status draft→confirmed)。
          if (u.pathname === '/api/rating/lazy' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const folder = String(d.folder || '')
            const file = String(d.file || '')
            if (!folder || !file) return send({ error: 'folder/file required' }, 400)
            const src = path.resolve(RATING_BASE, folder, file)
            if (!(src.startsWith(path.resolve(RATING_BASE) + path.sep) && fs.existsSync(src))) return send({ error: 'src image not found' }, 404)
            const id = `${folder}/${file}`
            const ext = path.extname(file).toLowerCase() || '.png'
            const previewName = safeName(id).replace(/\.(png|webp|jpe?g)$/i, '') + ext
            fs.mkdirSync(PREVIEW_DIR, { recursive: true })
            try { fs.copyFileSync(src, path.join(PREVIEW_DIR, previewName)) } catch { /* 复制失败不阻塞入库 */ }
            const thumb = generateThumb(src, previewName)
            const shots = loadShots()
            const now = new Date().toISOString()
            const idx = shots.findIndex(s => s?.id === id)
            const base = idx >= 0 ? shots[idx] : {
              id, blocks: {}, swapTested: {}, status: 'draft', created: now,
              source: { folder, file, page: pageOf(file) >= 0 ? pageOf(file) : undefined, seed: seedOf(file) },
            }
            base.facets = d.facets ?? base.facets ?? {}
            base.preview = 'images/lazydog/' + previewName
            if (thumb) base.thumb = thumb
            if (d.note !== undefined) base.note = d.note
            // 散图库对齐:评分面板入库即可分大类/中类 + 打标签(无缝快速入库,不必再去散图库网页拖)
            if (d.category !== undefined) base.category = d.category
            if (d.subcategory !== undefined) base.subcategory = d.subcategory
            if (d.subsubcategory !== undefined) base.subsubcategory = d.subsubcategory
            if (d.tags !== undefined) base.tags = d.tags
            base.updated = now
            if (idx >= 0) shots[idx] = base; else shots.push(base)
            saveShots(shots)
            return send({ ok: true, shot: base })
          }
          // 清空垃圾桶:彻底删所有 trashed 条目 + 其预览图(不影响原出图)
          if (u.pathname === '/api/rating/trash-empty' && req.method === 'POST') {
            const shots = loadShots()
            const keep: typeof shots = []
            const trashed: { preview?: string; thumb?: string }[] = []
            let removed = 0
            for (const s of shots) {
              if (s?.trashed) { trashed.push({ preview: s.preview, thumb: s.thumb }); removed++ }
              else keep.push(s)
            }
            saveShots(keep)
            for (const t of trashed) unlinkPreviewIfFree(t.preview, t.thumb)  // 共享同一预览的副本/帧仍在则保活
            return send({ ok: true, removed })
          }
          // 移出库：删 shots 条目 + 预览图
          if (u.pathname === '/api/rating/lazy-remove' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const id = `${String(d.folder || '')}/${String(d.file || '')}`
            const shots = loadShots()
            const hit = shots.find(s => s?.id === id)
            saveShots(shots.filter(s => s?.id !== id))
            unlinkPreviewIfFree(hit?.preview, hit?.thumb)  // 仅当无副本/帧共享此预览时才删文件(铁律③)
            return send({ ok: true })
          }
          // ===== 套图库(和单图分开):按 source.folder 分套,叠加 sets_meta 元数据 =====
          // 全量读套图(组装好:cover/frames按序/count/title/order/trashed)
          if (u.pathname === '/api/rating/sets') {
            return send({ sets: buildSets(loadSets(), loadSetsMeta()) })
          }
          // 套图级元数据合并:{patch:{[setId]:{title?/cover?/order?/tags?/frameOrder?/trashed?}}}
          // 用于:套序(批量发 order)/帧序(发 frameOrder)/封面/改名/软删。只写 sets_meta.json(不碰 sets.json)
          if (u.pathname === '/api/rating/sets-meta' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const patch = (d.patch && typeof d.patch === 'object') ? d.patch : {}
            const meta = loadSetsMeta()
            const now = new Date().toISOString()
            for (const [id, p] of Object.entries(patch as Record<string, Record<string, unknown>>)) {
              const cur = meta[id] ?? {}
              for (const [k, v] of Object.entries(p)) {
                if (k === 'trashed') {
                  cur.trashed = !!v
                  if (v) cur.trashedAt = now; else delete cur.trashedAt
                } else if (k === 'frameMeta' && v && typeof v === 'object') {
                  // 帧级 meta 深合并(逐帧覆盖,不整块替换)
                  cur.frameMeta = { ...(cur.frameMeta ?? {}) }
                  for (const [fid, fmv] of Object.entries(v as Record<string, unknown>)) {
                    cur.frameMeta[fid] = { ...(cur.frameMeta[fid] ?? {}), ...(fmv as object) }
                  }
                } else if (v === null || v === undefined) { delete cur[k] }
                else cur[k] = v
              }
              meta[id] = cur
            }
            saveSetsMeta(meta)
            return send({ ok: true, sets: buildSets(loadSets(), meta) })
          }
          // 导入套图:把某评分文件夹整夹图片作为一套追加进 sets.json(复制预览,跳过已存帧)
          if (u.pathname === '/api/rating/set-import' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const folder = String(d.folder || '')
            if (!folder) return send({ error: 'folder required' }, 400)
            const dir = path.resolve(RATING_BASE, folder)
            if (!(dir.startsWith(path.resolve(RATING_BASE) + path.sep) && fs.existsSync(dir))) return send({ error: 'folder not found' }, 404)
            const natSort = (a: string, b: string) => a.localeCompare(b, 'zh', { numeric: true })
            const images = fs.readdirSync(dir).filter(isImg).sort(natSort)
            if (!images.length) return send({ error: 'no images in folder' }, 400)
            const sets = loadSets()
            const have = new Set(sets.map(s => s?.id))
            fs.mkdirSync(PREVIEW_DIR, { recursive: true })
            const now = new Date().toISOString()
            const work = folder.split('/').pop() || folder
            let added = 0
            for (const file of images) {
              const id = `${folder}/${file}`
              if (have.has(id)) continue
              const ext = path.extname(file).toLowerCase() || '.png'
              const previewName = safeName(id).replace(/\.(png|webp|jpe?g)$/i, '') + ext
              const srcFile = path.join(dir, file)
              try { fs.copyFileSync(srcFile, path.join(PREVIEW_DIR, previewName)) } catch { /* 复制失败不阻塞 */ }
              const thumbSet = generateThumb(srcFile, previewName)
              const entry: Record<string, unknown> = {
                id, facets: {}, blocks: {}, swapTested: {}, status: 'draft', created: now,
                preview: 'images/lazydog/' + previewName,
                source: { work, folder, file, page: pageOf(file) >= 0 ? pageOf(file) : undefined, seed: seedOf(file) },
              }
              if (thumbSet) entry.thumb = thumbSet
              sets.push(entry)
              added++
            }
            saveSets(sets)
            return send({ ok: true, added, id: folder, sets: buildSets(sets, loadSetsMeta()) })
          }
          // 彻底删整套:从 sets.json 移除该套全部帧 + 预览图 + meta 条目(不影响原出图)
          if (u.pathname === '/api/rating/set-remove' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const id = String(d.id || '')
            if (!id) return send({ error: 'id required' }, 400)
            const sets = loadSets()
            const keep = []
            const trashed: { preview?: string; thumb?: string }[] = []
            let removed = 0
            for (const s of sets) {
              if (s?.source?.folder === id) { trashed.push({ preview: s.preview, thumb: s.thumb }); removed++ }
              else keep.push(s)
            }
            saveSets(keep)
            const meta = loadSetsMeta(); delete meta[id]; saveSetsMeta(meta)
            for (const t of trashed) unlinkPreviewIfFree(t.preview, t.thumb)  // 共享预览的副本/单图仍在则保活
            return send({ ok: true, removed, sets: buildSets(keep, meta) })
          }
          // ===== 复制区 / 跨库副本(永久独立副本;副本共享原预览文件,不重复落盘) =====
          // 复制:从单图或套图帧建一份独立副本 → 写入 shots.json(默认 clip:true=进复制区)。原件不动。
          if (u.pathname === '/api/rating/shot-copy' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            if (!d.preview) return send({ error: 'preview required' }, 400)
            const shots = loadShots()
            const now = new Date().toISOString()
            const maxOrder = shots.reduce((m, s) => Math.max(m, typeof s?.order === 'number' ? s.order : 0), 0)
            const shot = {
              id: newCopyId(),
              facets: d.facets ?? {},
              blocks: d.blocks ?? {},
              preview: d.preview,                 // 共享原预览路径(副本不复制图片文件)
              source: d.source ?? { folder: '', file: d.title || 'copy' },
              swapTested: d.swapTested ?? {},
              status: d.status ?? 'confirmed',
              title: d.title ?? '',
              tags: d.tags ?? [],
              note: d.note ?? '',
              category: d.clip === false ? (d.category ?? '') : '',
              subcategory: '', subsubcategory: '',
              clip: d.clip !== false,             // 默认进复制区
              copyOf: d.fromId ?? undefined,      // 溯源
              order: maxOrder + 1,
              created: now, updated: now,
            }
            shots.push(shot)
            saveShots(shots)
            return send({ ok: true, shot })
          }
          // 删条目(按 id;副本/移动用)——默认不删预览(副本与原件共享同一预览文件)
          if (u.pathname === '/api/rating/shot-delete' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const id = String(d.id || '')
            if (!id) return send({ error: 'id required' }, 400)
            const shots = loadShots()
            const hit = shots.find(s => s?.id === id)
            saveShots(shots.filter(s => s?.id !== id))
            if (d.unlinkPreview) unlinkPreviewIfFree(hit?.preview)  // 共享预览仍被引用则不删文件
            return send({ ok: true })
          }
          // 套图增减帧:addFrames(粘进来的副本→extraFrames)/ removeFrameIds(自然帧→removed,副本帧→删)/ frameOrder
          // 全写 sets_meta(零碰 sets.json)。返回重建后的套图。
          if (u.pathname === '/api/rating/set-frames' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const setId = String(d.setId || '')
            if (!setId) return send({ error: 'setId required' }, 400)
            const meta = loadSetsMeta()
            const m = meta[setId] ?? {}
            const now = new Date().toISOString()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (Array.isArray(d.addFrames) && d.addFrames.length) {
              // 计算本套当前帧的最大有效序,新帧一律排其后=真·追加末尾。
              // 否则 buildSets 的 order2 会按副本继承的【原 source.page】排序,把追加帧拉进套图中间(常落第二张)。
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const naturals = loadSets().filter((f: any) => (f?.source?.folder || '') === setId)
              const removedSet = new Set<string>(m.removed ?? [])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const curFrames: any[] = [...naturals.filter((f: any) => !removedSet.has(f?.id)), ...(m.extraFrames ?? [])]
              const fo: Record<string, number> = m.frameOrder ?? {}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ordOf = (f: any) => fo[f.id] ?? (typeof f?.source?.page === 'number' ? f.source.page : 0)
              let maxOrd = curFrames.reduce((a, f) => Math.max(a, ordOf(f)), 0)
              const foPatch: Record<string, number> = {}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const adds = d.addFrames.map((a: any) => {
                const id = newCopyId()
                maxOrd += 1; foPatch[id] = maxOrd   // 显式赋序到末尾(后续手动拖排可覆盖)
                return {
                  id, facets: a.facets ?? {}, blocks: a.blocks ?? {},
                  preview: a.preview, source: a.source ?? { folder: setId, file: a.title || 'copy' },
                  swapTested: a.swapTested ?? {}, status: a.status ?? 'confirmed',
                  title: a.title ?? '', tags: a.tags ?? [], note: a.note ?? '',
                  copyOf: a.fromId ?? undefined, created: now,
                }
              })
              m.extraFrames = [...(m.extraFrames ?? []), ...adds]
              m.frameOrder = { ...(m.frameOrder ?? {}), ...foPatch }
            }
            if (Array.isArray(d.removeFrameIds) && d.removeFrameIds.length) {
              const extraIds = new Set((m.extraFrames ?? []).map((f: { id: string }) => f.id))
              const rmNatural: string[] = []
              for (const rid of d.removeFrameIds as string[]) {
                if (extraIds.has(rid)) m.extraFrames = (m.extraFrames ?? []).filter((f: { id: string }) => f.id !== rid)
                else rmNatural.push(rid)
              }
              if (rmNatural.length) m.removed = [...new Set([...(m.removed ?? []), ...rmNatural])]
            }
            if (d.frameOrder && typeof d.frameOrder === 'object') m.frameOrder = { ...(m.frameOrder ?? {}), ...d.frameOrder }
            meta[setId] = m
            saveSetsMeta(meta)
            return send({ ok: true, sets: buildSets(loadSets(), meta) })
          }
          // 帧 prompt 染色编辑器回写:按 id 在 sets.json 找【自然帧】,白名单合并 payload_src/slots/blocks(其余字段一律不动)。
          // 红线:绝不新建 payload_src(legacy 帧只改 slots/blocks)、绝不动 seed/params(原样copy红线)、characters 只收 text/negative/x/y。
          if (u.pathname === '/api/rating/set-frame-update' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const id = String(d.id || '')
            if (!id) return send({ error: 'id required' }, 400)
            const sets = loadSets()
            const idx = sets.findIndex(s => s?.id === id)
            if (idx < 0) return send({ error: 'frame not found' }, 404)
            const f = sets[idx]
            // payload_src:只准改 positive/negative(string)与 characters(数组整替);seed/params 不动;原本无 payload_src 不新建
            if (d.payload_src && typeof d.payload_src === 'object' && f.payload_src && typeof f.payload_src === 'object') {
              const p = d.payload_src
              if (typeof p.positive === 'string') f.payload_src.positive = p.positive
              if (typeof p.negative === 'string') f.payload_src.negative = p.negative
              if (Array.isArray(p.characters)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                f.payload_src.characters = p.characters.map((c: any) => {
                  const o: Record<string, unknown> = { text: typeof c?.text === 'string' ? c.text : '' }
                  if (typeof c?.negative === 'string') o.negative = c.negative
                  if (typeof c?.x === 'number') o.x = c.x
                  if (typeof c?.y === 'number') o.y = c.y
                  return o
                })
              }
            }
            // slots:白名单字符串槽(空串=删键)+ cast(string[])
            if (d.slots && typeof d.slots === 'object') {
              const cur = (f.slots && typeof f.slots === 'object') ? f.slots : (f.slots = {})
              for (const k of ['artist', 'character', 'clothing', 'scene', 'props', 'view', 'male'] as const) {
                if (d.slots[k] !== undefined) {
                  const v = typeof d.slots[k] === 'string' ? d.slots[k] : ''
                  if (v.trim() === '') delete cur[k]; else cur[k] = v
                }
              }
              if (d.slots.cast !== undefined) {
                if (Array.isArray(d.slots.cast)) {
                  const arr = d.slots.cast.map((x: unknown) => String(x)).filter((x: string) => x.trim() !== '')
                  if (arr.length) cur.cast = arr; else delete cur.cast
                }
              }
            }
            // blocks:白名单(空串=删键)
            if (d.blocks && typeof d.blocks === 'object') {
              const cur = (f.blocks && typeof f.blocks === 'object') ? f.blocks : (f.blocks = {})
              for (const k of ['action', 'expression', 'camera', 'effect'] as const) {
                if (d.blocks[k] !== undefined) {
                  const v = typeof d.blocks[k] === 'string' ? d.blocks[k] : ''
                  if (v.trim() === '') delete cur[k]; else cur[k] = v
                }
              }
            }
            // seg:分段视图(编辑用,跑图不读)。强校验 join('')===对应区域原文,不等即 400——
            // 分段脱节 = 前端按错的结构改槽,比不给功能更危险(lazydog_storage §4.6 分段铁律)。
            if (d.seg !== undefined) {
              if (d.seg === null) delete f.seg
              else if (typeof d.seg === 'object') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const norm = (arr: any): { cat: string; note?: string; text: string }[] | null => {
                  if (!Array.isArray(arr)) return null
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  return arr.map((x: any) => ({
                    cat: typeof x?.cat === 'string' ? x.cat : 'unknown',
                    ...(typeof x?.note === 'string' && x.note ? { note: x.note } : {}),
                    text: typeof x?.text === 'string' ? x.text : '',
                  }))
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const joined = (a: any) => (a ?? []).map((x: any) => x.text).join('')
                const ps = f.payload_src ?? {}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const out: any = {}
                let bad = ''
                const one = (key: 'positive' | 'negative', text: string) => {
                  const v = norm(d.seg[key]); if (!v || bad) return
                  if (joined(v) !== (text ?? '')) { bad = `seg.${key}`; return }
                  out[key] = v
                }
                one('positive', ps.positive)
                one('negative', ps.negative ?? '')
                for (const [key, pick] of [['chars', 'text'], ['charNegs', 'negative']] as const) {
                  if (bad || !Array.isArray(d.seg[key])) continue
                  const arr: unknown[] = []
                  for (let i = 0; i < d.seg[key].length; i++) {
                    const v = norm(d.seg[key][i]); if (!v) { arr.push(null); continue }
                    const src = String((ps.characters ?? [])[i]?.[pick] ?? '')
                    if (joined(v) !== src) { bad = `seg.${key}[${i}]`; break }
                    arr.push(v)
                  }
                  out[key] = arr
                }
                if (bad) return send({ error: `${bad} 拼接≠原文(分段脱节)` }, 400)
                f.seg = out
              }
            }
            f.updated = new Date().toISOString().slice(0, 10)   // 当天 ISO 日期
            sets[idx] = f
            saveSets(sets)
            return send({ ok: true, frame: f })
          }
          // ===== 三类套图·引用型组合(标准套图/原创套图;纯引用,lazydog_storage §4.8) =====
          // 全量读组合:成员回填预览/标题、孤儿过滤回 missingCount、original→standard 二级封面、cover 回退首个有效成员
          if (u.pathname === '/api/rating/compositions') {
            const comps = loadComps()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const map = new Map<string, any>()
            for (const s of loadShots()) if (s?.id) map.set(s.id, s)
            for (const s of loadSets()) if (s?.id) map.set(s.id, s)
            for (const m of Object.values(loadSetsMeta())) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const f of ((m as any)?.extraFrames ?? [])) if (f?.id) map.set(f.id, f)
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const compById = new Map<string, any>(comps.map((c: any) => [c.id, c]))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stdCover = (c: any): string => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ms = (c?.members ?? []).slice().sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0))
              const pick = (c?.cover && ms.find((x: { ref: string; kind: string }) => x.ref === c.cover.ref && x.kind === c.cover.kind)) || ms[0]
              for (const mm of [pick, ...ms].filter(Boolean)) { const sh = map.get(mm.ref); if (sh?.preview) return sh.preview }
              return ''
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const resolveMember = (m: any): any => {
              if (m?.kind === 'standard') {
                const c = compById.get(m.ref)
                if (!c || c.trashed) return { ...m, missing: true }
                return { ...m, mtitle: c.title || m.ref, preview: stdCover(c), missing: false }
              }
              const sh = map.get(m?.ref)
              if (!sh) return { ...m, missing: true }
              return { ...m, preview: sh.preview, mtitle: sh.title || sh.source?.file || m.ref, missing: false }
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const resolved = comps.map((c: any) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const members = (c.members ?? []).slice().sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0)).map(resolveMember)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const valid = members.filter((m: any) => !m.missing)
              let coverPreview = ''
              if (c.cover) { const cm = resolveMember(c.cover); if (!cm.missing) coverPreview = cm.preview || '' }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (!coverPreview) coverPreview = (valid.find((m: any) => m.preview)?.preview) || ''
              return { ...c, members, coverPreview, count: valid.length, missingCount: members.length - valid.length }
            })
            return send({ compositions: resolved })
          }
          // 新建/更新组合(逐条 upsert:标量字段合并 + members 整组替换)。强制分层防环:standard 不得引 standard
          if (u.pathname === '/api/rating/comp-save' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const inc = (d.comp && typeof d.comp === 'object') ? d.comp : d
            const comps = loadComps()
            const now = new Date().toISOString()
            const id = String(inc.id || '') || newCompId()
            const idx = comps.findIndex(c => c?.id === id)
            const cur = idx >= 0 ? comps[idx] : { id, type: inc.type === 'original' ? 'original' : 'standard', members: [], created: now }
            if (inc.type !== undefined) cur.type = inc.type === 'original' ? 'original' : 'standard'
            if (inc.title !== undefined) cur.title = inc.title
            if (inc.tags !== undefined) cur.tags = inc.tags
            if (inc.cover !== undefined) cur.cover = inc.cover
            // 套图分类(标准/原创套图也能挂大中小类,与复刻共用 set_categories 树)。空串=移回待部署区
            if (inc.category !== undefined) cur.category = inc.category
            if (inc.subcategory !== undefined) cur.subcategory = inc.subcategory
            if (inc.subsubcategory !== undefined) cur.subsubcategory = inc.subsubcategory
            if (inc.trashed !== undefined) { cur.trashed = !!inc.trashed; if (inc.trashed) cur.trashedAt = now; else delete cur.trashedAt }
            if (inc.members !== undefined) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ms: any[] = Array.isArray(inc.members) ? inc.members : []
              if (cur.type === 'standard' && ms.some(m => m?.kind === 'standard')) return send({ error: '标准套图不得引用标准套图(分层防环:标准是叶子)' }, 400)
              if (ms.some(m => !['shot', 'frame', 'standard'].includes(m?.kind))) return send({ error: 'member.kind 必须是 shot/frame/standard' }, 400)
              cur.members = ms.map((m, i) => ({ kind: m.kind, ref: String(m.ref || ''), seq: typeof m.seq === 'number' ? m.seq : i, ...(m.stage ? { stage: m.stage } : {}) }))
              // 封面成员若已不在新成员里,清掉(否则读侧封面失效、回退混乱)
              if (cur.cover && !cur.members.some((m: { kind: string; ref: string }) => m.kind === cur.cover.kind && m.ref === cur.cover.ref)) delete cur.cover
            }
            cur.updated = now
            if (idx >= 0) comps[idx] = cur; else comps.push(cur)
            saveComps(comps)
            return send({ ok: true, comp: cur })
          }
          // 删组合:软删(trashed)默认,hard=彻删。组合无预览不 unlink;被引成员不受影响(孤儿容错由读侧处理)
          if (u.pathname === '/api/rating/comp-delete' && req.method === 'POST') {
            const d = JSON.parse((await readBody()) || '{}')
            const id = String(d.id || '')
            if (!id) return send({ error: 'id required' }, 400)
            const comps = loadComps()
            if (d.hard) { saveComps(comps.filter(c => c?.id !== id)); return send({ ok: true, hard: true }) }
            const idx = comps.findIndex(c => c?.id === id)
            if (idx < 0) return send({ error: 'comp not found' }, 404)
            comps[idx].trashed = true; comps[idx].trashedAt = new Date().toISOString(); comps[idx].updated = comps[idx].trashedAt
            saveComps(comps)
            return send({ ok: true, comp: comps[idx] })
          }
          return send({ error: 'unknown rating endpoint' }, 404)
        } catch (err) {
          return send({ error: err instanceof Error ? err.message : String(err) }, 500)
        }
      })
    },
  }
}

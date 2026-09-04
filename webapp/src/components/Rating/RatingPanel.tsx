import { useState, useEffect, useCallback } from 'react'
import type { FacetVocab, FacetDef, FacetValue, ShotFacets, CatGroup } from '../../types/lazydog'
import { SUGGESTED_TAGS } from '../../lazydog/categories'

/** 画师评分面板（移植自 tools/rating_server.py）。
 *  扫 nai-output 各文件夹看图打分，实时落盘 internal-docs 直接读）。
 *  比对=路径自动匹配：后端按出图文件夹相对路径 + 页号到 reference/ 找同页原图，原图左·出图右。
 *  键盘：0=崩 / 2 3 4 5 打分 / ← → 切图 / Enter 存评语并下一张 / u 跳下一个未评。 */

type Folder = { name: string; count: number }
type Rec = { score?: number | string; comment?: string }
type Ratings = Record<string, Rec>
type Filter = 'all' | 'unrated' | 'rated'

function clean(n: string) {
  return n.replace(/_\d{8}_\d{6}_seed\d+\.(png|webp|jpe?g)$/i, '').replace(/\.(png|webp|jpe?g)$/i, '')
}

const CSS = `
.rating-panel{display:grid;grid-template-columns:minmax(0,1fr) 360px;height:calc(100vh - 112px);
  background:#1a1a1e;color:#e8e8ea;font-family:system-ui,"Microsoft YaHei",sans-serif;overflow:hidden;border-radius:8px}
.rating-panel *{box-sizing:border-box;min-width:0}
.rt-stage{display:flex;align-items:center;justify-content:center;padding:16px;background:#0e0e11;position:relative;overflow:hidden}
.rt-stage img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 4px 24px #000a}
.rt-nav{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:10px}
.rt-nav button{background:#2a2a32;color:#ddd;border:0;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:15px}
.rt-nav button:hover{background:#3a3a45}
.rt-side{padding:18px;overflow-y:auto;overflow-x:hidden;background:#202028;display:flex;flex-direction:column;gap:13px}
.rt-side *{max-width:100%}
.rt-side h2{margin:0;font-size:14px;color:#9aa}
.rt-row{display:flex;gap:6px;align-items:center}
.rt-side select{flex:1;background:#16161b;color:#e8e8ea;border:1px solid #3a3a45;border-radius:6px;padding:8px;font-size:13px}
.rt-mini{background:#2a2a32;color:#ccc;border:0;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.rt-mini:hover{background:#3a3a45}
.rt-prog{font-size:13px;color:#7a7a85}
.rt-meta{font-size:13px;line-height:1.6;background:#16161b;padding:10px 12px;border-radius:6px;word-break:break-all}
.rt-meta b{color:#ffd479}
.rt-scores{display:flex;gap:8px;flex-wrap:wrap}
.rt-scores button{flex:1;min-width:52px;padding:12px 0;border:2px solid #3a3a45;background:#26262e;color:#ddd;
  border-radius:8px;cursor:pointer;font-size:18px;font-weight:600}
.rt-scores button.crash{color:#ff7676}
.rt-scores button.on{background:#ffd479;color:#1a1a1e;border-color:#ffd479}
.rt-scores button.on.crash{background:#ff5555;color:#fff;border-color:#ff5555}
.rt-side textarea{width:100%;min-height:84px;background:#16161b;color:#e8e8ea;border:1px solid #3a3a45;border-radius:6px;
  padding:10px;font-size:14px;resize:vertical;font-family:inherit}
.rt-hint{font-size:12px;color:#666;line-height:1.7}
.rt-kbd{background:#33333c;padding:1px 7px;border-radius:4px;color:#bbb;font-family:monospace}
.rt-filter{display:flex;gap:6px}
.rt-filter button{flex:1;padding:6px;font-size:12px;background:#26262e;color:#aaa;border:1px solid #3a3a45;border-radius:5px;cursor:pointer}
.rt-filter button.on{background:#3a4a5a;color:#fff}
.rt-saved{font-size:12px;color:#6c6;height:14px}
.rt-mini.on{background:#3a4a5a;color:#fff}
.rt-stage.cmp{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:center}
.rt-half{display:flex;align-items:center;justify-content:center;height:100%;position:relative;min-width:0;padding:18px 0}
.rt-half img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 4px 24px #000a}
.rt-tag{position:absolute;top:8px;left:10px;max-width:calc(100% - 20px);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;background:#000b;color:#ffd479;font-size:12px;padding:2px 9px;border-radius:4px;z-index:1}
.rt-noimg{color:#777;font-size:14px;display:flex;flex-direction:column;align-items:center;gap:4px}
.rt-lazy{border:1px solid #3a3a45;border-radius:8px;background:#16161b;padding:11px 12px;display:flex;flex-direction:column;gap:9px}
.lz-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.lz-title{font-size:13px;font-weight:600;color:#8fd49a}
.lz-badge{font-size:11px;padding:2px 8px;border-radius:4px;background:#2a3a2c;color:#8fd49a}
.lz-badge.draft{background:#3a3528;color:#ffd479}
.lz-facet{display:flex;flex-direction:column;gap:4px}
.lz-head{font-size:12px;color:#9aa}.lz-head b{color:#ffd479;font-weight:600}
.lz-sub{font-size:11px;color:#6c6c78;margin:2px 0 0 2px}
.lz-chips{display:flex;flex-wrap:wrap;gap:5px}
.lz-chip{padding:4px 9px;border:1px solid #3a3a45;background:#23232b;color:#cfcfd6;border-radius:14px;cursor:pointer;font-size:12px;line-height:1.3}
.lz-chip:hover{border-color:#5a5a6a}
.lz-chip.on{background:#3a6a44;border-color:#4f8a5c;color:#fff}
.lz-btns{display:flex;gap:8px;margin-top:2px}
.lz-btns button{flex:1;padding:9px 0;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
.lz-save{background:#3a6a44;color:#fff}.lz-save:hover{background:#458052}
.lz-del{background:#5a2e2e;color:#ffcaca;flex:0 0 auto;padding:9px 14px}.lz-del:hover{background:#6e3838}
.lz-collapsed{font-size:12px;color:#8a8a95;cursor:pointer;text-align:center;padding:4px}
.lz-sel{width:100%;background:#16161b;color:#e8e8ea;border:1px solid #3a3a45;border-radius:6px;padding:7px;font-size:13px;margin-top:3px}
.lz-refresh{background:#2a2a32;color:#bcd;border:0;padding:3px 8px;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap}
.lz-refresh:hover{background:#3a3a45}
.lz-adv7-h{font-size:12px;color:#9aa;cursor:pointer;padding:5px 0;border-top:1px dashed #33333c;margin-top:2px}
.lz-chip.tag.on{background:#8a6a2a;border-color:#caa23a;color:#fff}
`

/** 懒狗入库打标:与散图库对齐 = 大类/中类(categories.json)+ 标签 + 入库;七面(facets.json)收进折叠。
 *  入库即可分类(无缝快速入库);「↻分类」刷新 categories,新建分类即时可用。 */
function LazyTagger({ vocab, cats, value, onChange, category, subcategory, subsubcategory, tags, onCat, onSub, onSubsub, onTags, onRefreshCats, inLib, status, saving, onSave, onRemove }: {
  vocab: FacetVocab; cats: CatGroup[]; value: ShotFacets; onChange: (v: ShotFacets) => void
  category: string; subcategory: string; subsubcategory: string; tags: string[]
  onCat: (v: string) => void; onSub: (v: string) => void; onSubsub: (v: string) => void; onTags: (v: string[]) => void; onRefreshCats: () => void
  inLib: boolean; status?: string; saving: boolean; onSave: () => void; onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [adv7, setAdv7] = useState(false)
  const group = cats.find(g => g.id === category)
  const sub = group?.subs.find(s => s.id === subcategory)
  const toggleTag = (t: string) => onTags(tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t])
  const toggle = (key: string, v: string, multi: boolean) => {
    const cur = value[key] || []
    const next = multi ? (cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]) : (cur[0] === v ? [] : [v])
    const out = { ...value, [key]: next }
    if (!next.length) delete out[key]
    onChange(out)
  }
  const chip = (key: string, fv: FacetValue, multi: boolean) => (
    <span key={fv.v} className={'lz-chip' + ((value[key] || []).includes(fv.v) ? ' on' : '')}
      onClick={() => toggle(key, fv.v, multi)}>{fv.zh}</span>
  )
  const renderFacet = (f: FacetDef) => {
    const gateVal = f.bifurcateBy ? (value[f.bifurcateBy]?.[0]) : undefined
    return (
      <div className="lz-facet" key={f.key}>
        <div className="lz-head"><b>{f.label}</b> {f.name}{f.multi ? '（多选）' : ''}{f.auto ? '' : ' ·人工'}</div>
        {f.values && <div className="lz-chips">{f.values.map(v => chip(f.key, v, f.multi))}</div>}
        {f.groups?.map((g, i) => {
          if (f.bifurcateBy && g.gate && gateVal && !g.gate.includes(gateVal)) return null
          return (
            <div key={i}>
              {g.name && <div className="lz-sub">{g.name}</div>}
              <div className="lz-chips">{g.values.map(v => chip(f.key, v, f.multi))}</div>
            </div>
          )
        })}
      </div>
    )
  }
  if (!open) {
    return <div className="rt-lazy">
      <div className="lz-collapsed" onClick={() => setOpen(true)}>
        🐕 懒狗入库打标 {inLib ? <span className="lz-badge">已入库</span> : '（点开）'}
      </div>
    </div>
  }
  return (
    <div className="rt-lazy">
      <div className="lz-top">
        <span className="lz-title">🐕 懒狗入库打标</span>
        {inLib && <span className={'lz-badge' + (status === 'draft' ? ' draft' : '')}>{status === 'draft' ? '草稿·待CC补骨架' : '已入库'}</span>}
        <button className="lz-refresh" title="在懒狗库新建大类/中类后,点这刷新即可分类" onClick={onRefreshCats}>↻分类</button>
        <span className="lz-collapsed" style={{ flex: '0 0 auto', padding: 0 }} onClick={() => setOpen(false)}>收起</span>
      </div>

      {/* 散图库分类:大类 → 中类 → 小类 */}
      <div className="lz-facet">
        <div className="lz-head"><b>大类</b> 懒狗库</div>
        <select className="lz-sel" value={group ? category : ''} onChange={e => { onCat(e.target.value); onSub(''); onSubsub('') }}>
          <option value="">（待部署区）</option>
          {cats.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {group && group.subs.length > 0 && (
          <select className="lz-sel" value={group.subs.some(s => s.id === subcategory) ? subcategory : ''} onChange={e => { onSub(e.target.value); onSubsub('') }}>
            <option value="">（不分中类）</option>
            {group.subs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {sub && (sub.subs ?? []).length > 0 && (
          <select className="lz-sel" value={(sub.subs ?? []).some(x => x.id === subsubcategory) ? subsubcategory : ''} onChange={e => onSubsub(e.target.value)}>
            <option value="">（不分小类）</option>
            {(sub.subs ?? []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
      </div>

      {/* 标签 */}
      <div className="lz-facet">
        <div className="lz-head"><b>标签</b></div>
        <div className="lz-chips">
          {[...new Set([...SUGGESTED_TAGS, ...tags])].map(t => (
            <span key={t} className={'lz-chip tag' + (tags.includes(t) ? ' on' : '')} onClick={() => toggleTag(t)}>{t}</span>
          ))}
        </div>
      </div>

      {/* 七面收进折叠(拼剧本用,可由 CC 自动录入) */}
      <div className="lz-adv7-h" onClick={() => setAdv7(a => !a)}>{adv7 ? '▾' : '▸'} 高级 · 骨架七面（拼剧本用）</div>
      {adv7 && vocab.facets.map(renderFacet)}

      <div className="lz-btns">
        <button className="lz-save" disabled={saving} onClick={onSave}>{saving ? '保存中…' : inLib ? '更新入库' : '📥 入库'}</button>
        {inLib && <button className="lz-del" disabled={saving} onClick={onRemove}>移出</button>}
      </div>
    </div>
  )
}

export default function RatingPanel({ active = true }: { active?: boolean } = {}) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [folder, setFolder] = useState('')
  const [imgs, setImgs] = useState<string[]>([])
  const [ratings, setRatings] = useState<Ratings>({})
  const [origs, setOrigs] = useState<Record<string, string | null>>({})
  const [hasOrig, setHasOrig] = useState(false)
  const [idx, setIdx] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [cmt, setCmt] = useState('')
  const [saved, setSaved] = useState('')
  // 比对：单一开关，切文件夹保持（持久化到 localStorage，跨标签/重挂载也保留）
  const [compare, setCompare] = useState(() => localStorage.getItem('rt-compare') === '1')
  useEffect(() => { localStorage.setItem('rt-compare', compare ? '1' : '0') }, [compare])
  // 懒狗入库:七面词表 + 散图库大类树 + 本文件夹各图入库状态 + 当前图正在编辑的 facets/分类/标签
  const [vocab, setVocab] = useState<FacetVocab | null>(null)
  const [cats, setCats] = useState<CatGroup[]>([])
  const [shots, setShots] = useState<Record<string, { facets: ShotFacets; status: string; note?: string; category?: string; subcategory?: string; subsubcategory?: string; tags?: string[] }>>({})
  const [facets, setFacets] = useState<ShotFacets>({})
  const [category, setCategory] = useState('')
  const [subcategory, setSubcategory] = useState('')
  const [subsubcategory, setSubsubcategory] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [lazySaving, setLazySaving] = useState(false)

  const imgUrl = (fld: string, name: string) =>
    '/api/rating/img?folder=' + encodeURIComponent(fld) + '&name=' + encodeURIComponent(name)
  const origUrl = (fld: string, name: string) =>
    '/api/rating/orig?folder=' + encodeURIComponent(fld) + '&name=' + encodeURIComponent(name)

  const loadFolders = useCallback(async () => {
    try {
      const d = await (await fetch('/api/rating/folders')).json()
      const fs: Folder[] = d.folders || []
      setFolders(fs)
      setFolder(prev => prev || (fs[0]?.name ?? ''))
    } catch { /* ignore */ }
  }, [])

  const loadList = useCallback(async (fld: string) => {
    if (!fld) return
    try {
      const d = await (await fetch('/api/rating/list?folder=' + encodeURIComponent(fld))).json()
      setImgs(d.images || [])
      setRatings(d.ratings || {})
      setOrigs(d.origs || {})
      setHasOrig(!!d.hasOrig)
      setIdx(0)
    } catch { /* ignore */ }
    try {
      const s = await (await fetch('/api/rating/shots?folder=' + encodeURIComponent(fld))).json()
      setShots(s.shots || {})
    } catch { /* ignore */ }
  }, [])

  const loadCats = useCallback(async () => {
    try { const d = await (await fetch('/api/rating/categories')).json(); setCats(d.groups || []) } catch { /* ignore */ }
  }, [])
  // 刷新散图库分类 + 本文件夹入库状态(在散图库网页新建大类/中类后点这,即时可分类)
  const refreshLib = useCallback(async () => {
    await loadCats()
    if (folder) { try { const s = await (await fetch('/api/rating/shots?folder=' + encodeURIComponent(folder))).json(); setShots(s.shots || {}) } catch { /* ignore */ } }
  }, [loadCats, folder])

  useEffect(() => { loadFolders() }, [loadFolders])
  useEffect(() => { if (folder) loadList(folder) }, [folder, loadList])
  useEffect(() => { fetch('/api/rating/facets').then(r => r.json()).then(setVocab).catch(() => { }) }, [])
  useEffect(() => { loadCats() }, [loadCats])

  const view = imgs.filter(n => filter === 'all' || (filter === 'unrated' && !ratings[n]) || (filter === 'rated' && ratings[n]))
  const realView = view.length ? view : imgs
  const safeIdx = idx >= realView.length ? 0 : idx
  const cur = realView[safeIdx] as string | undefined

  // 切图/换文件夹时载入该图已存评语；打分(ratings 变但 cur 不变)时不重置，保留正在输入的评语
  useEffect(() => { setCmt(cur ? (ratings[cur]?.comment ?? '') : ''); setSaved('') }, [cur])  // eslint-disable-line react-hooks/exhaustive-deps
  // 切图/入库状态变化 → 回填该图已录 facets/分类/标签（编辑中 shots 不变故不打断；存盘后等值不抖）
  useEffect(() => {
    const s = cur ? shots[cur] : undefined
    setFacets(s?.facets ?? {})
    setCategory(s?.category ?? ''); setSubcategory(s?.subcategory ?? '')
    setSubsubcategory(s?.subsubcategory ?? ''); setTags(s?.tags ?? [])
  }, [cur, shots])

  const saveLazy = useCallback(async () => {
    if (!cur) return
    setLazySaving(true)
    try {
      const d = await (await fetch('/api/rating/lazy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, file: cur, facets, category, subcategory, subsubcategory, tags }),
      })).json()
      if (d?.shot) setShots(p => ({ ...p, [cur]: { facets: d.shot.facets || {}, status: d.shot.status, note: d.shot.note, category: d.shot.category, subcategory: d.shot.subcategory, subsubcategory: d.shot.subsubcategory, tags: d.shot.tags } }))
    } catch { /* ignore */ }
    setLazySaving(false)
  }, [cur, folder, facets, category, subcategory, subsubcategory, tags])

  const removeLazy = useCallback(async () => {
    if (!cur) return
    setLazySaving(true)
    try {
      await fetch('/api/rating/lazy-remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, file: cur }),
      })
      setShots(p => { const n = { ...p }; delete n[cur]; return n })
    } catch { /* ignore */ }
    setLazySaving(false)
  }, [cur, folder])

  const post = useCallback(async (file: string, score: number | string | null, comment: string | null) => {
    try {
      const d = await (await fetch('/api/rating/rate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, file, score, comment }),
      })).json()
      setRatings(d.ratings || {})
      setSaved('✓ 已保存'); setTimeout(() => setSaved(''), 1200)
    } catch { /* ignore */ }
  }, [folder])

  const go = useCallback((d: number) => { if (realView.length) setIdx(i => (i + d + realView.length) % realView.length) }, [realView.length])
  // 切图包/文件夹：在 folders 里按当前 folder 索引 ±d 循环取 name（<2 个不动）
  const goFolder = useCallback((d: number) => {
    if (folders.length < 2) return
    const i = folders.findIndex(f => f.name === folder)
    setFolder(folders[((i < 0 ? 0 : i) + d + folders.length) % folders.length].name)
  }, [folders, folder])
  const rate = useCallback((s: number | string) => { if (cur) post(cur, s, null) }, [cur, post])
  const saveComment = useCallback((adv: boolean) => { if (cur) { post(cur, null, cmt); if (adv) go(1) } }, [cur, cmt, post, go])
  const nextUnrated = useCallback(() => {
    for (let i = 1; i <= realView.length; i++) { const j = (safeIdx + i) % realView.length; if (!ratings[realView[j]]) { setIdx(j); return } }
  }, [realView, safeIdx, ratings])

  useEffect(() => {
    // keep-alive：本面板隐藏时(active=false)不挂全局键盘监听，
    // 否则在别的 tab 按数字键会静默写打分、方向键乱跳
    if (!active) return
    const h = (e: KeyboardEvent) => {
      const t = (document.activeElement?.tagName || '')
      if (t === 'TEXTAREA' || t === 'SELECT' || t === 'INPUT') return
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey  // wasd 仅响应无修饰键的小写按键
      // ←/a 上一张 · →/d 下一张 · ↑/w 上一图包 · ↓/s 下一图包
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); goFolder(-1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); goFolder(1) }
      else if (plain && e.key === 'a') go(-1)
      else if (plain && e.key === 'd') go(1)
      else if (plain && e.key === 'w') goFolder(-1)
      else if (plain && e.key === 's') goFolder(1)
      else if (e.key === '0') rate('崩')
      else if (['2', '3', '4', '5'].includes(e.key)) rate(parseInt(e.key))
      else if (e.key === 'u') nextUnrated()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [active, go, goFolder, rate, nextUnrated])

  const ratedCount = imgs.filter(x => ratings[x]).length
  const rec = cur ? (ratings[cur] || {}) : {}

  // 比对开启且有当前图 → 并排：原图左 / 出图右。原图按页号自动匹配，无则左侧提示无原图
  const split = compare && !!cur
  const origName = cur ? origs[cur] : null

  return (
    <div className="rating-panel">
      <style>{CSS}</style>
      <div className={'rt-stage' + (split ? ' cmp' : '')}>
        {split ? (
          <>
            <div className="rt-half">
              <span className="rt-tag">原图（左）{origName ? '' : ' · 无'}</span>
              {origName
                ? <img src={origUrl(folder, origName)} alt={origName} />
                : <div className="rt-noimg"><span style={{ fontSize: 22 }}>—</span><span>该页无原图</span></div>}
            </div>
            <div className="rt-half">
              <span className="rt-tag">出图（右）·评分中</span>
              <img src={imgUrl(folder, cur!)} alt={cur} />
            </div>
          </>
        ) : cur ? (
          <img src={imgUrl(folder, cur)} alt={cur} />
        ) : <div style={{ color: '#666' }}>（此文件夹暂无图）</div>}
        <div className="rt-nav">
          <button onClick={() => go(-1)}>◀ 上一张 (←)</button>
          <button onClick={() => go(1)}>下一张 (→)</button>
        </div>
      </div>
      <div className="rt-side">
        <h2>画师评分</h2>
        <div className="rt-row">
          <select
            value={folder}
            onChange={e => { setFolder(e.target.value); setIdx(0); e.target.blur() }}
          >
            {folders.map(f => <option key={f.name} value={f.name}>{f.name}（{f.count}）</option>)}
          </select>
          <button className="rt-mini" onClick={loadFolders} title="跑出新一轮后点这个刷新">↻ 刷新</button>
          <button
            className={'rt-mini' + (compare ? ' on' : '')}
            onClick={() => setCompare(v => !v)}
            title="开启=原图左·出图右并排（按页号自动匹配原图）；切文件夹保持此开关"
          >{compare ? '比对 ✓' : '比对'}</button>
        </div>
        {compare && (
          <div className="rt-prog">
            比对已开 · {hasOrig ? '原图左 / 出图右（按页号自动匹配）' : '⚠ 本组无原图（仍显示出图）'}
          </div>
        )}
        <div className="rt-prog">
          {realView.length ? `第 ${safeIdx + 1} / ${realView.length} 张（${filter}）｜全库已评 ${ratedCount} / ${imgs.length}` : '—'}
        </div>
        <div className="rt-filter">
          {(['all', 'unrated', 'rated'] as Filter[]).map(f => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => { setFilter(f); setIdx(0) }}>
              {f === 'all' ? '全部' : f === 'unrated' ? '仅未评' : '仅已评'}
            </button>
          ))}
        </div>
        <div className="rt-meta"><b>{cur ? clean(cur) : ''}</b></div>
        <div className="rt-scores">
          <button className={'crash' + (String(rec.score) === '崩' ? ' on' : '')} onClick={() => rate('崩')}>崩</button>
          {[2, 3, 4, 5].map(s => (
            <button key={s} className={String(rec.score) === String(s) ? 'on' : ''} onClick={() => rate(s)}>{s}</button>
          ))}
        </div>
        <textarea
          value={cmt}
          placeholder="评语（Enter 保存并下一张，Shift+Enter 换行）"
          onChange={e => setCmt(e.target.value)}
          onBlur={() => saveComment(false)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveComment(true) } }}
        />
        <div className="rt-saved">{saved}</div>
        {vocab && cur && (
          <LazyTagger
            vocab={vocab} cats={cats} value={facets} onChange={setFacets}
            category={category} subcategory={subcategory} subsubcategory={subsubcategory} tags={tags}
            onCat={setCategory} onSub={setSubcategory} onSubsub={setSubsubcategory} onTags={setTags} onRefreshCats={refreshLib}
            inLib={!!shots[cur]} status={shots[cur]?.status} saving={lazySaving}
            onSave={saveLazy} onRemove={removeLazy}
          />
        )}
        <div className="rt-hint">
          <span className="rt-kbd">0</span>崩 <span className="rt-kbd">2</span>~<span className="rt-kbd">5</span>打分{' '}
          <span className="rt-kbd">←</span><span className="rt-kbd">→</span>/<span className="rt-kbd">a</span><span className="rt-kbd">d</span>切图{' '}
          <span className="rt-kbd">↑</span><span className="rt-kbd">↓</span>/<span className="rt-kbd">w</span><span className="rt-kbd">s</span>切图包{' '}
          <span className="rt-kbd">Enter</span>存评语+下一张 <span className="rt-kbd">u</span>下一个未评<br />
          比对：点「比对」开/关，原图左·出图右，按页号(_pNN)自动匹配 reference/ 同相对路径下的原图；切文件夹保持开关<br />
          评分实时存 internal-docs
        </div>
      </div>
    </div>
  )
}

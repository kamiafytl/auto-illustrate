import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FacetVocab, FacetDef, FacetValue, LazyShot, CatGroup, ResolvedComp, ResolvedMember, CompMember } from '../types/lazydog'
import { STAGING, SUGGESTED_TAGS, PALETTE, newId } from './categories'
import { buildCtx, type Region, type Category, autoSegs, joinSegs, segsMatch, type Seg } from './promptTokens'
import type { useNaiBatch } from '../hooks/useNaiBatch'
import { lazyShotToBatchItem } from './lazyShotToBatch'
import { copyText } from '../utils/clipboard'

// 懒狗·散图库(精品库) —— 看图派手拖画廊
//  · 单图:大类→中类→小类 三层;待部署区(左 dock)拖进各层;分类可增删改名+拖动排序;卡片完整大图、快捷标签。
//  · 套图:与单图分开的库,按 source.folder 分套;点封面进套看每帧(可拖排序);套图本身可拖排序;可导入整夹为一套。
// 数据:GET /api/rating/{facets,shots-all,categories,sets}
//      POST /api/rating/{shot-update,shots-arrange,categories-save,lazy-remove,sets-meta,set-import,set-remove}

type BlockKey = 'action' | 'expression' | 'camera' | 'effect'
const BLOCK_KEYS: { k: BlockKey; label: string }[] = [
  { k: 'action', label: '动作' }, { k: 'expression', label: '表情' },
  { k: 'camera', label: '机位' }, { k: 'effect', label: '效果' },
]
type Size = 'sm' | 'md' | 'lg'
const BIG = Number.MAX_SAFE_INTEGER
const SEP = '\x1f'
const bk = (cat: string, sub = '', subsub = '') => [cat, sub, subsub].join(SEP)   // bucket key

// 落点统一语义:把 moved 插到 beforeId【之前】;beforeId=null/'__end__' 即末尾。
// 位置式排序不再分"往前/往后",由光标在哪决定,所以一个函数就够。
function placeBefore<T extends { id: string }>(list: T[], moved: T, beforeId: string | null): T[] {
  const reduced = list.filter(x => x.id !== moved.id)
  if (!beforeId || beforeId === '__end__') return [...reduced, moved]
  const at = reduced.findIndex(x => x.id === beforeId)
  if (at < 0) return [...reduced, moved]
  reduced.splice(at, 0, moved)
  return reduced
}

// 拖拽中的实时预览顺序(手机式:实时把被拖项移到光标算出的落点)。
// beforeId=null 表示"还没移到任何目标"→保持原序不预览;'__end__'=末尾。
function previewList<T extends { id: string }>(list: T[], movedId: string | null, beforeId: string | null): T[] {
  if (!movedId || !beforeId) return list
  const moved = list.find(x => x.id === movedId); if (!moved) return list   // 跨桶拖:本列表无此项,不预览
  return placeBefore(list, moved, beforeId)
}

// 按光标位置在容器内算落点:返回应插到其【之前】的卡片 id;越过全部卡片=末尾('__end__')。
// 排除被拖卡片本身。阈值=每张卡的中线(单一阈值→不抖动;光标往回移会自然回到原序=可还原)。
function pickBefore(container: HTMLElement, x: number, y: number, movedId: string | null): string | '__end__' {
  const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-lzid]'))
  for (const el of cards) {
    const id = el.dataset.lzid
    if (!id || id === movedId) continue
    const r = el.getBoundingClientRect()
    // 光标是否已"越过"这张卡(更靠后):在它下一行 → 是;在它上一行 → 否;同一行 → 看是否过其水平中线。
    const after = y >= r.bottom ? true : y < r.top ? false : x > r.left + r.width / 2
    if (!after) return id   // 第一张光标还没越过的卡 → 插在它前面
  }
  return '__end__'
}

// 悬浮大图:测量自身尺寸后夹取位置,保证整图始终在视口内(不会超出顶部/边缘)
function ZoomLayer({ src, x, y }: { src: string; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; vis: boolean }>({ left: -9999, top: -9999, vis: false })
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    const vw = window.innerWidth, vh = window.innerHeight, M = 12
    const right = x > vw / 2
    const left = Math.max(M, Math.min(right ? x - 28 - w : x + 28, vw - w - M))
    const top = Math.max(M, Math.min(y - h / 2, vh - h - M))
    setPos({ left, top, vis: true })
  }, [src, x, y])
  return (
    <div ref={ref} className="lz-zoom" style={{ left: pos.left, top: pos.top, visibility: pos.vis ? 'visible' : 'hidden' }}>
      <img src={'/' + src} alt="" />
    </div>
  )
}

// ============ 帧 prompt 染色编辑器(tokenizer/分类=promptTokens.ts) ============
// 点开任一帧 → 按槽归属【染色】每个 token(肉眼分辨换槽会换掉的词 vs 永远保留的骨架),可直接编辑。
// 数据源=payload_src(正/负向 base + 逐角色 caption)+ blocks/slots,全是 sets.json/shots.json 公开内容。
// ⚠ __PRIVATE_xxx__ 占位符:norm 后仍是普通字符串,不命中任何槽→琥珀 unknown,原样显示原样保存,绝不解析(隐私红线)。
// editable=true(帧抽屉里的自然帧,非 copy_)→ 全套编辑 + 防抖回写 set-frame-update;否则只读染色。
interface FrameDraft {
  positive: string
  negative: string
  characters: { text: string; negative?: string; x?: number; y?: number }[]
  slots: Record<string, unknown>
  blocks: Record<string, string>
  /** 分段视图(按 RegKey 扁平存;保存时转成 shot.seg 的分区域结构)。空=该区域未分段。 */
  segs: Record<string, Seg[]>
}
/** set-frame-update 提交体(端点白名单同款;seg=null 表示清除分段)。 */
export interface FramePatch {
  id: string
  payload_src?: LazyShot['payload_src']
  slots?: LazyShot['slots']
  blocks?: LazyShot['blocks']
  seg?: LazyShot['seg'] | null
}
type RegKey = string   // 'positive' | 'negative' | 'char:N' | 'charNeg:N'

// 「归槽」可选项(→ {cat,note});addCat 默认索引=11(不明)
const REASSIGN: { label: string; cat: Category; note?: string }[] = [
  { label: '画师', cat: 'artist' }, { label: '角色', cat: 'character' }, { label: '衣服', cat: 'clothing' },
  { label: '场景', cat: 'scene' }, { label: '道具', cat: 'props' },
  { label: '动作·骨架', cat: 'skeleton', note: '动作' }, { label: '表情·骨架', cat: 'skeleton', note: '表情' },
  { label: '机位·骨架', cat: 'skeleton', note: '机位' }, { label: '效果·骨架', cat: 'skeleton', note: '效果' },
  { label: '男角·骨架', cat: 'skeleton', note: '男角' }, { label: '质量', cat: 'quality' }, { label: '不明', cat: 'unknown' },
]

// —— 槽/块字符串增删改(染色【双层同步】:改 payload token 时连带改 slots.X/blocks.X;逗号切,重组用 ', ') ——
const getRegion = (d: FrameDraft, key: RegKey): string => {
  if (key === 'positive') return d.positive
  if (key === 'negative') return d.negative
  const [kind, i] = key.split(':'); const idx = +i
  return kind === 'char' ? (d.characters[idx]?.text ?? '') : (d.characters[idx]?.negative ?? '')
}
const setRegion = (d: FrameDraft, key: RegKey, val: string): FrameDraft => {
  if (key === 'positive') return { ...d, positive: val }
  if (key === 'negative') return { ...d, negative: val }
  const [kind, i] = key.split(':'); const idx = +i
  const characters = d.characters.map((c, j) => j === idx ? { ...c, [kind === 'char' ? 'text' : 'negative']: val } : c)
  return { ...d, characters }
}
const regionOf = (key: RegKey): Region =>
  key === 'negative' ? 'negative' : key.startsWith('charNeg') ? 'charNeg' : key.startsWith('char') ? 'char' : 'positive'

// 槽/块行两组显示(存储不动:json 里 slots 六桶 + blocks 四块照旧,只是显示上按「换槽时是否被替换」分组):
//  组一=可换槽(画师/角色/衣服/场景/道具 + 元数据 视角/出场);组二=骨架(动作/表情/机位/效果 + 男角,永远保留)

function PromptView({ shot, editable = false, onSave }: {
  shot: LazyShot
  editable?: boolean
  onSave?: (patch: FramePatch) => Promise<boolean>
}) {
  const hasPayload = !!shot.payload_src
  const dkey = 'lz_frame_draft:' + shot.id
  const initFrom = useCallback((s: LazyShot): FrameDraft => {
    // shot.seg(分区域) → draft.segs(按 RegKey 扁平)
    const segs: Record<string, Seg[]> = {}
    const sg = s.seg
    if (sg?.positive) segs.positive = sg.positive as Seg[]
    if (sg?.negative) segs.negative = sg.negative as Seg[]
    ;(sg?.chars ?? []).forEach((v, i) => { if (v) segs['char:' + i] = v as Seg[] })
    ;(sg?.charNegs ?? []).forEach((v, i) => { if (v) segs['charNeg:' + i] = v as Seg[] })
    return {
      positive: s.payload_src?.positive ?? '',
      negative: s.payload_src?.negative ?? '',
      characters: (s.payload_src?.characters ?? []).map(c => ({ text: c.text ?? '', negative: c.negative, x: c.x, y: c.y })),
      slots: { ...(s.slots ?? {}) },
      blocks: { ...(s.blocks ?? {}) },
      segs,
    }
  }, [])

  const [draft, setDraftState] = useState<FrameDraft>(() => initFrom(shot))
  const draftRef = useRef(draft)
  const [rawEdits, setRawEdits] = useState<Record<string, string>>({})
  const [groupEdits, setGroupEdits] = useState<Record<string, string>>({})   // 分组框的编辑暂存(onBlur 才落库)
  const [restored, setRestored] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const [copied, setCopied] = useState('')
  const timer = useRef<number | undefined>(undefined)

  // shot.id 变 → 重置(editable 时尝试恢复 localStorage 草稿)
  useEffect(() => {
    const server = initFrom(shot)
    let next = server, isRestored = false
    if (editable) {
      try {
        const raw = localStorage.getItem('lz_frame_draft:' + shot.id)
        if (raw) { const saved = JSON.parse(raw) as FrameDraft; if (JSON.stringify(saved) !== JSON.stringify(server)) { next = saved; isRestored = true } }
      } catch { /* 草稿损坏忽略 */ }
    }
    draftRef.current = next; setDraftState(next); setRestored(isRestored); setSaveState(isRestored ? 'dirty' : 'idle')
    setRawEdits({}); setGroupEdits({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot.id])

  const buildPatch = (d: FrameDraft) => {
    const patch: FramePatch = { id: shot.id, slots: d.slots as LazyShot['slots'], blocks: d.blocks as LazyShot['blocks'] }
    if (hasPayload) {
      const ps: LazyShot['payload_src'] = {
        positive: d.positive,
        characters: d.characters.map(c => ({ text: c.text, ...(c.negative != null ? { negative: c.negative } : {}), ...(c.x != null ? { x: c.x } : {}), ...(c.y != null ? { y: c.y } : {}) })),
      }
      if (d.negative && d.negative.trim()) ps.negative = d.negative
      patch.payload_src = ps
      // 分段:扁平 → 分区域;只提交与当前文本一致的(脱节的宁可不存,端点也会拒)
      const nChar = d.characters.length
      const pick = (k: string, txt: string) => (segsMatch(d.segs[k], txt) ? d.segs[k] : undefined)
      const seg: NonNullable<LazyShot['seg']> = {}
      const pos = pick('positive', d.positive); if (pos) seg.positive = pos
      const neg = pick('negative', d.negative); if (neg) seg.negative = neg
      const chars = Array.from({ length: nChar }, (_, i) => pick('char:' + i, d.characters[i].text) ?? null)
      const cnegs = Array.from({ length: nChar }, (_, i) => pick('charNeg:' + i, d.characters[i].negative ?? '') ?? null)
      if (chars.some(Boolean)) seg.chars = chars as NonNullable<LazyShot['seg']>['chars']
      if (cnegs.some(Boolean)) seg.charNegs = cnegs as NonNullable<LazyShot['seg']>['charNegs']
      patch.seg = Object.keys(seg).length ? seg : null
    }
    return patch
  }
  const doSave = useCallback(async (d: FrameDraft) => {
    if (!onSave) return
    setSaveState('saving')
    let ok = false
    try { ok = await onSave(buildPatch(d)) } catch { ok = false }
    setSaveState(ok ? 'saved' : 'error')
    if (ok) { setRestored(false); try { localStorage.removeItem(dkey) } catch { /* ignore */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSave, shot.id, hasPayload])
  const scheduleSave = useCallback((d: FrameDraft) => {
    try { localStorage.setItem(dkey, JSON.stringify(d)) } catch { /* 配额满忽略 */ }
    setSaveState('dirty')
    if (!editable || !onSave) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => doSave(draftRef.current), 600)
  }, [editable, onSave, dkey, doSave])
  const apply = useCallback((fn: (d: FrameDraft) => FrameDraft) => {
    const nd = fn(draftRef.current); draftRef.current = nd; setDraftState(nd); scheduleSave(nd)
  }, [scheduleSave])
  const retry = () => doSave(draftRef.current)


  // —— 离散 token 操作(全走 apply → 防抖保存;双层同步在此收口) ——
  const setSlot = (k: string, v: string) => apply(d => { const slots = { ...d.slots }; if (v.trim()) slots[k] = v; else delete slots[k]; return { ...d, slots } })
  const setCast = (v: string) => apply(d => { const slots = { ...d.slots }; const arr = v.split(',').map(s => s.trim()).filter(Boolean); if (arr.length) slots.cast = arr; else delete slots.cast; return { ...d, slots } })

  const copy = (text: string, k: string) => {
    if (!text) return
    void copyText(text).then(ok => { if (!ok) return; setCopied(k); setTimeout(() => setCopied(c => (c === k ? '' : c)), 1200) })
  }
  const cbtn = (text: string, k: string) => (
    <button className="lz-copybtn" onClick={e => { e.preventDefault(); copy(text, k) }} disabled={!text}>{copied === k ? '✓' : '复制'}</button>
  )

  // —— 分段操作（seg=真相源：payload 永远 = 各段 join('')，改段即改 payload）——
  const applySegs = (d: FrameDraft, key: RegKey, segs: Seg[]): FrameDraft => {
    const nd = setRegion(d, key, joinSegs(segs))
    return { ...nd, segs: { ...nd.segs, [key]: segs } }
  }
  const reSeg = (key: RegKey) => apply(d =>
    applySegs(d, key, autoSegs(getRegion(d, key), buildCtx(d.slots, d.blocks), regionOf(key))))
  const segMut = (key: RegKey, fn: (cur: Seg[]) => Seg[] | null, keepText = false) => apply(d => {
    const cur = d.segs[key] ?? []
    const next = fn([...cur]); if (!next) return d
    return keepText ? { ...d, segs: { ...d.segs, [key]: next } } : applySegs(d, key, next)
  })
  const segCat = (key: RegKey, i: number, r: { cat: Category; note?: string }) =>
    segMut(key, cur => { if (!cur[i]) return null; cur[i] = { cat: r.cat, ...(r.note ? { note: r.note } : {}), text: cur[i].text }; return cur }, true)
  const segIdx = (sg: Seg) => {
    const i = REASSIGN.findIndex(r => r.cat === sg.cat && (r.note ?? '') === (sg.note ?? ''))
    return i < 0 ? REASSIGN.length - 1 : i
  }
  // 槽参数行（道具保留/衣服剥离/视角/出场/男角）——这些是跑图参数，不是 prompt 内容
  const metaRow = (key: string, label: string, val: string, colorCls: string, onChange: (v: string) => void,
                   note?: string, input?: { placeholder: string }, _p?: boolean) => {
    if (!editable && !val) return null
    return (
      <div className={'lz-e-prow ' + colorCls} key={key}>
        <span className="lz-e-pk">{label}{note && <em>{note}</em>}</span>
        {editable
          ? (input ? <input value={val} placeholder={input.placeholder} onChange={e => onChange(e.target.value)} />
            : <textarea rows={1} value={val} onChange={e => onChange(e.target.value)} />)
          : <div className="lz-e-pv">{val}</div>}
      </div>
    )
  }

  // ============ 编辑界面（2026-08-28 Owner 定：只留这一个视图，按固定顺序分组，肉眼直接改） ============
  // 顺序 = 画师串 → 正向base(骨架) → 基础角色 → 衣服 → 场景 → 道具 → 其他 → 基础负面
  //        → 角色N(角色特征/衣服/道具/骨架/其他) → 角色N负面
  // 显示按槽分组，但【payload 里的原顺序一个字不动】——编辑按片段在原文里的位置回写。
  const GROUP_LABEL: Record<string, string> = {
    artist: '画师串', skeleton: '正向 base · 骨架', character: '角色特征', clothing: '衣服',
    scene: '场景', props: '道具', quality: '质量词', unknown: '未归类', syntax: '空白',
  }
  const BASE_ORDER = ['artist', 'skeleton', 'character', 'clothing', 'scene', 'props', 'quality', 'unknown', 'syntax']
  const CHAR_ORDER = ['character', 'clothing', 'props', 'skeleton', 'quality', 'unknown', 'syntax']

  const groupOf = (key: RegKey) => {
    const segs = draft.segs[key] ?? []
    const m: Record<string, { idx: number; sg: Seg }[]> = {}
    segs.forEach((sg, idx) => { (m[sg.cat] ??= []).push({ idx, sg }) })
    return m
  }


  // 一个槽 = 一个框（2026-08-28：不要每段一个框）。
  // 该槽的段可能散在原文各处 → 框里显示的是它们拼起来的内容；改完落库时【聚到第一段的位置】、其余段删除，
  // 即：动过的槽，它在 prompt 里的内容会集中到一处（词序会变，这是"按槽组织"的必然结果，故只在你真改时才发生）。
  const commitGroup = (key: RegKey, rows: { idx: number; sg: Seg }[], text: string) => segMut(key, cur => {
    if (!rows.length) return null
    const keep = rows[0].idx
    const kill = new Set(rows.slice(1).map(r => r.idx))
    const next: Seg[] = []
    cur.forEach((sg, i) => {
      if (i === keep) { if (text) next.push({ ...sg, text }) ; return }
      if (kill.has(i)) return
      next.push(sg)
    })
    return next
  })

  const groupBlock = (key: RegKey, cat: string, rows: { idx: number; sg: Seg }[]) => {
    const gkey = key + '#' + cat
    const text = rows.map(r => r.sg.text).join('')
    const cur = groupEdits[gkey] ?? text
    const lines = cur.split('\n').length + Math.ceil(cur.length / 46)
    return (
      <div className={'lz-e-group c-' + cat} key={gkey}>
        <div className="lz-e-gh">{GROUP_LABEL[cat] ?? cat}
          {rows.length > 1 && <em>{rows.length} 段散在原文各处 · 改这个框会把它们聚到一起</em>}
        </div>
        <div className="lz-e-row">
          {editable
            ? <select className="lz-e-cat" value={segIdx(rows[0].sg)} title="把这一整组改归到别的槽"
              onChange={e => { const r = REASSIGN[+e.target.value]; rows.forEach(({ idx }) => segCat(key, idx, r)) }}>
              {REASSIGN.map((r, ri) => <option key={ri} value={ri}>{r.label}</option>)}
            </select>
            : <span className="lz-e-cat ro">{REASSIGN[segIdx(rows[0].sg)].label}</span>}
          <textarea className="lz-e-t" rows={Math.max(1, Math.min(12, lines))} value={cur} readOnly={!editable}
            onChange={e => setGroupEdits(m => ({ ...m, [gkey]: e.target.value }))}
            onBlur={() => {
              const v = groupEdits[gkey]
              if (v != null && v !== text) commitGroup(key, rows, v)
              setGroupEdits(m => { const n = { ...m }; delete n[gkey]; return n })
            }} />
          {editable && <span className="lz-e-ops">
            <button title="删掉这一整组（prompt 里一并删）" onClick={() => commitGroup(key, rows, '')}>✕</button>
          </span>}
        </div>
      </div>
    )
  }

  const rawRow = (key: RegKey, label: string) => {
    const text = getRegion(draft, key)
    if (!editable && !text) return null
    return (
      <div className="lz-e-group c-neutral" key={key}>
        <div className="lz-e-gh">{label}{cbtn(text, key)}</div>
        <textarea className="lz-e-t raw" rows={Math.max(2, Math.min(8, Math.ceil(text.length / 46)))}
          value={rawEdits[key] ?? text} readOnly={!editable}
          onChange={e => setRawEdits(m => ({ ...m, [key]: e.target.value }))}
          onBlur={() => { const v = rawEdits[key]; if (v != null && v !== text) apply(d => setRegion(d, key, v)); setRawEdits(m => { const n = { ...m }; delete n[key]; return n }) }} />
      </div>
    )
  }

  const regionBlock = (key: RegKey, title: string, order: string[]) => {
    const g = groupOf(key)
    const cats = [...order.filter(c => g[c]?.length), ...Object.keys(g).filter(c => !order.includes(c))]
    return (
      <div className="lz-e-region" key={key}>
        <div className="lz-e-rh">{title}{cbtn(getRegion(draft, key), key)}
          {editable && <button className="lz-e-reseg" onClick={() => reSeg(key)} title="按标点重新切段并自动归槽（你手改过的归属会被覆盖）">重新切段</button>}
        </div>
        {cats.length === 0
          ? <div className="lz-e-empty">（此区域还没切段）{editable && <button onClick={() => reSeg(key)}>切开</button>}</div>
          : cats.map(c => groupBlock(key, c, g[c]))}
      </div>
    )
  }

  const statusTxt = saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '✓ 已保存' : saveState === 'error' ? '✗ 失败·点重试' : saveState === 'dirty' ? '● 未保存' : ''
  const fullText = hasPayload ? [draft.positive, ...draft.characters.map(c => c.text)].filter(Boolean).join('\n') : ''

  return (
    <details className={'lz-prompt lz-edit2' + (editable ? ' editable' : '')} open>
      <summary>
        <span>Prompt {editable ? '编辑' : '（只读）'}</span>
        {editable && statusTxt && <span className={'lz-tok-status ' + saveState} onClick={saveState === 'error' ? retry : undefined}>{statusTxt}</span>}
        {fullText && <button className="lz-copybtn all" onClick={e => { e.preventDefault(); copy(fullText, '__all__') }}>{copied === '__all__' ? '✓ 已复制' : '复制全部'}</button>}
      </summary>

      {!editable && <div className="lz-tok-ronote">这里是只读预览。要改这一帧：套图 tab → 找到它所在的复刻套图 → 点开那一帧。</div>}
      {restored && <div className="lz-tok-banner">已恢复上次未保存草稿<button onClick={() => { const s = initFrom(shot); draftRef.current = s; setDraftState(s); setRestored(false); setSaveState('idle'); try { localStorage.removeItem(dkey) } catch { /* ignore */ } }}>放弃草稿</button></div>}

      {!hasPayload && (
        <div className="lz-prompt-empty lz-tok-legacy">
          <div>旧式条目：库里只存了切槽后的分类值，没有原文。跑图时由下面这些槽值重组，所以<b>改槽值就是改跑图</b>。</div>
        </div>
      )}

      {hasPayload && <>
        {regionBlock('positive', '正向 base', BASE_ORDER)}
        {rawRow('negative', '基础负面')}
        {draft.characters.map((c, i) => (
          <div key={i}>
            {regionBlock('char:' + i, `角色${i + 1}` + ((c.x != null && c.y != null) ? ` · 位置(${c.x},${c.y})` : ''), CHAR_ORDER)}
            {(c.negative || editable) && rawRow('charNeg:' + i, `角色${i + 1} 负面`)}
          </div>
        ))}
      </>}

      {/* 跑图参数（不是 prompt 内容）：换角/换衣时"哪些别删、怎么剥"、正背面、几个女角 */}
      <div className="lz-e-params">
        <div className="lz-e-gh">跑图参数 · 不进 prompt</div>
        {metaRow('props', '道具保留', String(draft.slots.props ?? ''), 'c-props', v => setSlot('props', v), '换角/换衣都不删这些', undefined, true)}
        {metaRow('clothing', '衣服剥离', String(draft.slots.clothing ?? ''), 'c-clothing', v => setSlot('clothing', v), '换衣时这些跟着一起剥', undefined, true)}
        {metaRow('view', '视角', String(draft.slots.view ?? ''), 'c-neutral', v => setSlot('view', v), '选正/背面衣服变体', undefined, true)}
        {metaRow('cast', '出场女角', Array.isArray(draft.slots.cast) ? (draft.slots.cast as string[]).join(', ') : '', 'c-neutral', setCast, '加装层按它落槽', { placeholder: 'f1, f2' }, true)}
        {metaRow('male', '男角', String(draft.slots.male ?? ''), 'c-skeleton', v => setSlot('male', v), undefined, undefined, true)}
      </div>
    </details>
  )
}

// 套图(服务端按 folder 组装好的对象)
interface LazySet {
  id: string; title: string; work: string; cover: string; coverId: string
  count: number; frames: LazyShot[]; tags: string[]; order?: number
  trashed: boolean; trashedAt?: string
}
// 拖拽分类时的载荷:大类/中类/小类
type CatDrag = { kind: 'group'; gid: string } | { kind: 'sub'; gid: string; sid: string }
  | { kind: 'subsub'; gid: string; sid: string; ssid: string }
type CatOver = { key: string; beforeId: string }

// 分类竖向落点:返回应插到其【之前】的同级 id;越过全部=末尾('__end__')。
// 单一中线阈值 → 不抖动、光标往回移自然回到原序=可还原(同图片 pickBefore 思路)。
function pickBeforeCat(container: HTMLElement, y: number, movedId: string): string {
  const els = Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-catid]'))
  for (const el of els) {
    const id = el.dataset.catid
    if (!id || id === movedId) continue
    const r = el.getBoundingClientRect()
    if (y < r.top + r.height / 2) return id
  }
  return '__end__'
}

const readCollapsed = () => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem('lz_collapsed') || '[]'))
  } catch {
    return new Set<string>()
  }
}

const readNavParams = () => {
  const p = new URLSearchParams(window.location.search)
  const t = p.get('t'); const k = p.get('k'); const q = p.get('q'); const f = p.get('f')
  return {
    tab: (t === 'sets' ? 'sets' : 'single') as 'single' | 'sets',
    setKind: (k === 'std' ? 'std' : k === 'orig' ? 'orig' : 'repro') as 'repro' | 'std' | 'orig',
    query: q ?? '',
    tagFilter: f ? new Set(f.split(',').filter(Boolean)) : new Set<string>(),
  }
}

function groupsOf(f: FacetDef): { name?: string; gate?: string[]; values: FacetValue[] }[] {
  if (f.groups?.length) return f.groups
  return [{ values: f.values ?? [] }]
}

export function LazyBrowser({ batch, onGotoNaiQueue }: {
  batch?: ReturnType<typeof useNaiBatch>
  onGotoNaiQueue?: () => void
} = {}) {
  const [vocab, setVocab] = useState<FacetVocab | null>(null)
  const [shots, setShots] = useState<LazyShot[]>([])
  const [cats, setCats] = useState<CatGroup[]>([])
  const [sets, setSets] = useState<LazySet[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // 顶层两库:single=精品单图 / sets=套图。套图库内三类型由 setKind 切:复刻/标准/原创
  const [tab, setTab] = useState<'single' | 'sets'>(() => readNavParams().tab)
  const [setKind, setSetKind] = useState<'repro' | 'std' | 'orig'>(() => readNavParams().setKind)
  const [query, setQuery] = useState(() => readNavParams().query)
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => readNavParams().tagFilter)
  const [size, setSize] = useState<Size>('sm')
  const [dockOpen, setDockOpen] = useState(true)
  const [dockMode, setDockMode] = useState<'staging' | 'clip'>('clip')  // 默认复制区(复制);另一档=待部署(剪切)
  const [clipOver, setClipOver] = useState<string | null>(null)
  const [manage, setManage] = useState(false)   // 分类管理模式(显示改名/删除/+子类/拖柄)
  const [showTrash, setShowTrash] = useState(false)   // 垃圾桶视图

  const [dragId, setDragId] = useState<string | null>(null)                 // 正在拖的卡片
  const [over, setOver] = useState<{ key: string; beforeId: string | null } | null>(null)
  const [catDrag, setCatDrag] = useState<CatDrag | null>(null)
  const [catOver, setCatOver] = useState<CatOver | null>(null)              // 分类拖拽悬停的目标 header id + 前/后落点
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)

  const [selId, setSelId] = useState<string | null>(null)
  const [draft, setDraft] = useState<LazyShot | null>(null)
  const [saving, setSaving] = useState(false)
  const [newTag, setNewTag] = useState('')

  // —— 套图态 ——
  const [setSel, setSetSel] = useState<string | null>(null)   // 打开详情的套图 id
  const [dragSetId, setDragSetId] = useState<string | null>(null)
  const [overSetId, setOverSetId] = useState<string | null>(null)  // 套图卡片拖拽落点(beforeId)
  const [frameDragId, setFrameDragId] = useState<string | null>(null)
  const [frameOver, setFrameOver] = useState<string | null>(null)
  const [frameSel, setFrameSel] = useState<string | null>(null)   // 点开编辑的帧 id
  const [picker, setPicker] = useState<{ name: string; count: number }[] | null>(null) // 导入选择器
  const [pickerQ, setPickerQ] = useState('')
  const [busy, setBusy] = useState('')

  // —— 三类套图·引用型组合(标准套图/原创套图) ——
  const [comps, setComps] = useState<ResolvedComp[]>([])
  const [compSel, setCompSel] = useState<string | null>(null)        // 打开详情的组合 id
  const [cmDrag, setCmDrag] = useState<string | null>(null)          // 组内成员拖拽中的实例 key
  const [cmOver, setCmOver] = useState<string | null>(null)          // 组内成员落点(实例 key,beforeId)
  const [memberSel, setMemberSel] = useState<string | null>(null)    // 点开编辑的组合成员实例 key
  const [adder, setAdder] = useState<null | { compId: string; src: 'shot' | 'frame' | 'standard'; setId?: string }>(null)  // 添加成员选择器
  const [adderQ, setAdderQ] = useState('')

  // 悬浮跟随大图(默认小图,鼠标移到图上浮出大图随光标移动;拖拽时不弹)
  const [zoom, setZoom] = useState<{ src: string; x: number; y: number } | null>(null)
  const zoomProps = (src?: string) => src ? {
    onMouseEnter: (e: { clientX: number; clientY: number }) => setZoom({ src, x: e.clientX, y: e.clientY }),
    onMouseMove: (e: { clientX: number; clientY: number }) => setZoom({ src, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setZoom(null),
    onClick: () => setZoom(null),   // 点进去就消失(不留在原地)
  } : {}
  useEffect(() => {
    const clr = () => setZoom(null)
    window.addEventListener('dragstart', clr)
    return () => window.removeEventListener('dragstart', clr)
  }, [])
  // 切视图/进套图/开编辑 → 清掉悬浮预览(避免鼠标不动时残留)
  useEffect(() => { setZoom(null) }, [tab, setKind, setSel, frameSel, selId, showTrash, compSel])
  // 切组合/切子tab/切大tab → 关掉成员编辑抽屉(避免指向旧组合的失效成员)
  useEffect(() => { setMemberSel(null) }, [compSel, setKind, tab])

  const catsRef = useRef<CatGroup[]>([])
  useEffect(() => { catsRef.current = cats }, [cats])

  // 拖拽时边缘自动滚动主区(原生 DnD 会吞滚轮,靠近上/下边缘就自动滚,免去"先丢待部署区中转")
  const mainRef = useRef<HTMLElement>(null)
  const scrollVel = useRef(0)
  const rafId = useRef(0)
  const tickScroll = useCallback(() => {
    const el = mainRef.current
    if (el && scrollVel.current) el.scrollTop += scrollVel.current
    rafId.current = scrollVel.current ? requestAnimationFrame(tickScroll) : 0
  }, [])
  const autoScroll = useCallback((clientY: number) => {
    const el = mainRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const EDGE = 100
    let v = 0
    if (clientY < r.top + EDGE) v = -Math.ceil((r.top + EDGE - clientY) / 4)
    else if (clientY > r.bottom - EDGE) v = Math.ceil((clientY - (r.bottom - EDGE)) / 4)
    scrollVel.current = v
    if (v && !rafId.current) rafId.current = requestAnimationFrame(tickScroll)
  }, [tickScroll])
  useEffect(() => {
    const stop = () => { scrollVel.current = 0 }
    window.addEventListener('dragend', stop); window.addEventListener('drop', stop)
    return () => { window.removeEventListener('dragend', stop); window.removeEventListener('drop', stop) }
  }, [])

  // 导航状态同步到 URL params（tab/setKind/query/tagFilter），刷新后恢复
  useEffect(() => {
    const p = new URLSearchParams()
    if (tab !== 'single') p.set('t', tab)
    if (tab === 'sets' && setKind !== 'repro') p.set('k', setKind)
    if (query) p.set('q', query)
    if (tagFilter.size) p.set('f', [...tagFilter].sort().join(','))
    const qs = p.toString()
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
  }, [tab, setKind, query, tagFilter])

  // 离开/刷新前保存滚动位置
  useEffect(() => {
    const save = () => {
      if (mainRef.current) sessionStorage.setItem('lz_scroll', String(mainRef.current.scrollTop))
    }
    window.addEventListener('beforeunload', save)
    return () => window.removeEventListener('beforeunload', save)
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [fv, sv, cv, setv, cpv] = await Promise.all([
        fetch('/api/rating/facets').then(r => r.json()),
        fetch('/api/rating/shots-all').then(r => r.json()),
        fetch('/api/rating/categories').then(r => r.json()),
        fetch('/api/rating/sets').then(r => r.json()),
        fetch('/api/rating/compositions').then(r => r.json()),
      ])
      setVocab(fv as FacetVocab)
      setShots((sv.shots ?? []) as LazyShot[])
      setCats((cv.groups ?? []) as CatGroup[])
      setSets((setv.sets ?? []) as LazySet[])
      setComps((cpv.compositions ?? []) as ResolvedComp[])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // 数据加载完成后恢复滚动位置
  useEffect(() => {
    if (loading) return
    const saved = sessionStorage.getItem('lz_scroll')
    if (saved && mainRef.current) {
      mainRef.current.scrollTop = Number(saved)
      sessionStorage.removeItem('lz_scroll')
    }
  }, [loading])

  const facetDefs = vocab?.facets ?? []

  const allTags = useMemo(() => {
    const s = new Set<string>(SUGGESTED_TAGS)
    for (const sh of shots) for (const t of sh.tags ?? []) s.add(t)
    return [...s]
  }, [shots])
  const tagCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const sh of shots) for (const t of sh.tags ?? []) c[t] = (c[t] ?? 0) + 1
    return c
  }, [shots])

  useEffect(() => {
    const s = shots.find(x => x.id === selId) || null
    setDraft(s ? structuredClone(s) : null)
  }, [selId, shots])

  const matches = useCallback((s: LazyShot) => {
    if (tagFilter.size) {
      const ts = s.tags ?? []
      if (![...tagFilter].some(t => ts.includes(t))) return false
    }
    const q = query.trim().toLowerCase()
    if (q) {
      const hay = [s.id, s.title ?? '', s.note ?? '', s.source?.work ?? '', ...(s.tags ?? []),
        ...Object.values(s.blocks ?? {})].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }, [tagFilter, query])

  // 每张图归一化到 (大类,中类,小类):指向不存在的层 → 退回上一层(大类不存在=待部署)
  const groupById = useMemo(() => new Map(cats.map(g => [g.id, g])), [cats])
  const effBucket = useCallback((s: LazyShot): { cat: string; sub: string; subsub: string } => {
    const g = s.category ? groupById.get(s.category) : undefined
    if (!g) return { cat: '', sub: '', subsub: '' }
    const sub = s.subcategory ? g.subs.find(x => x.id === s.subcategory) : undefined
    if (!sub) return { cat: g.id, sub: '', subsub: '' }
    const ss = s.subsubcategory && (sub.subs ?? []).some(x => x.id === s.subsubcategory) ? s.subsubcategory : ''
    return { cat: g.id, sub: sub.id, subsub: ss }
  }, [groupById])

  const sortFn = (a: LazyShot, b: LazyShot) =>
    (a.order ?? BIG) - (b.order ?? BIG) || (a.created < b.created ? -1 : 1)

  // 已被某组合引用的单图/帧 id = 已部署进某套图(标准/原创),不再算"loose"→从待部署/复制区移除。
  // 拖出 dock 即从 dock 消失(单图/套图公用一套:拖进分类=有category移除、拖进复刻套=帧消耗删除、拖进组合=被引用移除)。
  // ★含【已软删(trashed)组合】的成员:软删组合=丢进套图垃圾桶、可还原,其成员应【随组合一起消失】而非回流待部署/复制区
  //   (2026-07-14「删除套图=直接消失」)。真正回流只发生在【彻底删组合】时,由 deleteComp 的 cleanupCompShots 兜底清理。
  const compRefIds = useMemo(() => {
    const s = new Set<string>()
    for (const c of comps) { for (const m of c.members) if (m.kind === 'shot' || m.kind === 'frame') s.add(m.ref) }
    return s
  }, [comps])

  // 分桶:待部署 + 每个大类(直挂 + 各中类(直挂 + 各小类))。垃圾桶项不进任何桶。
  const view = useMemo(() => {
    const buckets = new Map<string, LazyShot[]>()
    for (const s of shots) {
      if (s.trashed || s.clip) continue   // 复制区副本不进分类视图
      const { cat, sub, subsub } = effBucket(s)
      const key = cat ? bk(cat, sub, subsub) : STAGING
      if (key === STAGING && compRefIds.has(s.id)) continue   // 待部署里已被组合引用的→已部署,不再显示
      const arr = buckets.get(key) ?? []; arr.push(s); buckets.set(key, arr)
    }
    const pick = (key: string) => {
      const all = (buckets.get(key) ?? []).slice().sort(sortFn)
      return { total: all.length, items: all.filter(matches) }
    }
    const groups = cats.map((g, i) => {
      const direct = pick(bk(g.id))
      const subs = g.subs.map(sub => {
        const sdirect = pick(bk(g.id, sub.id))
        const subsubs = (sub.subs ?? []).map(ss => ({ ...ss, ...pick(bk(g.id, sub.id, ss.id)) }))
        const stotal = sdirect.total + subsubs.reduce((a, x) => a + x.total, 0)
        return { ...sub, direct: sdirect, subsubs, total: stotal }
      })
      const total = direct.total + subs.reduce((a, s) => a + s.total, 0)
      return { ...g, color: PALETTE[i % PALETTE.length], direct, subs, total }
    })
    return { staging: pick(STAGING), groups }
  }, [shots, cats, effBucket, matches, compRefIds])

  const visibleCount = useMemo(() => shots.filter(s => !s.trashed && matches(s)).length, [shots, matches])
  const filtering = tagFilter.size > 0 || query.trim() !== ''
  const trashed = useMemo(() => shots.filter(s => s.trashed)
    .sort((a, b) => (b.trashedAt ?? '').localeCompare(a.trashedAt ?? '')), [shots])
  // 复制区:clip 副本(独立条目),按 order 排;参与筛选
  const clips = useMemo(() => shots.filter(s => s.clip && !s.trashed && !compRefIds.has(s.id)).slice().sort(sortFn).filter(matches), [shots, matches, compRefIds])
  const isClip = useCallback((id: string) => !!shots.find(s => s.id === id)?.clip, [shots])
  const snapOf = (s: LazyShot) => ({
    preview: s.preview, source: s.source, title: s.title ?? '', tags: s.tags ?? [],
    blocks: s.blocks ?? {}, facets: s.facets ?? {}, fromId: s.id,
  })

  // —— 卡片拖拽:移到 (cat,sub,subsub) 桶,放在 beforeId 之前(null=末尾) ——
  const drop = useCallback(async (cat: string, sub: string, subsub: string, beforeId: string | null) => {
    const id = dragId
    setDragId(null); setOver(null)
    if (!id || id === beforeId) return
    const moved = shots.find(s => s.id === id)
    if (!moved) return
    const target = shots.filter(s => {
      const b = effBucket(s); return b.cat === cat && b.sub === sub && b.subsub === subsub
    }).sort(sortFn)
    const inBucket = placeBefore(target, moved, beforeId)
    const items = inBucket.map((s, i) => ({ id: s.id, category: cat, subcategory: sub, subsubcategory: subsub, clip: false, order: i }))
    const map = new Map(items.map(it => [it.id, it]))
    setShots(prev => prev.map(s => map.has(s.id)
      ? { ...s, category: cat, subcategory: sub, subsubcategory: subsub, clip: false, order: map.get(s.id)!.order } : s))
    try {
      await fetch('/api/rating/shots-arrange', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
    } catch { /* 失败下次刷新以库为准 */ }
  }, [dragId, shots, effBucket])

  // —— 分类增删改名/排序(大类/中类/小类) ——
  const persistCats = useCallback(async () => {
    try {
      await fetch('/api/rating/categories-save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, groups: catsRef.current }),
      })
    } catch { /* 失败下次刷新以库为准 */ }
  }, [])
  const mutateCats = (fn: (gs: CatGroup[]) => CatGroup[], persist = true) => {
    setCats(prev => { const next = fn(prev); catsRef.current = next; return next })
    if (persist) setTimeout(persistCats, 0)
  }
  const addGroup = () => mutateCats(gs => [...gs, { id: newId(), name: '新大类', subs: [] }])
  const addSub = (gid: string) => mutateCats(gs => gs.map(g =>
    g.id === gid ? { ...g, subs: [...g.subs, { id: newId(), name: '新中类', subs: [] }] } : g))
  const addSubSub = (gid: string, sid: string) => mutateCats(gs => gs.map(g =>
    g.id === gid ? { ...g, subs: g.subs.map(s => s.id === sid
      ? { ...s, subs: [...(s.subs ?? []), { id: newId(), name: '新小类' }] } : s) } : g))
  const renameGroup = (gid: string, name: string) =>
    mutateCats(gs => gs.map(g => g.id === gid ? { ...g, name } : g), false)
  const renameSub = (gid: string, sid: string, name: string) =>
    mutateCats(gs => gs.map(g => g.id === gid
      ? { ...g, subs: g.subs.map(s => s.id === sid ? { ...s, name } : s) } : g), false)
  const renameSubSub = (gid: string, sid: string, ssid: string, name: string) =>
    mutateCats(gs => gs.map(g => g.id === gid
      ? { ...g, subs: g.subs.map(s => s.id === sid
        ? { ...s, subs: (s.subs ?? []).map(x => x.id === ssid ? { ...x, name } : x) } : s) } : g), false)
  const delGroup = (g: typeof view.groups[number]) => {
    if (g.total > 0 && !confirm(`删除大类「${g.name}」?\n里面 ${g.total} 张图会回到待部署区(图不会删)。`)) return
    mutateCats(gs => gs.filter(x => x.id !== g.id))
  }
  const delSub = (gid: string, sid: string, name: string, total: number) => {
    if (total > 0 && !confirm(`删除中类「${name}」?\n里面 ${total} 张图会回到该大类(图不会删)。`)) return
    mutateCats(gs => gs.map(g => g.id === gid ? { ...g, subs: g.subs.filter(s => s.id !== sid) } : g))
  }
  const delSubSub = (gid: string, sid: string, ssid: string, name: string, total: number) => {
    if (total > 0 && !confirm(`删除小类「${name}」?\n里面 ${total} 张图会回到该中类(图不会删)。`)) return
    mutateCats(gs => gs.map(g => g.id === gid
      ? { ...g, subs: g.subs.map(s => s.id === sid ? { ...s, subs: (s.subs ?? []).filter(x => x.id !== ssid) } : s) } : g))
  }
  const reorderGroup = (fromId: string, beforeId: string) => mutateCats(gs => {
    if (fromId === beforeId) return gs
    const item = gs.find(g => g.id === fromId); if (!item) return gs
    const rest = gs.filter(g => g.id !== fromId)
    const at = rest.findIndex(g => g.id === beforeId)
    rest.splice(at < 0 ? rest.length : at, 0, item)
    return rest
  })
  const moveSub = (fromGid: string, sid: string, toGid: string, beforeSid: string | null) => mutateCats(gs => {
    const from = gs.find(g => g.id === fromGid); const sub = from?.subs.find(s => s.id === sid)
    if (!sub) return gs
    return gs.map(g => {
      if (g.id === fromGid && fromGid !== toGid) return { ...g, subs: g.subs.filter(s => s.id !== sid) }
      if (g.id === toGid) {
        let subs = fromGid === toGid ? g.subs.filter(s => s.id !== sid) : g.subs.slice()
        const at = beforeSid ? subs.findIndex(s => s.id === beforeSid) : subs.length
        subs = [...subs]; subs.splice(at < 0 ? subs.length : at, 0, sub)
        return { ...g, subs }
      }
      return g
    })
  })
  // 移动/排序小类:从 (fromGid,fromSid) 的某小类 → (toGid,toSid),插在 beforeSsid 前(null=末尾)
  const moveSubSub = (fromGid: string, fromSid: string, ssid: string, toGid: string, toSid: string, beforeSsid: string | null) =>
    mutateCats(gs => {
      const sub = gs.find(g => g.id === fromGid)?.subs.find(s => s.id === fromSid)
      const item = (sub?.subs ?? []).find(x => x.id === ssid)
      if (!item) return gs
      const same = fromGid === toGid && fromSid === toSid
      return gs.map(g => {
        const subs = g.subs.map(s => {
          let arr = s.subs ?? []
          if (g.id === fromGid && s.id === fromSid && !same) arr = arr.filter(x => x.id !== ssid)
          if (g.id === toGid && s.id === toSid) {
            arr = (same ? arr.filter(x => x.id !== ssid) : arr.slice())
            const at = beforeSsid ? arr.findIndex(x => x.id === beforeSsid) : arr.length
            arr = [...arr]; arr.splice(at < 0 ? arr.length : at, 0, item)
          }
          return { ...s, subs: arr }
        })
        return { ...g, subs }
      })
    })
  const clearCatDrag = () => { setCatDrag(null); setCatOver(null) }
  const toggleCollapse = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('lz_collapsed', JSON.stringify([...next]))
      return next
    })
  }

  // —— 编辑草稿(单图) ——
  const setDraftFacet = (fk: string, v: string, multi: boolean) => setDraft(d => {
    if (!d) return d
    const cur = d.facets?.[fk] ? [...d.facets[fk]] : []
    const next = multi ? (cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]) : (cur.includes(v) ? [] : [v])
    const facets = { ...d.facets }
    if (next.length) facets[fk] = next; else delete facets[fk]
    return { ...d, facets }
  })
  const toggleDraftTag = (t: string) => setDraft(d => d && {
    ...d, tags: (d.tags ?? []).includes(t) ? d.tags!.filter(x => x !== t) : [...(d.tags ?? []), t],
  })
  const addNewTag = () => {
    const t = newTag.trim(); if (!t) return
    setDraft(d => d && { ...d, tags: (d.tags ?? []).includes(t) ? d.tags! : [...(d.tags ?? []), t] })
    setNewTag('')
  }
  const dirty = useMemo(() => {
    const orig = shots.find(x => x.id === selId)
    return !!draft && !!orig && JSON.stringify(draft) !== JSON.stringify(orig)
  }, [draft, shots, selId])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const r = await fetch('/api/rating/shot-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: draft.id, facets: draft.facets, blocks: draft.blocks,
          title: draft.title ?? '', note: draft.note ?? '', status: draft.status,
          category: draft.category ?? '', subcategory: draft.subcategory ?? '',
          subsubcategory: draft.subsubcategory ?? '', tags: draft.tags ?? [],
        }),
      }).then(r => r.json())
      if (r?.shot) setShots(prev => prev.map(s => s.id === r.shot.id ? r.shot : s))
      else if (r?.error) alert('保存失败:' + r.error)
    } finally { setSaving(false) }
  }
  // 软删除:扔进垃圾桶(可还原)。卡片小按钮 + 编辑面板都走这。
  const trashShot = async (s: LazyShot) => {
    setShots(prev => prev.map(x => x.id === s.id ? { ...x, trashed: true } : x))
    if (selId === s.id) setSelId(null)
    try {
      await fetch('/api/rating/shot-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, trashed: true }),
      })
    } catch { /* 同上 */ }
  }
  const restoreShot = async (s: LazyShot) => {
    setShots(prev => prev.map(x => x.id === s.id ? { ...x, trashed: false } : x))
    try {
      await fetch('/api/rating/shot-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, trashed: false }),
      })
    } catch { /* 同上 */ }
  }
  // 彻底删单张(连预览,不影响原出图)
  const hardDelete = async (s: LazyShot) => {
    if (!confirm(`彻底删除?\n${s.title || s.source.file}\n不可恢复(连预览图,不影响原出图)`)) return
    try {
      // 副本(copy_xxx,source 指向原件)必须按 id 删,否则 lazy-remove 会按 folder/file 删到【原件】(三方审计 P0)
      if (s.clip || s.id.startsWith('copy_')) {
        await postJSON('/api/rating/shot-delete', { id: s.id })   // 副本默认不删共享预览(后端引用计数兜底)
      } else {
        await fetch('/api/rating/lazy-remove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: s.source.folder, file: s.source.file }),
        })
      }
      setShots(prev => prev.filter(x => x.id !== s.id))
      if (selId === s.id) setSelId(null)
    } catch { /* 同上 */ }
  }
  const emptyTrash = async () => {
    if (!trashed.length) return
    if (!confirm(`清空垃圾桶?彻底删除 ${trashed.length} 张,不可恢复(连预览图,不影响原出图)`)) return
    try {
      await fetch('/api/rating/trash-empty', { method: 'POST' })
      setShots(prev => prev.filter(s => !s.trashed))
    } catch { /* 同上 */ }
  }

  const toggleTagFilter = (t: string) => setTagFilter(prev => {
    const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n
  })
  const quickTag = async (s: LazyShot, t: string) => {
    const has = (s.tags ?? []).includes(t)
    const tags = has ? (s.tags ?? []).filter(x => x !== t) : [...(s.tags ?? []), t]
    setShots(prev => prev.map(x => x.id === s.id ? { ...x, tags } : x))
    try {
      await fetch('/api/rating/shot-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, tags }),
      })
    } catch { /* 同上 */ }
  }

  // ============ 套图操作 ============
  const setsMeta = useCallback(async (patch: Record<string, Record<string, unknown>>) => {
    try {
      const r = await fetch('/api/rating/sets-meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      }).then(r => r.json())
      if (r?.sets) setSets(r.sets as LazySet[])
    } catch { /* 失败下次刷新以库为准 */ }
  }, [])
  const liveSets = useMemo(() => sets.filter(s => !s.trashed), [sets])
  const trashedSets = useMemo(() => sets.filter(s => s.trashed), [sets])
  const curSet = useMemo(() => sets.find(s => s.id === setSel) || null, [sets, setSel])

  // ============ 跑图桥接:把懒狗单图/套图灌进 NAI 队列(复用现有引擎,见 lazyShotToBatch.ts) ============
  const runShotToNai = useCallback((shot: LazyShot, swapAw: boolean) => {
    if (!batch) return
    const m = lazyShotToBatchItem(shot, { swapAw })
    // 换AW 默认过加装层(activeId persona 补 adult woman);原角色复刻不套
    const id = batch.addItem({ comment: m.comment, baseBlocks: m.baseBlocks, characters: m.characters, augment: swapAw })
    try { localStorage.setItem('owner-nai:active-item', id) } catch { /* ignore */ }
    onGotoNaiQueue?.()
  }, [batch, onGotoNaiQueue])

  const runSetToNai = useCallback((set: LazySet | null, swapAw: boolean) => {
    if (!batch || !set) return
    const frames = previewList(set.frames, null, null)
    if (!frames.length) return
    let firstId = ''
    frames.forEach((f, i) => {
      const m = lazyShotToBatchItem(f, { swapAw })
      const id = batch.addItem({
        comment: `${set.title}·${String(i + 1).padStart(2, '0')}·${m.comment}`,
        baseBlocks: m.baseBlocks,
        characters: m.characters,
        augment: swapAw,
      })
      if (i === 0) firstId = id
    })
    if (firstId) { try { localStorage.setItem('owner-nai:active-item', firstId) } catch { /* ignore */ } }
    onGotoNaiQueue?.()
  }, [batch, onGotoNaiQueue])

  // 套图卡片排序:把 fromId 放到 beforeId 之前(null=末尾),重排全部存活套
  const arrangeSets = async (fromId: string, beforeId: string | null) => {
    setDragSetId(null); setOverSetId(null)
    if (!fromId || fromId === beforeId) return
    const moved = liveSets.find(s => s.id === fromId); if (!moved) return
    const rest = placeBefore(liveSets, moved, beforeId)
    const patch: Record<string, Record<string, unknown>> = {}
    rest.forEach((s, i) => { patch[s.id] = { order: i } })
    setSets(prev => prev.map(s => patch[s.id] ? { ...s, order: patch[s.id].order as number } : s)
      .sort((a, b) => (a.order ?? BIG) - (b.order ?? BIG) || a.title.localeCompare(b.title, 'zh')))
    await setsMeta(patch)
  }
  // 套内帧排序:把 fromId 放到 beforeId 之前,重排该套帧序写 frameOrder
  const arrangeFrames = async (setId: string, fromId: string, beforeId: string | null) => {
    setFrameDragId(null); setFrameOver(null)
    if (!fromId || fromId === beforeId) return
    const s = sets.find(x => x.id === setId); if (!s) return
    const moved = s.frames.find(f => f.id === fromId); if (!moved) return
    const rest = placeBefore(s.frames, moved, beforeId)
    const frameOrder: Record<string, number> = {}
    rest.forEach((f, i) => { frameOrder[f.id] = i })
    setSets(prev => prev.map(x => x.id === setId ? { ...x, frames: rest } : x))
    await setsMeta({ [setId]: { frameOrder } })
  }
  const renameSet = (id: string, title: string) =>
    setSets(prev => prev.map(s => s.id === id ? { ...s, title } : s))
  const setCover = async (setId: string, coverId: string) => {
    setSets(prev => prev.map(s => s.id === setId ? { ...s, coverId, cover: s.frames.find(f => f.id === coverId)?.preview || s.cover } : s))
    await setsMeta({ [setId]: { cover: coverId } })
  }
  const trashSet = async (id: string) => {
    setSets(prev => prev.map(s => s.id === id ? { ...s, trashed: true } : s))
    if (setSel === id) setSetSel(null)
    await setsMeta({ [id]: { trashed: true } })
  }
  const restoreSet = async (id: string) => {
    setSets(prev => prev.map(s => s.id === id ? { ...s, trashed: false } : s))
    await setsMeta({ [id]: { trashed: false } })
  }
  const removeSet = async (s: LazySet) => {
    if (!confirm(`彻底删除整套「${s.title}」?\n连 ${s.count} 帧预览图一并删除,不可恢复(不影响原出图)`)) return
    try {
      const r = await fetch('/api/rating/set-remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id }),
      }).then(r => r.json())
      if (r?.sets) setSets(r.sets as LazySet[])
      if (setSel === s.id) setSetSel(null)
    } catch { /* 同上 */ }
  }
  const openPicker = async () => {
    setPicker([]); setPickerQ('')
    try {
      const r = await fetch('/api/rating/folders').then(r => r.json())
      setPicker((r.folders ?? []) as { name: string; count: number }[])
    } catch { setPicker([]) }
  }
  const importSet = async (folder: string) => {
    setBusy(folder)
    try {
      const r = await fetch('/api/rating/set-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder }),
      }).then(r => r.json())
      if (r?.sets) setSets(r.sets as LazySet[])
      if (r?.error) alert('导入失败:' + r.error)
      else { setPicker(null); setTab('sets'); setSetKind('repro') }
    } catch (e) { alert('导入失败:' + (e instanceof Error ? e.message : String(e))) }
    finally { setBusy('') }
  }
  // 帧级编辑(tags/note)——只写 sets_meta.frameMeta,绝不回写 sets.json
  const frameQuickTag = async (setId: string, f: LazyShot, t: string) => {
    const has = (f.tags ?? []).includes(t)
    const tags = has ? (f.tags ?? []).filter(x => x !== t) : [...(f.tags ?? []), t]
    setSets(prev => prev.map(s => s.id === setId ? { ...s, frames: s.frames.map(x => x.id === f.id ? { ...x, tags } : x) } : s))
    await setsMeta({ [setId]: { frameMeta: { [f.id]: { tags } } } })
  }
  const frameNoteLocal = (setId: string, fid: string, note: string) =>
    setSets(prev => prev.map(s => s.id === setId ? { ...s, frames: s.frames.map(x => x.id === fid ? { ...x, note } : x) } : s))
  const frameNoteSave = (setId: string, fid: string, note: string) => setsMeta({ [setId]: { frameMeta: { [fid]: { note } } } })

  // ============ 复制区 / 跨库副本(剪切=移动,复制=独立副本) ============
  const postJSON = async (url: string, body: unknown) => {
    try { return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()) }
    catch { return null }
  }
  // 复制一份到复制区(原件不动)。来源=单图卡片 / 套图帧。
  const copyToClip = async (s: LazyShot) => {
    const r = await postJSON('/api/rating/shot-copy', { ...snapOf(s), clip: true })
    if (r?.shot) setShots(prev => [...prev, r.shot as LazyShot])
  }
  // 移到待部署区(剪切):脱离复制区/原分类,category 清空
  const moveToStaging = async (id: string) => {
    setShots(prev => prev.map(s => s.id === id ? { ...s, category: '', subcategory: '', subsubcategory: '', clip: false } : s))
    await postJSON('/api/rating/shot-update', { id, category: '', subcategory: '', subsubcategory: '', clip: false })
  }
  // 复制区内重排
  const clipReorder = async (fromId: string, beforeId: string | null) => {
    if (!fromId || fromId === beforeId) return
    const moved = clips.find(s => s.id === fromId); if (!moved) return
    const rest = placeBefore(clips, moved, beforeId)
    const items = rest.map((s, i) => ({ id: s.id, order: i }))
    const map = new Map(items.map(it => [it.id, it.order]))
    setShots(prev => prev.map(s => map.has(s.id) ? { ...s, order: map.get(s.id)! } : s))
    await postJSON('/api/rating/shots-arrange', { items })
  }
  // 删除复制区副本(只删条目,不动共享的原预览)
  const deleteClip = async (id: string) => {
    setShots(prev => prev.filter(s => s.id !== id))
    if (selId === id) setSelId(null)
    await postJSON('/api/rating/shot-delete', { id })
  }
  // 套图帧 → 复制区(复制,帧留)
  const copyFrameToClip = (f: LazyShot) => copyToClip(f)
  // 组合成员 → 复制区:解析引用到底层单图/帧,复制一份进复制区(组合本身不动)。kind 'standard'=引用整套标准,不支持复制单图
  const copyMemberToClip = (m: { kind: string; ref: string }) => {
    const s = m.kind === 'shot' ? shots.find(x => x.id === m.ref)
      : m.kind === 'frame' ? sets.flatMap(x => x.frames).find(f => f.id === m.ref)
      : undefined
    if (s) copyToClip(s)
  }
  // 组合成员 → 待部署:把底层图变成 loose 单图(清 clip/分类)落进待部署区,再移出组合(剪切)。
  // 引用的可能是 shots.json 里的副本/单图(原地转待部署),或 sets.json 里的套图帧(复制一份待部署单图)
  const memberToStaging = async (compId: string, memberKey: string, m: { kind: string; ref: string }) => {
    if (shots.some(s => s.id === m.ref)) {
      await moveToStaging(m.ref)
    } else {
      const f = sets.flatMap(x => x.frames).find(fr => fr.id === m.ref)
      if (f) {
        const r = await postJSON('/api/rating/shot-copy', { ...snapOf(f), clip: false, category: '' })
        if (r?.shot) setShots(prev => [...prev, r.shot as LazyShot])
      }
    }
    compRemoveMember(compId, memberKey)
  }
  // 套图帧 → 待部署区(剪切):建单图(待部署)+ 从本套移出该帧
  const frameToStaging = async (setId: string, f: LazyShot) => {
    // 先确认副本建成功,才从套图移出该帧;否则"剪切"会变成帧没了又没生成单图(数据丢)
    const r = await postJSON('/api/rating/shot-copy', { ...snapOf(f), clip: false, category: '' })
    if (!r?.shot) { alert('剪切失败,帧未移出'); return }
    setShots(prev => [...prev, r.shot as LazyShot])
    const r2 = await postJSON('/api/rating/set-frames', { setId, removeFrameIds: [f.id] })
    if (r2?.sets) setSets(r2.sets as LazySet[])
  }
  // dock 条目(待部署 or 复制区)→ 拖进套图:加为该套副本帧(一律追加末尾) + 删掉 dock 里的源条目(移动)
  const dockItemToSet = async (setId: string, s: LazyShot) => {
    // 先确认加帧成功,再删源;否则加失败也删源 = 没进套图源还没了(数据丢)
    const r = await postJSON('/api/rating/set-frames', { setId, addFrames: [snapOf(s)] })
    if (!r?.sets) { alert('加入套图失败,源未删除'); return }
    setSets(r.sets as LazySet[])
    setShots(prev => prev.filter(x => x.id !== s.id))
    await postJSON('/api/rating/shot-delete', { id: s.id })
  }
  // 从套图移出某帧(自然帧→隐藏,副本帧→删)
  const removeFrameFromSet = async (setId: string, fid: string) => {
    const r = await postJSON('/api/rating/set-frames', { setId, removeFrameIds: [fid] })
    if (r?.sets) setSets(r.sets as LazySet[])
    if (frameSel === fid) setFrameSel(null)
  }
  // 帧 prompt 染色编辑器回写(只改自然帧的 payload_src/slots/blocks → sets.json;成功后同步本地 state,重开抽屉见新值)
  const saveFrame = useCallback(async (patch: FramePatch): Promise<boolean> => {
    try {
      const r = await fetch('/api/rating/set-frame-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }).then(x => x.json())
      if (!r?.ok || !r.frame) return false
      const fr = r.frame as LazyShot
      setSets(prev => prev.map(s => ({ ...s, frames: s.frames.map(x => x.id === fr.id ? { ...x, payload_src: fr.payload_src, slots: fr.slots, blocks: fr.blocks, seg: fr.seg, updated: fr.updated } : x) })))
      return true
    } catch { return false }
  }, [])

  // ============ 三类套图·引用型组合(标准套图/原创套图;成员=有序引用,纯 meta) ============
  // 成员唯一实例 key(同一帧可重复出现,用位置区分):kind:ref#idx
  const mkey = (m: { kind: string; ref: string }, i: number) => `${m.kind}:${m.ref}#${i}`
  const curComp = useMemo(() => comps.find(c => c.id === compSel) || null, [comps, compSel])
  const compsView = useCallback((type: 'standard' | 'original') => comps.filter(c => c.type === type && !c.trashed), [comps])
  const trashedComps = useMemo(() => comps.filter(c => c.trashed), [comps])
  const bareMembers = (ms: ResolvedMember[]): CompMember[] =>
    ms.map((m, i) => ({ kind: m.kind, ref: m.ref, seq: i, ...(m.stage ? { stage: m.stage } : {}) }))
  // 组合写操作串行化 + 每步读最新 compsRef:杜绝"连点添加/连拖排序"读到 stale 状态再整组覆盖导致成员丢失
  const compsRef = useRef<ResolvedComp[]>([])
  useEffect(() => { compsRef.current = comps }, [comps])
  const compChain = useRef<Promise<unknown>>(Promise.resolve())
  const enqueueComp = (fn: () => Promise<unknown>): Promise<unknown> => {
    const p = compChain.current.then(fn, fn)
    compChain.current = p.catch(() => {})
    return p
  }
  // 保存组合(members 发裸 CompMember[],后端整组替换)→ 重拉(成员预览要服务端回填)。务必在 enqueueComp 内调用,保证串行。
  const compSave = useCallback(async (patch: Partial<Omit<ResolvedComp, 'members'>> & { id?: string; members?: CompMember[] }) => {
    const r = await postJSON('/api/rating/comp-save', patch)
    if (r?.error) { alert('保存失败:' + r.error); return null }
    const cp = await fetch('/api/rating/compositions').then(x => x.json()).catch(() => null)
    if (cp?.compositions) setComps(cp.compositions as ResolvedComp[])
    return r?.comp ?? null
  }, [])
  const createComp = async (type: 'standard' | 'original') => {
    const c = await enqueueComp(() => compSave({ type, title: type === 'standard' ? '新标准套图' : '新原创套图', members: [] })) as { id?: string } | null
    if (c?.id) setCompSel(c.id)
  }
  const renameComp = (id: string, title: string) => setComps(prev => prev.map(c => c.id === id ? { ...c, title } : c))
  const saveCompTitle = (id: string, title: string) => enqueueComp(() => compSave({ id, title }))
  // 彻底删组合前清理其【独占的 loose/clip 单图成员】,防彻删后回流待部署/复制区(镜像 deleteMemberOutright 的安全语义):
  //   复制区副本→硬删(它就是为这套复制的,不动共享原预览);未分类 loose 单图→单图垃圾桶(可还原);
  //   已归类精品单图→留在原分类;frame/standard 引用→不动(帧本体属复刻套图/嵌套组合)。
  const cleanupCompShots = async (comp: ResolvedComp) => {
    for (const m of comp.members) {
      if (m.kind !== 'shot') continue
      const s = shots.find(x => x.id === m.ref)
      if (!s) continue
      if (s.clip) await deleteClip(s.id)
      else if (!s.category) await trashShot(s)
    }
  }
  const deleteComp = async (id: string, hard = false) => {
    const comp = comps.find(c => c.id === id)
    if (hard && !confirm('彻底删除此组合?\n复制区副本成员一并删除、未分类单图移入单图垃圾桶(可还原);已分类单图与复刻套图帧不受影响。')) return
    const r = await enqueueComp(() => postJSON('/api/rating/comp-delete', { id, hard })) as { ok?: boolean } | null
    if (!r?.ok) { alert('删除失败,请重试'); return }
    if (hard && comp) await cleanupCompShots(comp)   // 彻删=真消失:清掉独占成员,不让它们回流 dock
    setComps(prev => hard ? prev.filter(c => c.id !== id) : prev.map(c => c.id === id ? { ...c, trashed: true } : c))
    if (compSel === id) setCompSel(null)
  }
  const restoreComp = async (id: string) => {
    const r = await enqueueComp(() => postJSON('/api/rating/comp-save', { id, trashed: false })) as { ok?: boolean } | null
    if (r?.ok) setComps(prev => prev.map(c => c.id === id ? { ...c, trashed: false } : c))
  }
  // 组内成员重排:把实例 fromKey 移到 beforeKey 之前(null/'__end__'=末尾)。读 compsRef 最新成员,串行保存。
  const compReorder = (compId: string, fromKey: string, beforeKey: string | null) => {
    setCmDrag(null); setCmOver(null)
    if (!fromKey || fromKey === beforeKey) return
    return enqueueComp(async () => {
      const comp = compsRef.current.find(c => c.id === compId); if (!comp) return
      const keyed = comp.members.map((m, i) => ({ k: mkey(m, i), m }))
      const moved = keyed.find(x => x.k === fromKey); if (!moved) return
      const reduced = keyed.filter(x => x.k !== fromKey)
      if (!beforeKey || beforeKey === '__end__') reduced.push(moved)
      else { const at = reduced.findIndex(x => x.k === beforeKey); reduced.splice(at < 0 ? reduced.length : at, 0, moved) }
      await compSave({ id: compId, members: bareMembers(reduced.map(x => x.m)) })
    })
  }
  // 按稳定实例 key 删成员(不用预览后的 index,防拖拽预览中误删)
  const compRemoveMember = (compId: string, key: string) =>
    enqueueComp(async () => {
      const comp = compsRef.current.find(c => c.id === compId); if (!comp) return
      await compSave({ id: compId, members: bareMembers(comp.members.filter((m, i) => mkey(m, i) !== key)) })
    })
  const compSetCover = (compId: string, m: { kind: 'frame' | 'shot' | 'standard'; ref: string }) =>
    enqueueComp(() => compSave({ id: compId, cover: { kind: m.kind, ref: m.ref, seq: 0 } }))
  const compAddMembers = (compId: string, add: CompMember[]) =>
    enqueueComp(async () => {
      const comp = compsRef.current.find(c => c.id === compId); if (!comp) return
      await compSave({ id: compId, members: [...bareMembers(comp.members), ...add] })
    })
  // 组合成员 ✕ = 直接删除,不回 dock(回待部署一律靠拖拽=memberToStaging):
  //   底层是复制区副本→硬删副本;loose 无分类单图→软删进垃圾桶(可还原);
  //   已归类精品单图→仅移出引用(图留在原分类,删库里精品图太危险);frame/standard 引用→仅移出。
  const deleteMemberOutright = async (compId: string, memberKey: string, m: { kind: string; ref: string }) => {
    if (m.kind === 'shot') {
      const s = shots.find(x => x.id === m.ref)
      if (s) {
        if (s.clip) await deleteClip(s.id)
        else if (!s.category) await trashShot(s)
      }
    }
    compRemoveMember(compId, memberKey)
  }

  // ====== 统一容器适配器(CRITICAL · 复刻/标准/原创共用一套手势接口) ======
  // 痛点:复刻套图(sets.json 具体帧)与 标准/原创(compositions.json 引用)数据模型不同,过去拖拽/编辑各写一套
  //   → 修一类漏另一类(如"追加末尾"只在复刻翻车)。现把差异收进适配器,UI 只认这套接口=改一处两类同步。
  // 数据模型差异(故意保留,见 lazydog_storage §4.8):复刻 addFromDock=消耗复制帧;组合=引用成员。
  // key 语义:复刻=帧 id;组合=成员实例 mkey。各视图只在自己激活时设置对应拖拽态,故 key 不会混。
  type ContainerAPI = {
    kind: 'set' | 'comp'
    id: string
    addFromDock: (s: LazyShot) => void                                   // dock 卡片 → 本容器(一律追加末尾)
    reorderMember: (fromKey: string, beforeKey: string | null) => void   // 容器内重排
    memberToStaging: (key: string) => void                               // 成员 → 待部署(剪切)
    memberToClip: (key: string) => void                                  // 成员 → 复制区(复制)
    removeMember: (key: string) => void                                  // 仅移出本容器
    deleteMember: (key: string) => void                                  // ✕ 直接删除:不回 dock(组合成员连底层 loose/clip 一并删)
    makeCover: (key: string) => void
  }
  const activeContainer: ContainerAPI | null = useMemo(() => {
    if (curSet) {
      const id = curSet.id
      const frameOf = (key: string) => curSet.frames.find(f => f.id === key) || null
      return {
        kind: 'set', id,
        addFromDock: s => dockItemToSet(id, s),
        reorderMember: (from, before) => arrangeFrames(id, from, before),
        memberToStaging: key => { const f = frameOf(key); if (f) frameToStaging(id, f) },
        memberToClip: key => { const f = frameOf(key); if (f) copyFrameToClip(f) },
        removeMember: key => removeFrameFromSet(id, key),
        deleteMember: key => removeFrameFromSet(id, key),   // 复刻帧移出即删(自然帧隐藏/副本帧删),本就不回 dock
        makeCover: key => setCover(id, key),
      }
    }
    if (curComp) {
      const id = curComp.id
      const memberOf = (key: string) => { const i = curComp.members.findIndex((m, j) => mkey(m, j) === key); return i >= 0 ? curComp.members[i] : null }
      return {
        kind: 'comp', id,
        addFromDock: s => compAddMembers(id, [{ kind: 'shot', ref: s.id, seq: 0 }]),
        reorderMember: (from, before) => compReorder(id, from, before),
        memberToStaging: key => { const m = memberOf(key); if (m && !m.missing) memberToStaging(id, key, m); else compRemoveMember(id, key) },
        memberToClip: key => { const m = memberOf(key); if (m && !m.missing) copyMemberToClip(m) },
        removeMember: key => compRemoveMember(id, key),
        deleteMember: key => { const m = memberOf(key); if (m) deleteMemberOutright(id, key, m); else compRemoveMember(id, key) },
        makeCover: key => { const m = memberOf(key); if (m) compSetCover(id, m) },
      }
    }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSet, curComp])

  // dock 落点统一处理:frameDragId(套图帧拖到 dock)/ dragId(卡片拖到 dock)
  const dropOnDock = (beforeId: string | null) => {
    // 容器成员(复刻帧 cmDrag=mkey / 套图帧 frameDragId=帧id)拖进 dock → 经统一适配器,复刻/组合同一路径
    const memberKey = cmDrag || frameDragId
    if (memberKey && activeContainer) {
      setCmDrag(null); setCmOver(null); setFrameDragId(null); setFrameOver(null)
      if (dockMode === 'clip') activeContainer.memberToClip(memberKey)   /* 复制区=复制(容器不动) */
      else activeContainer.memberToStaging(memberKey)                    /* 待部署=剪切(移出容器) */
      return
    }
    const id = dragId; setDragId(null); setOver(null); setClipOver(null)
    if (!id) return
    const s = shots.find(x => x.id === id); if (!s) return
    if (dockMode === 'clip') { if (s.clip) clipReorder(id, beforeId); else copyToClip(s) }
    else moveToStaging(id) /* 移到待部署:任何来源(含复制区副本 clip:true)一律转 loose 单图、离开原区,不再两边并存 */
  }

  // 卡片(待部署 dock 与主区复用)。cat/sub/subsub=所在桶,用于拖拽落点。
  // 常驻收藏标(不悬停也能看出已标 神构/特效);悬停时让位给可点的快捷按钮
  const renderMarks = (tags: string[]) => tags.some(t => SUGGESTED_TAGS.includes(t)) ? (
    <div className="lz-marks">
      {tags.includes('神级构图') && <span className="lz-mark star" title="神级构图">★</span>}
      {tags.includes('特殊效果') && <span className="lz-mark fx" title="特殊效果">✦</span>}
    </div>
  ) : null

  const renderCard = (s: LazyShot, _cat: string, _sub: string, _subsub: string) => {
    const tags = s.tags ?? []
    return (
      <figure key={s.id} data-lzid={s.id}
        className={'lz-card' + (s.id === selId ? ' sel' : '') + (s.id === dragId ? ' dragging' : '')}
        draggable
        onDragStart={e => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { setDragId(null); setOver(null) }}
        onClick={() => setSelId(s.id)}>
        <div className="lz-img" {...zoomProps(s.preview)}>
          {(s.thumb ?? s.preview) ? <img src={'/' + (s.thumb ?? s.preview)} alt="" loading="lazy" draggable={false} />
            : <div className="lz-noimg">无预览</div>}
          {s.status === 'draft' && <span className="lz-badge draft">草稿</span>}
          <div className="lz-quick">
            {SUGGESTED_TAGS.map(t => (
              <button key={t} title={t} className={'lz-qbtn' + (tags.includes(t) ? ' on' : '')}
                onClick={e => { e.stopPropagation(); quickTag(s, t) }}>
                {t === '神级构图' ? '★神构' : t === '特殊效果' ? '✦特效' : t}
              </button>
            ))}
            <button title="删除到垃圾桶" className="lz-qbtn trash"
              onClick={e => { e.stopPropagation(); trashShot(s) }}>🗑</button>
          </div>
          {renderMarks(tags)}
          {tags.filter(t => !SUGGESTED_TAGS.includes(t)).length > 0 && (
            <div className="lz-card-tags">
              {tags.filter(t => !SUGGESTED_TAGS.includes(t)).map(t => <span key={t} className="lz-tag">{t}</span>)}
            </div>
          )}
        </div>
        <figcaption className="lz-cap">{s.title || s.source.file}</figcaption>
      </figure>
    )
  }

  // 一个卡片桶(可放区):空时显示占位,拖拽中高亮
  const renderBucket = (cat: string, sub: string, subsub: string, items: LazyShot[], cls = '') => {
    const key = bk(cat, sub, subsub)
    const isOver = !!dragId && over?.key === key
    return (
      <div className={'lz-cards' + cls + (isOver ? ' over' : '')}
        onDragOver={e => { if (dragId) { e.preventDefault(); setOver({ key, beforeId: pickBefore(e.currentTarget, e.clientX, e.clientY, dragId) }) } }}
        onDrop={e => { if (dragId) { e.preventDefault(); drop(cat, sub, subsub, over?.key === key ? over.beforeId : null) } }}>
        {items.length === 0 && <div className="lz-sec-empty">{dragId ? '放到这里' : '— 空 —'}</div>}
        {previewList(items, dragId, over?.key === key ? over.beforeId : null).map(s => renderCard(s, cat, sub, subsub))}
      </div>
    )
  }

  // 复制区卡片(独立副本):拖=移动到目标(粘贴);复制区内拖=重排;🗑=删副本(不动原预览)
  const renderClipCard = (s: LazyShot) => {
    const tags = s.tags ?? []
    return (
      <figure key={s.id} data-lzid={s.id}
        className={'lz-card' + (s.id === selId ? ' sel' : '') + (s.id === dragId ? ' dragging' : '')}
        draggable
        onDragStart={e => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { setDragId(null); setClipOver(null) }}
        onClick={() => setSelId(s.id)}>
        <div className="lz-img" {...zoomProps(s.preview)}>
          {(s.thumb ?? s.preview) ? <img src={'/' + (s.thumb ?? s.preview)} alt="" loading="lazy" draggable={false} /> : <div className="lz-noimg">无预览</div>}
          <span className="lz-badge clipbadge">副本</span>
          <div className="lz-quick">
            {SUGGESTED_TAGS.map(t => (
              <button key={t} title={t} className={'lz-qbtn' + (tags.includes(t) ? ' on' : '')}
                onClick={e => { e.stopPropagation(); quickTag(s, t) }}>
                {t === '神级构图' ? '★神构' : t === '特殊效果' ? '✦特效' : t}
              </button>
            ))}
            <button title="删除此副本" className="lz-qbtn trash"
              onClick={e => { e.stopPropagation(); deleteClip(s.id) }}>🗑</button>
          </div>
          {renderMarks(tags)}
        </div>
        <figcaption className="lz-cap">{s.title || s.source.file}</figcaption>
      </figure>
    )
  }

  // 左侧 dock(单图/套图通用):待部署(剪切) / 复制区(复制)切换
  const renderDock = () => {
    const dockOver = !!(dragId || frameDragId || cmDrag) && over?.key === '__dock__'
    const n = dockMode === 'staging' ? view.staging.total : clips.length
    return (
      <aside className={'lz-dock' + (dockOpen ? ' open' : ' closed') + (dockOver ? ' over' : '')}
        onDragOver={e => {
          if (!(dragId || frameDragId || cmDrag)) return
          e.preventDefault()
          const before = pickBefore(e.currentTarget, e.clientX, e.clientY, dragId)
          if (dockMode === 'clip') setClipOver(before)
          else setOver({ key: '__dock__', beforeId: before })
        }}
        onDrop={e => { if (dragId || frameDragId || cmDrag) { e.preventDefault(); dropOnDock(dockMode === 'clip' ? clipOver : (over?.key === '__dock__' ? over.beforeId : null)) } }}>
        {dockOpen ? (
          <>
            <div className="lz-dock-h">
              <div className="lz-dock-modes">
                <button className={dockMode === 'staging' ? 'on' : ''} onClick={() => setDockMode('staging')}>🅢 待部署</button>
                <button className={dockMode === 'clip' ? 'on' : ''} onClick={() => setDockMode('clip')}>⎘ 复制区</button>
              </div>
              <span className="lz-sec-n">{n}</span>
              <button className="lz-dock-tog" title="收起" onClick={() => setDockOpen(false)}>◀</button>
            </div>
            <div className="lz-dock-tip">{dockMode === 'staging' ? '拖进=剪切(移动原件)' : '拖进=复制(原件不动) · 拖出=粘贴'}</div>
            <div className="lz-dock-body">
              {dockMode === 'staging'
                ? (view.staging.items.length === 0 ? <div className="lz-sec-empty">— 空 —</div> : previewList(view.staging.items, dragId, over?.key === '__dock__' ? over.beforeId : null).map(s => renderCard(s, '', '', '')))
                : (clips.length === 0 ? <div className="lz-sec-empty">拖图到此=复制一份</div> : previewList(clips, dragId && isClip(dragId) ? dragId : null, clipOver).map(s => renderClipCard(s)))}
            </div>
          </>
        ) : (
          <button className="lz-dock-rail" title="展开" onClick={() => setDockOpen(true)}>
            ▶ {dockMode === 'staging' ? '待部署' : '复制区'} {n}
          </button>
        )}
      </aside>
    )
  }

  const dragging = !!(dragId || catDrag)

  return (
    <div className="lz">
      <header className="lz-top">
        <div className="lz-brand">🐕 懒狗库</div>
        <div className="lz-tabs">
          <button className={'lz-tab' + (tab === 'single' ? ' on' : '')} onClick={() => { setTab('single'); setShowTrash(false) }}>单图</button>
          <button className={'lz-tab' + (tab === 'sets' ? ' on' : '')} onClick={() => { setTab('sets'); setShowTrash(false); setSetSel(null); setFrameSel(null); setCompSel(null) }}>套图 {(liveSets.length + compsView('standard').length + compsView('original').length) || ''}</button>
        </div>
        {tab === 'sets' && (
          <div className="lz-subtabs">
            <button className={'lz-subtab' + (setKind === 'repro' ? ' on' : '')} onClick={() => { setSetKind('repro'); setShowTrash(false); setSetSel(null); setFrameSel(null); setCompSel(null) }}>复刻 {liveSets.length || ''}</button>
            <button className={'lz-subtab' + (setKind === 'std' ? ' on' : '')} onClick={() => { setSetKind('std'); setShowTrash(false); setCompSel(null) }}>标准 {compsView('standard').length || ''}</button>
            <button className={'lz-subtab' + (setKind === 'orig' ? ' on' : '')} onClick={() => { setSetKind('orig'); setShowTrash(false); setCompSel(null) }}>原创 {compsView('original').length || ''}</button>
          </div>
        )}
        {tab === 'single' && <>
          <input className="lz-search" placeholder="搜索 名字 / 备注 / 标签 / id…"
            value={query} onChange={e => setQuery(e.target.value)} />
          {allTags.length > 0 && (
            <div className="lz-tagbar">
              <span className="lz-tagbar-l">筛选</span>
              {allTags.map(t => (
                <button key={t} className={'lz-chip' + (tagFilter.has(t) ? ' on' : '')}
                  onClick={() => toggleTagFilter(t)}>{t}<span className="lz-n">{tagCounts[t] ?? 0}</span></button>
              ))}
            </div>
          )}
        </>}
        <div className="lz-size">
          {(['sm', 'md', 'lg'] as Size[]).map(s => (
            <button key={s} className={'lz-szbtn' + (size === s ? ' on' : '')} onClick={() => setSize(s)}>
              {s === 'sm' ? '小' : s === 'md' ? '中' : '大'}
            </button>
          ))}
        </div>
        {tab === 'single' && (
          <button className={'lz-manage' + (manage ? ' on' : '')} onClick={() => setManage(m => !m)}>
            {manage ? '✓ 管理分类' : '⚙ 管理分类'}
          </button>
        )}
        {tab === 'sets' && setKind === 'repro' && (
          <button className="lz-manage" onClick={openPicker}>＋ 导入套图</button>
        )}
        <button className={'lz-manage' + (showTrash ? ' on' : '')} onClick={() => setShowTrash(t => !t)}>
          🗑 垃圾桶{(() => { const n = tab === 'single' ? trashed.length : setKind === 'repro' ? trashedSets.length : trashedComps.filter(c => c.type === (setKind === 'std' ? 'standard' : 'original')).length; return n > 0 ? ` ${n}` : '' })()}
        </button>
        <div className="lz-stat">
          {loading ? '加载中…' : tab === 'single'
            ? <>共 <b>{shots.length}</b>{visibleCount !== shots.length && <> · 筛出 <b>{visibleCount}</b></>}</>
            : setKind === 'repro'
              ? <>共 <b>{liveSets.length}</b> 套 · <b>{liveSets.reduce((a, s) => a + s.count, 0)}</b> 帧</>
              : <>共 <b>{compsView(setKind === 'std' ? 'standard' : 'original').length}</b> 套</>}
        </div>
      </header>

      {err && <div className="lz-err">加载出错:{err} <button onClick={load}>重试</button></div>}

      {/* ============ 单图视图 ============ */}
      {tab === 'single' && (
        <div className={'lz-body' + (dragId ? ' carddrag' : '')}>
          {/* 左:dock(待部署/复制区) */}
          {renderDock()}

          {/* 中:垃圾桶视图 / 大类→中类→小类 画廊 */}
          <main ref={mainRef} className={'lz-main sz-' + size}
            onDragOverCapture={e => { if (dragging) autoScroll(e.clientY) }}>

            {showTrash ? (
              <div className="lz-trashview">
                <div className="lz-trash-h">
                  <span className="lz-group-name">🗑 垃圾桶</span>
                  <span className="lz-sec-n">{trashed.length}</span>
                  <span className="lz-trash-tip">软删除可还原;「清空」才彻底删(连预览图,不影响原出图)</span>
                  {trashed.length > 0 && <button className="lz-mini-btn del" onClick={emptyTrash}>清空垃圾桶</button>}
                </div>
                <div className="lz-cards">
                  {trashed.length === 0 && <div className="lz-sec-empty">垃圾桶是空的</div>}
                  {trashed.map(s => (
                    <figure key={s.id} className="lz-card">
                      <div className="lz-img">
                        {(s.thumb ?? s.preview) ? <img src={'/' + (s.thumb ?? s.preview)} alt="" loading="lazy" /> : <div className="lz-noimg">无预览</div>}
                        <div className="lz-trash-acts">
                          <button onClick={() => restoreShot(s)}>↩ 还原</button>
                          <button className="del" onClick={() => hardDelete(s)}>彻底删</button>
                        </div>
                      </div>
                      <figcaption className="lz-cap">{s.title || s.source.file}</figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            ) : (
              <div className="lz-groups"
                onDragOver={e => { if (catDrag?.kind === 'group') { e.preventDefault(); setCatOver({ key: 'groups', beforeId: pickBeforeCat(e.currentTarget, e.clientY, catDrag.gid) }) } }}
                onDrop={e => { if (catDrag?.kind === 'group') { e.preventDefault(); reorderGroup(catDrag.gid, catOver?.key === 'groups' ? catOver.beforeId : '__end__'); clearCatDrag() } }}>
              {previewList(view.groups, catDrag?.kind === 'group' ? catDrag.gid : null, catOver?.key === 'groups' ? catOver.beforeId : null).map(g => {
              if (filtering && g.total === 0) return null
              const groupCollapsed = collapsed.has(g.id)
              const gGhost = catDrag?.kind === 'group' && catDrag.gid === g.id
              return (
                <section key={g.id} data-catid={g.id} className={'lz-group' + (gGhost ? ' catghost' : '')} style={{ ['--gc' as string]: g.color }}>
                  <div className="lz-group-h"
                    onDragOver={e => { if (dragId) { e.preventDefault(); setOver({ key: bk(g.id), beforeId: null }) } }}
                    onDrop={e => { if (dragId) { e.preventDefault(); drop(g.id, '', '', null) } }}>
                    <span className="lz-handle" draggable title="拖动排序大类"
                      onDragStart={() => setCatDrag({ kind: 'group', gid: g.id })}
                      onDragEnd={clearCatDrag}>⠿</span>
                    <button className="lz-collapse" title={groupCollapsed ? '展开' : '收纳'} onClick={() => toggleCollapse(g.id)}>{groupCollapsed ? '▸' : '▾'}</button>
                    <span className="lz-dot" />
                    {manage
                      ? <input className="lz-cat-name" value={g.name}
                          onChange={e => renameGroup(g.id, e.target.value)} onBlur={persistCats}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                      : <span className="lz-group-name">{g.name}</span>}
                    <span className="lz-sec-n">{g.total}</span>
                    {manage && <>
                      <button className="lz-mini-btn" onClick={() => addSub(g.id)}>＋中类</button>
                      <button className="lz-mini-btn del" onClick={() => delGroup(g)}>删</button>
                    </>}
                  </div>

                  {/* 大类直挂卡片(不属任何中类) */}
                  {!groupCollapsed && (g.direct.items.length > 0 || !filtering) && renderBucket(g.id, '', '', g.direct.items)}

                  {/* 中类(拖动实时换位预览,同图片) */}
                  {!groupCollapsed && (
                  <div className="lz-subs"
                    onDragOver={e => { if (catDrag?.kind === 'sub') { e.preventDefault(); e.stopPropagation(); setCatOver({ key: 'subs:' + g.id, beforeId: pickBeforeCat(e.currentTarget, e.clientY, catDrag.sid) }) } }}
                    onDrop={e => { if (catDrag?.kind === 'sub') { e.preventDefault(); e.stopPropagation(); moveSub(catDrag.gid, catDrag.sid, g.id, catOver?.key === 'subs:' + g.id ? catOver.beforeId : '__end__'); clearCatDrag() } }}>
                  {catDrag?.kind === 'sub' && g.subs.length === 0 && <div className="lz-cat-drophint">放到这里</div>}
                  {previewList(g.subs, catDrag?.kind === 'sub' && catDrag.gid === g.id ? catDrag.sid : null, catOver?.key === 'subs:' + g.id ? catOver.beforeId : null).map(sub => {
                    if (filtering && sub.total === 0) return null
                    const subCollapsed = collapsed.has(sub.id)
                    const subGhost = catDrag?.kind === 'sub' && catDrag.sid === sub.id
                    return (
                      <div key={sub.id} data-catid={sub.id} className={'lz-sub' + (subGhost ? ' catghost' : '')}>
                        <div className="lz-sub-h"
                          onDragOver={e => { if (dragId) { e.preventDefault(); setOver({ key: bk(g.id, sub.id), beforeId: null }) } }}
                          onDrop={e => { if (dragId) { e.preventDefault(); drop(g.id, sub.id, '', null) } }}>
                          <span className="lz-handle" draggable title="拖动排序中类"
                            onDragStart={() => setCatDrag({ kind: 'sub', gid: g.id, sid: sub.id })}
                            onDragEnd={clearCatDrag}>⠿</span>
                          <button className="lz-collapse" title={subCollapsed ? '展开' : '收纳'} onClick={() => toggleCollapse(sub.id)}>{subCollapsed ? '▸' : '▾'}</button>
                          <span className="lz-sub-mark">└</span>
                          {manage
                            ? <input className="lz-cat-name sub" value={sub.name}
                                onChange={e => renameSub(g.id, sub.id, e.target.value)} onBlur={persistCats}
                                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                            : <span className="lz-sub-name">{sub.name}</span>}
                          <span className="lz-sec-n">{sub.total}</span>
                          {manage && <>
                            <button className="lz-mini-btn" onClick={() => addSubSub(g.id, sub.id)}>＋小类</button>
                            <button className="lz-mini-btn del" onClick={() => delSub(g.id, sub.id, sub.name, sub.total)}>删</button>
                          </>}
                        </div>

                        {/* 中类直挂卡片(不属任何小类) */}
                        {!subCollapsed && (sub.direct.items.length > 0 || !filtering) && renderBucket(g.id, sub.id, '', sub.direct.items)}

                        {/* 小类(拖动实时换位预览) */}
                        {!subCollapsed && (
                        <div className="lz-subsubs"
                          onDragOver={e => { if (catDrag?.kind === 'subsub') { e.preventDefault(); e.stopPropagation(); setCatOver({ key: 'subsubs:' + sub.id, beforeId: pickBeforeCat(e.currentTarget, e.clientY, catDrag.ssid) }) } }}
                          onDrop={e => { if (catDrag?.kind === 'subsub') { e.preventDefault(); e.stopPropagation(); moveSubSub(catDrag.gid, catDrag.sid, catDrag.ssid, g.id, sub.id, catOver?.key === 'subsubs:' + sub.id ? catOver.beforeId : '__end__'); clearCatDrag() } }}>
                        {catDrag?.kind === 'subsub' && sub.subsubs.length === 0 && <div className="lz-cat-drophint">放到这里</div>}
                        {previewList(sub.subsubs, catDrag?.kind === 'subsub' && catDrag.sid === sub.id ? catDrag.ssid : null, catOver?.key === 'subsubs:' + sub.id ? catOver.beforeId : null).map(ss => {
                          if (filtering && ss.total === 0) return null
                          const ssCollapsed = collapsed.has(ss.id)
                          const ssGhost = catDrag?.kind === 'subsub' && catDrag.ssid === ss.id
                          return (
                            <div key={ss.id} data-catid={ss.id} className={'lz-subsub' + (ssGhost ? ' catghost' : '')}>
                              <div className="lz-subsub-h"
                                onDragOver={e => { if (dragId) { e.preventDefault(); setOver({ key: bk(g.id, sub.id, ss.id), beforeId: null }) } }}
                                onDrop={e => { if (dragId) { e.preventDefault(); drop(g.id, sub.id, ss.id, null) } }}>
                                <span className="lz-handle" draggable title="拖动排序小类"
                                  onDragStart={() => setCatDrag({ kind: 'subsub', gid: g.id, sid: sub.id, ssid: ss.id })}
                                  onDragEnd={clearCatDrag}>⠿</span>
                                <button className="lz-collapse" title={ssCollapsed ? '展开' : '收纳'} onClick={() => toggleCollapse(ss.id)}>{ssCollapsed ? '▸' : '▾'}</button>
                                <span className="lz-subsub-mark">·</span>
                                {manage
                                  ? <input className="lz-cat-name subsub" value={ss.name}
                                      onChange={e => renameSubSub(g.id, sub.id, ss.id, e.target.value)} onBlur={persistCats}
                                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                                  : <span className="lz-subsub-name">{ss.name}</span>}
                                <span className="lz-sec-n">{ss.total}</span>
                                {manage && <button className="lz-mini-btn del" onClick={() => delSubSub(g.id, sub.id, ss.id, ss.name, ss.total)}>删</button>}
                              </div>
                              {!ssCollapsed && renderBucket(g.id, sub.id, ss.id, ss.items)}
                            </div>
                          )
                        })}
                        </div>
                        )}
                      </div>
                    )
                  })}
                  </div>
                  )}
                </section>
              )
              })}
              </div>
            )}
            {!showTrash && manage && <button className="lz-add-group" onClick={addGroup}>＋ 新增大类</button>}
          </main>

          {/* 右:编辑抽屉 */}
          {draft && (() => {
            const dg = draft.category ? groupById.get(draft.category) : undefined
            const dsub = dg && draft.subcategory ? dg.subs.find(s => s.id === draft.subcategory) : undefined
            return (
              <aside className="lz-edit">
                <div className="lz-edit-head">
                  <button className="lz-x" onClick={() => setSelId(null)}>✕</button>
                  <div className="lz-edit-title">编辑单图</div>
                </div>
                <div className="lz-edit-body">
                  <div className="lz-preview">
                    {draft.preview ? <img src={'/' + draft.preview} alt="" /> : <div className="lz-noimg big">无预览</div>}
                  </div>

                  <PromptView shot={draft} />

                  <label className="lz-field">
                    <span>名字</span>
                    <input value={draft.title ?? ''} placeholder={draft.source.file}
                      onChange={e => setDraft(d => d && { ...d, title: e.target.value })} />
                  </label>

                  <label className="lz-field">
                    <span>大类</span>
                    <select value={dg ? draft.category : ''}
                      onChange={e => setDraft(d => d && { ...d, category: e.target.value, subcategory: '', subsubcategory: '' })}>
                      <option value="">（待部署区）</option>
                      {cats.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </label>

                  {dg && dg.subs.length > 0 && (
                    <label className="lz-field">
                      <span>中类</span>
                      <select value={dsub ? draft.subcategory : ''}
                        onChange={e => setDraft(d => d && { ...d, subcategory: e.target.value, subsubcategory: '' })}>
                        <option value="">（不分中类）</option>
                        {dg.subs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </label>
                  )}

                  {dsub && (dsub.subs ?? []).length > 0 && (
                    <label className="lz-field">
                      <span>小类</span>
                      <select value={(dsub.subs ?? []).some(x => x.id === draft.subsubcategory) ? draft.subsubcategory : ''}
                        onChange={e => setDraft(d => d && { ...d, subsubcategory: e.target.value })}>
                        <option value="">（不分小类）</option>
                        {(dsub.subs ?? []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </label>
                  )}

                  <div className="lz-field">
                    <span>标签</span>
                    <div className="lz-chips">
                      {[...new Set([...SUGGESTED_TAGS, ...(draft.tags ?? [])])].map(t => (
                        <button key={t} className={'lz-chip' + ((draft.tags ?? []).includes(t) ? ' on' : '')}
                          onClick={() => toggleDraftTag(t)}>{t}</button>
                      ))}
                    </div>
                    <div className="lz-addtag">
                      <input value={newTag} placeholder="新标签…" onChange={e => setNewTag(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNewTag() } }} />
                      <button onClick={addNewTag}>＋</button>
                    </div>
                  </div>

                  <label className="lz-field">
                    <span>备注</span>
                    <textarea rows={2} value={draft.note ?? ''}
                      onChange={e => setDraft(d => d && { ...d, note: e.target.value })} />
                  </label>

                  <label className="lz-field row">
                    <span>状态</span>
                    <select value={draft.status}
                      onChange={e => setDraft(d => d && { ...d, status: e.target.value as LazyShot['status'] })}>
                      <option value="draft">草稿</option>
                      <option value="confirmed">已确认</option>
                    </select>
                  </label>

                  <div className="lz-src">
                    <div><b>来源</b> {draft.source.folder} · seed {draft.source.seed ?? '—'}</div>
                    <div><b>换槽</b> {(['artist', 'character', 'clothing', 'scene'] as const).map(k => (
                      <span key={k} className={'lz-swap' + (draft.swapTested?.[k] ? ' ok' : '')}>
                        {{ artist: '画师', character: '角色', clothing: '衣服', scene: '场景' }[k]}{draft.swapTested?.[k] ? '✓' : '—'}
                      </span>
                    ))}</div>
                  </div>

                  <details className="lz-adv">
                    <summary>高级 · 骨架七面 / 固定维度（拼剧本用）</summary>
                    {facetDefs.map(f => {
                      const rating = draft.facets?.rating?.[0]
                      const vis = groupsOf(f).filter(gr => !gr.gate || (rating ? gr.gate.includes(rating) : true))
                      return (
                        <div className="lz-efacet" key={f.key}>
                          <div className="lz-efacet-h">{f.label} · {f.name}{f.multi ? '（多选）' : ''}</div>
                          {vis.map((gr, gi) => (
                            <div className="lz-grp" key={gi}>
                              {gr.name && <div className="lz-grp-h">{gr.name}</div>}
                              <div className="lz-chips">
                                {gr.values.map(v => (
                                  <button key={v.v} className={'lz-chip' + (draft.facets?.[f.key]?.includes(v.v) ? ' on' : '')}
                                    onClick={() => setDraftFacet(f.key, v.v, f.multi)}>{v.zh}</button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })}
                    <div className="lz-efacet">
                      <div className="lz-efacet-h">固定维度 tag（blocks）</div>
                      {BLOCK_KEYS.map(({ k, label }) => (
                        <label className="lz-field" key={k}>
                          <span>{label}</span>
                          <textarea rows={2} value={draft.blocks?.[k] ?? ''}
                            onChange={e => setDraft(d => d && { ...d, blocks: { ...d.blocks, [k]: e.target.value } })} />
                        </label>
                      ))}
                    </div>
                  </details>
                </div>

                {batch && (
                  <div className="lz-edit-run">
                    <button className="lz-runnai aw" onClick={() => runShotToNai(draft, true)}>▶ 跑图(换AW)</button>
                    <button className="lz-runnai" onClick={() => runShotToNai(draft, false)}>▶ 跑图(原角色)</button>
                  </div>
                )}
                <div className="lz-edit-foot">
                  <button className="lz-del" onClick={() => trashShot(draft)} disabled={saving}>🗑 删除</button>
                  <div className="lz-foot-r">
                    {dirty && <span className="lz-dirty">未保存</span>}
                    <button className="lz-save" onClick={save} disabled={saving || !dirty}>{saving ? '保存中…' : '保存'}</button>
                  </div>
                </div>
              </aside>
            )
          })()}
        </div>
      )}

      {/* ============ 复刻套图视图(套图库·复刻子类) ============ */}
      {tab === 'sets' && setKind === 'repro' && (
      <div className={'lz-body' + (dragId || frameDragId ? ' carddrag' : '')}>
        {/* 左 dock 常显:画廊里拖单图到套图卡=加入该套;详情里拖进套内;帧可拖回 dock */}
        {renderDock()}
        <main ref={mainRef} className={'lz-main sz-' + size + ' lz-setmain'}
          onDragOverCapture={e => { if (dragSetId || frameDragId || dragId) autoScroll(e.clientY) }}>

          {/* 套图详情:点封面进来,看每帧(可拖排序) */}
          {curSet ? (
            <div className="lz-set-detail">
              <div className="lz-set-detail-h">
                <button className="lz-mini-btn" onClick={() => { setSetSel(null); setFrameSel(null) }}>◀ 返回套图</button>
                <input className="lz-cat-name" value={curSet.title}
                  onChange={e => renameSet(curSet.id, e.target.value)}
                  onBlur={() => setsMeta({ [curSet.id]: { title: curSet.title } })}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                <span className="lz-sec-n">{curSet.count} 帧</span>
                <span className="lz-trash-tip">点帧可编辑(收藏/备注/设封面) · 拖动帧调顺序 · 悬浮看大图</span>
                {batch && (
                  <>
                    <button className="lz-mini-btn run aw" onClick={() => runSetToNai(curSet, true)}>▶ 整套换AW进队列</button>
                    <button className="lz-mini-btn run" onClick={() => runSetToNai(curSet, false)}>▶ 整套原角色进队列</button>
                  </>
                )}
                <button className="lz-mini-btn del" onClick={() => removeSet(curSet)}>彻底删整套</button>
              </div>
              <div className={'lz-frames' + (frameDragId || dragId ? ' framedrag' : '')}
                onDragOver={e => {
                  if (frameDragId) { e.preventDefault(); setFrameOver(pickBefore(e.currentTarget, e.clientX, e.clientY, frameDragId)) }
                  else if (dragId) { e.preventDefault(); setFrameOver('__end__') /* dock 项进套图一律末尾,不按光标插 */ }
                }}
                onDrop={e => {
                  if (frameDragId) { e.preventDefault(); activeContainer?.reorderMember(frameDragId, frameOver) }
                  else if (dragId) { e.preventDefault(); const x = shots.find(y => y.id === dragId); setFrameOver(null); if (x) activeContainer?.addFromDock(x); setDragId(null); setOver(null) }
                }}>
                {previewList(curSet.frames, frameDragId, frameOver).map((f, i) => {
                  const ftags = f.tags ?? []
                  return (
                    <figure key={f.id} data-lzid={f.id}
                      className={'lz-card lz-frame' + (f.id === curSet.coverId ? ' cover' : '') + (f.id === frameSel ? ' sel' : '') + (f.id === frameDragId ? ' dragging' : '')}
                      draggable
                      onDragStart={e => { setFrameDragId(f.id); e.dataTransfer.effectAllowed = 'move' }}
                      onDragEnd={() => { setFrameDragId(null); setFrameOver(null) }}
                      onClick={() => setFrameSel(f.id)}>
                      <div className="lz-img" {...zoomProps(f.preview)}>
                        {(f.thumb ?? f.preview) ? <img src={'/' + (f.thumb ?? f.preview)} alt="" loading="lazy" draggable={false} /> : <div className="lz-noimg">无预览</div>}
                        <span className="lz-badge idx">第{i + 1}张</span>
                        {f.id === curSet.coverId && <span className="lz-badge cover">封面</span>}
                        <div className="lz-quick">
                          {SUGGESTED_TAGS.map(t => (
                            <button key={t} title={t} className={'lz-qbtn' + (ftags.includes(t) ? ' on' : '')}
                              onClick={e => { e.stopPropagation(); frameQuickTag(curSet.id, f, t) }}>
                              {t === '神级构图' ? '★神构' : t === '特殊效果' ? '✦特效' : t}
                            </button>
                          ))}
                          {f.id !== curSet.coverId && <button className="lz-qbtn" title="设为封面"
                            onClick={e => { e.stopPropagation(); activeContainer?.makeCover(f.id) }}>封面</button>}
                        </div>
                        {renderMarks(ftags)}
                        {ftags.filter(t => !SUGGESTED_TAGS.includes(t)).length > 0 && (
                          <div className="lz-card-tags">
                            {ftags.filter(t => !SUGGESTED_TAGS.includes(t)).map(t => <span key={t} className="lz-tag">{t}</span>)}
                          </div>
                        )}
                      </div>
                      <figcaption className="lz-cap">第{i + 1}张 · {f.source.file}</figcaption>
                    </figure>
                  )
                })}
                <div className="lz-frame-end">{frameDragId ? '放到末尾' : ''}</div>
              </div>
            </div>
          ) : showTrash ? (
            /* 套图垃圾桶 */
            <div className="lz-trashview">
              <div className="lz-trash-h">
                <span className="lz-group-name">🗑 套图垃圾桶</span>
                <span className="lz-sec-n">{trashedSets.length}</span>
                <span className="lz-trash-tip">软删除可还原;「彻底删整套」才真删(连预览图,不影响原出图)</span>
              </div>
              <div className="lz-sets">
                {trashedSets.length === 0 && <div className="lz-sec-empty">套图垃圾桶是空的</div>}
                {trashedSets.map(s => (
                  <figure key={s.id} className="lz-setcard">
                    <div className="lz-set-cover">
                      {s.cover ? <img src={'/' + s.cover} alt="" loading="lazy" /> : <div className="lz-noimg">无封面</div>}
                      <span className="lz-set-count">{s.count} 帧</span>
                      <div className="lz-trash-acts">
                        <button onClick={() => restoreSet(s.id)}>↩ 还原</button>
                        <button className="del" onClick={() => removeSet(s)}>彻底删</button>
                      </div>
                    </div>
                    <figcaption className="lz-cap">{s.title}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ) : (
            /* 套图画廊:封面卡片,可拖排序,点封面进详情 */
            <div className={'lz-sets' + (dragSetId ? ' setdrag' : '')}
              onDragOver={e => { if (dragSetId) { e.preventDefault(); setOverSetId(pickBefore(e.currentTarget, e.clientX, e.clientY, dragSetId)) } }}
              onDrop={e => { if (dragSetId) { e.preventDefault(); arrangeSets(dragSetId, overSetId) } }}>
              {liveSets.length === 0 && <div className="lz-sec-empty big">还没有套图。点右上「＋ 导入套图」从评分文件夹整夹导入。</div>}
              {previewList(liveSets, dragSetId, overSetId).map((s, i) => {
                return (
                  <figure key={s.id} data-lzid={s.id}
                    className={'lz-setcard' + (s.id === dragSetId ? ' dragging' : '') + (dragId && over?.key === 'setcard:' + s.id ? ' dropfx' : '')}
                    draggable
                    onDragStart={e => { setDragSetId(s.id); e.dataTransfer.effectAllowed = 'move' }}
                    onDragEnd={() => { setDragSetId(null); setOverSetId(null) }}
                    onDragOver={e => { if (dragId) { e.preventDefault(); e.stopPropagation(); setOver({ key: 'setcard:' + s.id, beforeId: null }) } }}
                    onDrop={e => { if (dragId) { e.preventDefault(); e.stopPropagation(); const x = shots.find(y => y.id === dragId); if (x) dockItemToSet(s.id, x); setDragId(null); setOver(null) } }}
                    onClick={() => setSetSel(s.id)}>
                    <div className="lz-set-cover" {...zoomProps(s.cover)}>
                      <span className="lz-set-no">{i + 1}</span>
                      {s.cover ? <img src={'/' + s.cover} alt="" loading="lazy" draggable={false} /> : <div className="lz-noimg">无封面</div>}
                      <span className="lz-set-count">📚 {s.count} 张{(() => { const n = s.frames.filter(f => (f.tags ?? []).includes('神级构图')).length; return n ? ` · ★${n}` : '' })()}</span>
                      <button className="lz-qbtn trash lz-set-trash" title="删除整套到垃圾桶"
                        onClick={e => { e.stopPropagation(); trashSet(s.id) }}>🗑</button>
                    </div>
                    <figcaption className="lz-cap" title={s.title}>{s.title}</figcaption>
                    <div className="lz-set-sub">{s.count} 张图</div>
                  </figure>
                )
              })}
            </div>
          )}
        </main>

        {/* 套图·帧编辑抽屉(像单图:收藏神构/特效 + 备注 + 设封面;只写 sets_meta) */}
        {curSet && frameSel && (() => {
          const f = curSet.frames.find(x => x.id === frameSel)
          if (!f) return null
          const i = curSet.frames.findIndex(x => x.id === frameSel)
          const ftags = f.tags ?? []
          return (
            <aside className="lz-edit">
              <div className="lz-edit-head">
                <button className="lz-x" onClick={() => setFrameSel(null)}>✕</button>
                <div className="lz-edit-title">编辑帧 · 第{i + 1}张</div>
              </div>
              <div className="lz-edit-body">
                <div className="lz-preview">
                  {(f.thumb ?? f.preview) ? <img src={'/' + (f.thumb ?? f.preview)} alt="" /> : <div className="lz-noimg big">无预览</div>}
                </div>
                <PromptView shot={f} editable={!f.id.startsWith('copy_')} onSave={saveFrame} />
                <div className="lz-field">
                  <span>标签 / 收藏</span>
                  <div className="lz-chips">
                    {SUGGESTED_TAGS.map(t => (
                      <button key={t} className={'lz-chip' + (ftags.includes(t) ? ' on' : '')}
                        onClick={() => frameQuickTag(curSet.id, f, t)}>{t}</button>
                    ))}
                  </div>
                </div>
                <label className="lz-field">
                  <span>备注</span>
                  <textarea rows={3} value={f.note ?? ''}
                    onChange={e => frameNoteLocal(curSet.id, f.id, e.target.value)}
                    onBlur={e => frameNoteSave(curSet.id, f.id, e.target.value)} />
                </label>
                <div className="lz-field">
                  <span>封面</span>
                  {f.id === curSet.coverId
                    ? <div className="lz-trash-tip">这张是当前封面</div>
                    : <button className="lz-mini-btn" onClick={() => activeContainer?.makeCover(f.id)}>设为本套封面</button>}
                </div>
                <div className="lz-field">
                  <span>移出本套</span>
                  <div className="lz-row-btns">
                    <button className="lz-mini-btn" onClick={() => { activeContainer?.memberToStaging(f.id); setFrameSel(null) }}>→ 单图待部署(剪切)</button>
                    <button className="lz-mini-btn" onClick={() => activeContainer?.memberToClip(f.id)}>→ 复制区(复制)</button>
                    <button className="lz-mini-btn del" onClick={() => activeContainer?.removeMember(f.id)}>移出本套</button>
                  </div>
                </div>
                <div className="lz-src">
                  <div><b>来源</b> {f.source.folder}</div>
                  <div><b>文件</b> {f.source.file}</div>
                </div>
              </div>
            </aside>
          )
        })()}
      </div>
      )}

      {/* ============ 标准套图 / 原创套图(引用型组合)视图 ============ */}
      {tab === 'sets' && (setKind === 'std' || setKind === 'orig') && (() => {
        const type: 'standard' | 'original' = setKind === 'std' ? 'standard' : 'original'
        const list = compsView(type)
        const tc = trashedComps.filter(c => c.type === type)
        return (
          <div className={'lz-body' + (cmDrag || dragId ? ' carddrag' : '')}>
            {/* dock 常显(单图/套图公用一套):拖单图进组合成员区/组合卡=引用为成员;被引用后该单图即从 dock 消失(已部署) */}
            {renderDock()}
            <main ref={mainRef} className={'lz-main sz-' + size + ' lz-setmain'}
              onDragOverCapture={e => { if (cmDrag || dragId) autoScroll(e.clientY) }}>
              {curComp && curComp.type === type ? (
                /* 组合详情:成员有序列表(拖动调顺序、点选添加、设封面、移出) */
                <div className="lz-set-detail">
                  <div className="lz-set-detail-h">
                    <button className="lz-mini-btn" onClick={() => setCompSel(null)}>◀ 返回</button>
                    <input className="lz-cat-name" value={curComp.title ?? ''}
                      onChange={e => renameComp(curComp.id, e.target.value)}
                      onBlur={() => saveCompTitle(curComp.id, curComp.title ?? '')}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                    <span className="lz-sec-n">{curComp.count} 帧{curComp.missingCount ? ` · ⚠${curComp.missingCount} 失效` : ''}</span>
                    <span className="lz-trash-tip">{type === 'standard' ? '标准套图=可复用的标准流程模板' : '原创套图=标准套图+精品单图 组合成的成品'} · 拖动调顺序 · 悬浮看大图</span>
                    <button className="lz-mini-btn" onClick={() => { setAdder({ compId: curComp.id, src: 'shot' }); setAdderQ('') }}>＋ 添加成员</button>
                    <button className="lz-mini-btn del" onClick={() => deleteComp(curComp.id, true)}>彻底删</button>
                  </div>
                  <div className={'lz-frames' + (cmDrag || dragId ? ' framedrag' : '')}
                    onDragOver={e => { if (cmDrag) { e.preventDefault(); setCmOver(pickBefore(e.currentTarget, e.clientX, e.clientY, cmDrag)) } else if (dragId) { e.preventDefault() } }}
                    onDrop={e => {
                      if (cmDrag) { e.preventDefault(); activeContainer?.reorderMember(cmDrag, cmOver) }
                      else if (dragId) { e.preventDefault(); const x = shots.find(y => y.id === dragId); if (x) activeContainer?.addFromDock(x); setDragId(null); setOver(null) }
                    }}>
                    {curComp.members.length === 0 && <div className="lz-sec-empty big">还没有成员。点上方「＋ 添加成员」从 {type === 'standard' ? '精品单图 / 复刻套图帧' : '标准套图 / 精品单图'} 里挑。</div>}
                    {previewList(curComp.members.map((m, i) => ({ ...m, id: mkey(m, i) })), cmDrag, cmOver).map((m, i) => {
                      const isCover = !!curComp.cover && curComp.cover.kind === m.kind && curComp.cover.ref === m.ref
                      return (
                        <figure key={m.id} data-lzid={m.id}
                          className={'lz-card lz-frame' + (isCover ? ' cover' : '') + (m.missing ? ' lz-missing' : '') + (m.id === cmDrag ? ' dragging' : '')}
                          draggable
                          onDragStart={e => { setCmDrag(m.id); e.dataTransfer.effectAllowed = 'move' }}
                          onDragEnd={() => { setCmDrag(null); setCmOver(null) }}
                          onClick={() => setMemberSel(m.id)}>
                          <div className="lz-img" {...(m.missing ? {} : zoomProps(m.preview))}>
                            {m.missing
                              ? <div className="lz-noimg">⚠ 引用已失效<br /><small>{m.kind}:{(m.ref.split('/').pop()) || m.ref}</small></div>
                              : m.preview ? <img src={'/' + m.preview} alt="" loading="lazy" draggable={false} /> : <div className="lz-noimg">无预览</div>}
                            <span className="lz-badge idx">第{i + 1}张</span>
                            {m.kind === 'standard' && <span className="lz-badge draft">标准</span>}
                            {isCover && <span className="lz-badge cover">封面</span>}
                            {!m.missing && (
                              <div className="lz-quick">
                                {!isCover && <button className="lz-qbtn" title="设为封面" onClick={e => { e.stopPropagation(); activeContainer?.makeCover(m.id) }}>封面</button>}
                                <button className="lz-qbtn trash" title="删除(退回待部署请拖到侧栏)" onClick={e => { e.stopPropagation(); activeContainer?.deleteMember(m.id) }}>✕</button>
                              </div>
                            )}
                          </div>
                          <figcaption className="lz-cap">第{i + 1}张 · {m.mtitle ?? m.ref}</figcaption>
                        </figure>
                      )
                    })}
                    <div className="lz-frame-end">{cmDrag ? '放到末尾' : ''}</div>
                  </div>
                </div>
              ) : showTrash ? (
                /* 组合垃圾桶 */
                <div className="lz-trashview">
                  <div className="lz-trash-h">
                    <span className="lz-group-name">🗑 {type === 'standard' ? '标准' : '原创'}套图垃圾桶</span>
                    <span className="lz-sec-n">{tc.length}</span>
                    <span className="lz-trash-tip">软删可还原;「彻底删」只删组合本身(引用的图/帧不受影响)</span>
                  </div>
                  <div className="lz-sets">
                    {tc.length === 0 && <div className="lz-sec-empty">空的</div>}
                    {tc.map(c => (
                      <figure key={c.id} className="lz-setcard">
                        <div className="lz-set-cover">
                          {c.coverPreview ? <img src={'/' + c.coverPreview} alt="" loading="lazy" /> : <div className="lz-noimg">无封面</div>}
                          <span className="lz-set-count">{c.count} 帧</span>
                          <div className="lz-trash-acts">
                            <button onClick={() => restoreComp(c.id)}>↩ 还原</button>
                            <button className="del" onClick={() => deleteComp(c.id, true)}>彻底删</button>
                          </div>
                        </div>
                        <figcaption className="lz-cap">{c.title}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              ) : (
                /* 组合画廊 */
                <div className="lz-sets">
                  <button className="lz-add-group" onClick={() => createComp(type)}>＋ 新建{type === 'standard' ? '标准' : '原创'}套图</button>
                  {list.length === 0 && <div className="lz-sec-empty big">{type === 'standard'
                    ? '还没有标准套图。新建后从 精品单图 / 复刻套图帧 里挑出"重复性强的标准流程"(如正常位全流程)。'
                    : '还没有原创套图。新建后用 标准套图 + 精品单图 组合出你的成品。'}</div>}
                  {list.map((c, i) => (
                    <figure key={c.id}
                      className={'lz-setcard' + (dragId && over?.key === 'compcard:' + c.id ? ' dropfx' : '')}
                      onDragOver={e => { if (dragId) { e.preventDefault(); setOver({ key: 'compcard:' + c.id, beforeId: null }) } }}
                      onDrop={e => { if (dragId) { e.preventDefault(); compAddMembers(c.id, [{ kind: 'shot', ref: dragId, seq: 0 }]); setDragId(null); setOver(null) } }}
                      onClick={() => setCompSel(c.id)}>
                      <div className="lz-set-cover" {...zoomProps(c.coverPreview)}>
                        <span className="lz-set-no">{i + 1}</span>
                        {c.coverPreview ? <img src={'/' + c.coverPreview} alt="" loading="lazy" draggable={false} /> : <div className="lz-noimg">无封面</div>}
                        <span className="lz-set-count">📚 {c.count} 张{c.missingCount ? ` · ⚠${c.missingCount}` : ''}</span>
                        <button className="lz-qbtn trash lz-set-trash" title="删到垃圾桶" onClick={e => { e.stopPropagation(); deleteComp(c.id, false) }}>🗑</button>
                      </div>
                      <figcaption className="lz-cap" title={c.title}>{c.title}</figcaption>
                      <div className="lz-set-sub">{c.count} 张图</div>
                    </figure>
                  ))}
                </div>
              )}
            </main>

            {/* 组合成员编辑抽屉(单点成员打开:看大图 + 设封面 + 移出;成员是引用,不存独立 tags/备注) */}
            {curComp && curComp.type === type && memberSel && (() => {
              const idx = curComp.members.findIndex((m, i) => mkey(m, i) === memberSel)
              if (idx < 0) return null
              const m = curComp.members[idx]
              const isCover = !!curComp.cover && curComp.cover.kind === m.kind && curComp.cover.ref === m.ref
              return (
                <aside className="lz-edit">
                  <div className="lz-edit-head">
                    <button className="lz-x" onClick={() => setMemberSel(null)}>✕</button>
                    <div className="lz-edit-title">成员 · 第{idx + 1}张{isCover ? ' · 封面' : ''}</div>
                  </div>
                  <div className="lz-edit-body">
                    <div className="lz-preview">
                      {m.missing
                        ? <div className="lz-noimg big">⚠ 引用已失效<br /><small>{m.kind}:{m.ref}</small></div>
                        : m.preview ? <img src={'/' + m.preview} alt="" /> : <div className="lz-noimg big">无预览</div>}
                    </div>
                    {!m.missing && (() => {
                      // 组合成员=引用,解析到底层单图/套图帧读其 prompt(standard 嵌套无本体,跳过)
                      const under = m.kind === 'shot' ? shots.find(x => x.id === m.ref)
                        : m.kind === 'frame' ? sets.flatMap(x => x.frames).find(fr => fr.id === m.ref)
                        : undefined
                      if (!under) return null
                      // 组合成员=引用,但底下就是那一帧本体 → 直接在这里编辑(同一个 set-frame-update 端点,
                      // 改完所有引用它的组合一起变=引用语义本就如此)。单图(shot)走另一个端点,暂只读。
                      const canEdit = m.kind === 'frame' && !under.id.startsWith('copy_')
                      return <>
                        <PromptView shot={under} editable={canEdit} onSave={canEdit ? saveFrame : undefined} />
                        {!canEdit && <div className="lz-tok-ronote">这是精品单图（shots 库），编辑入口在散图库那边。</div>}
                      </>
                    })()}
                    <div className="lz-field"><span>类型</span><div>{m.kind === 'shot' ? '精品单图' : m.kind === 'frame' ? '复刻套图帧' : '标准套图'}</div></div>
                    <div className="lz-field"><span>标题 / 引用</span><div className="lz-src">{m.mtitle ?? m.ref}</div></div>
                    {!m.missing && (
                      <div className="lz-edit-run">
                        {!isCover && <button className="lz-mini-btn" onClick={() => activeContainer?.makeCover(memberSel)}>设为封面</button>}
                        <button className="lz-mini-btn" onClick={() => { activeContainer?.memberToStaging(memberSel); setMemberSel(null) }}>→ 单图待部署(剪切)</button>
                        <button className="lz-mini-btn" onClick={() => activeContainer?.memberToClip(memberSel)}>→ 复制区(复制)</button>
                        <button className="lz-mini-btn del" onClick={() => { activeContainer?.removeMember(memberSel); setMemberSel(null) }}>移出本套</button>
                      </div>
                    )}
                  </div>
                </aside>
              )
            })()}
          </div>
        )
      })()}

      {/* 添加组合成员选择器(点候选即加入,可连续加) */}
      {adder && (() => {
        const comp = comps.find(c => c.id === adder.compId)
        const q = adderQ.trim().toLowerCase()
        const isOrig = comp?.type === 'original'
        return (
          <div className="lz-modal-bg" onClick={() => setAdder(null)}>
            <div className="lz-import" onClick={e => e.stopPropagation()} style={{ maxWidth: 760 }}>
              <div className="lz-import-h">
                <b>添加成员 → {comp?.title}</b>
                <span className="lz-trash-tip">点候选即加入(可连续加)</span>
                <button className="lz-x" onClick={() => setAdder(null)}>✕</button>
              </div>
              <div className="lz-tabs" style={{ margin: '4px 0' }}>
                <button className={'lz-tab' + (adder.src === 'shot' ? ' on' : '')} onClick={() => setAdder(a => a && { ...a, src: 'shot', setId: undefined })}>精品单图</button>
                <button className={'lz-tab' + (adder.src === 'frame' ? ' on' : '')} onClick={() => setAdder(a => a && { ...a, src: 'frame', setId: undefined })}>复刻套图帧</button>
                {isOrig && <button className={'lz-tab' + (adder.src === 'standard' ? ' on' : '')} onClick={() => setAdder(a => a && { ...a, src: 'standard', setId: undefined })}>标准套图</button>}
              </div>
              <input className="lz-search" placeholder="搜…" value={adderQ} onChange={e => setAdderQ(e.target.value)} />
              <div className="lz-import-list lz-pickgrid">
                {adder.src === 'shot' && shots.filter(s => !s.trashed && !s.clip && (!q || (s.title || s.source.file).toLowerCase().includes(q))).map(s => (
                  <button key={s.id} className="lz-pick" title={s.title || s.source.file} onClick={() => compAddMembers(adder.compId, [{ kind: 'shot', ref: s.id, seq: 0 }])}>
                    {(s.thumb ?? s.preview) ? <img src={'/' + (s.thumb ?? s.preview)} alt="" loading="lazy" /> : <span className="lz-noimg">无</span>}
                  </button>
                ))}
                {adder.src === 'frame' && !adder.setId && liveSets.filter(s => !q || s.title.toLowerCase().includes(q)).map(s => (
                  <div key={s.id} className="lz-import-row" style={{ width: '100%', cursor: 'pointer' }} onClick={() => setAdder(a => a && { ...a, setId: s.id })}>
                    <span className="lz-import-name">{s.title}</span><span className="lz-sec-n">{s.count} 帧</span><button className="lz-mini-btn">展开 ▸</button>
                  </div>
                ))}
                {adder.src === 'frame' && adder.setId && (() => {
                  const s = sets.find(x => x.id === adder.setId)
                  return (
                    <>
                      <button className="lz-mini-btn" style={{ width: '100%' }} onClick={() => setAdder(a => a && { ...a, setId: undefined })}>◀ 套图列表</button>
                      {(s?.frames ?? []).map((f, i) => (
                        <button key={f.id} className="lz-pick" title={`第${i + 1}张 · ${f.source.file}`} onClick={() => compAddMembers(adder.compId, [{ kind: 'frame', ref: f.id, seq: 0 }])}>
                          {(f.thumb ?? f.preview) ? <img src={'/' + (f.thumb ?? f.preview)} alt="" loading="lazy" /> : <span className="lz-noimg">无</span>}
                        </button>
                      ))}
                    </>
                  )
                })()}
                {adder.src === 'standard' && compsView('standard').filter(c => !q || (c.title || '').toLowerCase().includes(q)).map(c => (
                  <div key={c.id} className="lz-import-row" style={{ width: '100%' }}>
                    <span className="lz-import-name">{c.title}</span><span className="lz-sec-n">{c.count} 帧</span>
                    <button className="lz-mini-btn" onClick={() => compAddMembers(adder.compId, [{ kind: 'standard', ref: c.id, seq: 0 }])}>添加</button>
                  </div>
                ))}
              </div>
              <div className="lz-dock-tip">已有 {comp?.count ?? 0} 个成员 · 右上 ✕ 关闭</div>
            </div>
          </div>
        )
      })()}

      {/* 悬浮跟随大图(智能夹取,整图始终可见) */}
      {zoom && <ZoomLayer src={zoom.src} x={zoom.x} y={zoom.y} />}

      {/* 导入套图选择器 */}
      {picker && (
        <div className="lz-modal-bg" onClick={() => setPicker(null)}>
          <div className="lz-import" onClick={e => e.stopPropagation()}>
            <div className="lz-import-h">
              <b>导入套图</b><span className="lz-trash-tip">选一个评分文件夹,整夹图片作为一套导入</span>
              <button className="lz-x" onClick={() => setPicker(null)}>✕</button>
            </div>
            <input className="lz-search" placeholder="搜文件夹…" value={pickerQ} onChange={e => setPickerQ(e.target.value)} autoFocus />
            <div className="lz-import-list">
              {picker.filter(f => !pickerQ || f.name.toLowerCase().includes(pickerQ.toLowerCase())).map(f => {
                const done = sets.some(s => s.id === f.name)
                return (
                  <div key={f.name} className="lz-import-row">
                    <span className="lz-import-name">{f.name}</span>
                    <span className="lz-sec-n">{f.count} 图</span>
                    <button className="lz-mini-btn" disabled={busy === f.name} onClick={() => importSet(f.name)}>
                      {busy === f.name ? '导入中…' : done ? '补充导入' : '导入'}
                    </button>
                  </div>
                )
              })}
              {picker.length === 0 && <div className="lz-sec-empty">没有可导入的文件夹</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 懒狗帧 prompt 染色 tokenizer + 分类(纯函数,无 React 依赖)。
// 设计红线:
//  ① 顶层逗号切分,raw【原样保留】(含前后空白/权重/畸形)。铁律:join(parse(t).map(x=>x.raw), ',') === t 对全库 100% 成立。
//     ——因此 parse 只按半角逗号切,绝不 trim、绝不吞空块;空块(如 `,,,,`)保留成 raw='' 的 token(UI 渲染暗色小点)。
//  ② 分类【染色依据 = 该帧已存的 slots/blocks 值】,不是任何词表(除内置小质量词兜底)。归属不明=琥珀警示,帮 Owner 发现错切。
//  ③ __PRIVATE_xxx__ 占位符:norm 后仍是普通字符串,不命中任何槽→unknown,原样显示原样保存,绝不解析。

export interface Tok { raw: string }

/** 顶层逗号切分。t.split(',') 天然满足 join===t(每片 raw=原子串,join 重插逗号)。 */
export function parse(text: string): Tok[] {
  if (text === '') return []
  return text.split(',').map(raw => ({ raw }))
}

/** 重组:必须与原文逐字节相等。 */
export function join(toks: Tok[]): string {
  return toks.map(t => t.raw).join(',')
}

/** 归一化:trim → 反复剥外层 {}/[] → 剥前后 数字::/:: 权重 → 下划线转空格 → 小写 → 折叠空格。
 *  注意:只剥 {} 和 [](NAI 权重括号);() 是画师名的一部分(artist:sho(sho lwlw)),不剥。 */
export function norm(raw: string): string {
  let s = raw.trim()
  // 反复剥外层成对 {} / []
  let changed = true
  while (changed) {
    changed = false
    if (s.length >= 2 && ((s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']'))) {
      s = s.slice(1, -1).trim(); changed = true
    }
  }
  // 剥前缀 数字::(如 1.2:: / 0.6::)与裸 ::
  s = s.replace(/^-?\d*\.?\d+\s*::/, '').trim()
  s = s.replace(/^::/, '').trim()
  // 剥尾缀 ::数字 与裸 ::
  s = s.replace(/::\s*-?\d*\.?\d+\s*$/, '').trim()
  s = s.replace(/::$/, '').trim()
  // 下划线→空格,小写,折叠空格
  return s.replace(/_/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim()
}

// —— 染色分类 ——
export type SlotColorKey = 'artist' | 'character' | 'clothing' | 'scene' | 'props'
export type Category = SlotColorKey | 'skeleton' | 'quality' | 'unknown' | 'syntax'
export type Region = 'positive' | 'negative' | 'char' | 'charNeg'

/** 帧染色上下文:各槽/块值 norm 成集合。view/cast 不参与 token 染色(前者是选图元数据、后者是编号)。 */
export interface FrameCtx {
  slotSets: Record<SlotColorKey, Set<string>>
  maleSet: Set<string>
  blockSets: Record<'action' | 'expression' | 'camera' | 'effect', Set<string>>
}

const BLOCK_ZH: Record<string, string> = { action: '动作', expression: '表情', camera: '机位', effect: '效果' }

/** 把一个槽/块字符串切成 norm 后的非空词集合。extraSep:male 用 || 再切一层。 */
export function splitNorm(val: string | undefined | null, extraSep?: string): string[] {
  if (!val) return []
  let parts = String(val).split(',')
  if (extraSep) parts = parts.flatMap(p => p.split(extraSep))
  return parts.map(norm).filter(Boolean)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildCtx(slots: any, blocks: any): FrameCtx {
  return {
    slotSets: {
      artist: new Set(splitNorm(slots?.artist)),
      character: new Set(splitNorm(slots?.character)),
      clothing: new Set(splitNorm(slots?.clothing)),
      scene: new Set(splitNorm(slots?.scene)),
      props: new Set(splitNorm(slots?.props)),
    },
    maleSet: new Set(splitNorm(slots?.male, '||')),
    blockSets: {
      action: new Set(splitNorm(blocks?.action)),
      expression: new Set(splitNorm(blocks?.expression)),
      camera: new Set(splitNorm(blocks?.camera)),
      effect: new Set(splitNorm(blocks?.effect)),
    },
  }
}

const QUALITY = new Set([
  'absurdres', 'masterpiece', 'best quality', 'very aesthetic', 'no text',
  'highres', 'amazing quality', 'high quality', 'incredibly absurdres',
])
const YEAR_RE = /^year \d{4}$/

const stripArtistPfx = (s: string) => s.replace(/^artist:\s*/, '')

/** artist 槽命中:精确 norm 相等 | 双方剥 artist: 前缀后相等 | 子串包含兜底(画师串最脏)。 */
function hitArtist(n: string, set: Set<string>): boolean {
  const a = stripArtistPfx(n)
  for (const v of set) {
    if (n === v) return true
    const b = stripArtistPfx(v)
    if (a && b && a === b) return true
    // 子串兜底:仅当被比对方长度≥3,避免短词乱命中
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true
  }
  return false
}

export interface Classified {
  cat: Category
  note?: string      // skeleton 属哪块(动作/表情/机位/效果/男角);供 tooltip
  neutral?: boolean  // 负向 region 里的 unknown → 中性灰(不上琥珀警示)
}

/** token 分类。优先序见文件头 ②。region 用于负向 unknown 走中性灰。 */
export function classify(raw: string, ctx: FrameCtx, region: Region = 'positive'): Classified {
  const n = norm(raw)
  if (!n) return { cat: 'syntax' }
  // 2. 命中颜色槽(artist 特殊)
  if (hitArtist(n, ctx.slotSets.artist)) return { cat: 'artist' }
  for (const slot of ['character', 'clothing', 'scene', 'props'] as const) {
    if (ctx.slotSets[slot].has(n)) return { cat: slot }
  }
  // 3. 命中骨架块
  for (const b of ['action', 'expression', 'camera', 'effect'] as const) {
    if (ctx.blockSets[b].has(n)) return { cat: 'skeleton', note: BLOCK_ZH[b] }
  }
  // 4. 男角=骨架(换角不动)
  if (ctx.maleSet.has(n)) return { cat: 'skeleton', note: '男角' }
  // 5. 内置小质量词
  if (QUALITY.has(n) || YEAR_RE.test(n)) return { cat: 'quality' }
  // 6. 归属不明
  const isNeg = region === 'negative' || region === 'charNeg'
  return isNeg ? { cat: 'unknown', neutral: true } : { cat: 'unknown' }
}

/** 分类 → 归属的槽/块 key(用于双层同步:删/改已归槽 token 时连带改 slots.X/blocks.X)。
 *  返回 { kind:'slot'|'block', key } 或 null(quality/unknown/syntax 不落槽)。 */
export function targetOf(c: Classified): { kind: 'slot'; key: SlotColorKey | 'male' } | { kind: 'block'; key: string } | null {
  if (c.cat === 'artist' || c.cat === 'character' || c.cat === 'clothing' || c.cat === 'scene' || c.cat === 'props') {
    return { kind: 'slot', key: c.cat }
  }
  if (c.cat === 'skeleton') {
    if (c.note === '男角') return { kind: 'slot', key: 'male' }
    const zh2k: Record<string, string> = { 动作: 'action', 表情: 'expression', 机位: 'camera', 效果: 'effect' }
    const k = c.note ? zh2k[c.note] : undefined
    return k ? { kind: 'block', key: k } : null
  }
  return null
}

// ============ 分段（按槽编辑视图 · 2026-08-27 Owner 需求「直接编辑到槽」） ============
// 背景：中文 NL 帧（nl_frame）整段散文只有一个顶层 token，token 级编辑无从下手，只能整段改
//   → 改衣服得在长句里找、极易误伤别的槽。分段=把区域文本切成【带槽标签的片段】，一段一框改。
// 铁律（与 tokenizer 同级）：joinSegs(segs) === 区域原文（逐字节）。分隔符归前一段末尾、绝不 trim、
//   绝不吞空白 —— 因此分段是纯【视图】，payload 永远由片段拼回，不存在"重生成"破坏语序的风险。

export interface Seg {
  cat: Category
  note?: string   // skeleton 属哪块（动作/表情/机位/效果/男角）
  text: string    // 原文片段，含其尾部分隔符
}

const SEG_BREAK = /[,，。！？!?\n]/

/** 顶层切块：在半角/全角逗号、中文句号、叹号问号、换行【之后】断开，分隔符归前一块。
 *  join('') === text 恒成立（含空块也原样保留）。
 *  ★括号内不断块（2026-08-29）：`kyoka (summer) (princess connect!)` 的 `!` 会把角色名劈成两半，
 *  两半都匹配不上槽词 → 落 unknown → seg 路径换 AW 整段不剥（同長風套下划线坑；princess connect!
 *  系列全库 558 处）。换行强制归零 = 未闭合括号的安全阀，防一个孤立 `(` 吞掉后面整条。 */
export function splitChunks(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  let cur = ''
  let depth = 0
  for (const ch of text) {
    cur += ch
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === '\n') depth = 0
    if (SEG_BREAK.test(ch) && depth === 0) { out.push(cur); cur = '' }
  }
  if (cur) out.push(cur)
  return out
}

/** 片段分类：先走 token 规则（norm 整段精确命中槽/块）；仍 unknown 则做【槽词子串包含】兜底
 *  —— 中文长句「穿着白色透明丝袜和黑色皮鞋，」精确匹配不到，但含 slots.clothing 的词 → 判衣服。
 *  多槽同时命中取【最长匹配词】那个（越长越具体、越不像巧合）。 */
export function classifySeg(text: string, ctx: FrameCtx, region: Region = 'positive'): Classified {
  const direct = classify(text, ctx, region)
  if (direct.cat !== 'unknown' || !text.trim()) return direct
  // ★hay 必须与 norm 同源归一（下划线→空格、小写、折叠空白）：槽词是 norm 过的，
  // 拿【原文】比对会让下划线写法永远匹配不上 —— `chang_feng_(azur_lane),` 匹配不到槽里的
  // `chang feng (azur lane)` → 落 unknown → 换 AW 时整段不被剥 = 角色名留在 prompt 里（2026-08-29 实证：長風套 22/42 帧换角失效）。
  const hay = text.replace(/_/g, ' ').toLowerCase().replace(/\s+/g, ' ')
  interface Hit { cat: Category; note?: string; len: number }
  let best: Hit | null = null
  const scan = (words: Iterable<string>, cat: Category, note?: string) => {
    for (const w of words) {
      if (w.length < 2 || !hay.includes(w)) continue
      const cur: Hit = { cat, note, len: w.length }
      if (!best || cur.len > best.len) best = cur
    }
  }
  for (const slot of ['character', 'clothing', 'scene', 'props', 'artist'] as const) scan(ctx.slotSets[slot], slot)
  scan(ctx.maleSet, 'skeleton', '男角')
  const zh: Record<string, string> = { action: '动作', expression: '表情', camera: '机位', effect: '效果' }
  for (const b of ['action', 'expression', 'camera', 'effect'] as const) scan(ctx.blockSets[b], 'skeleton', zh[b])
  const hit = best as Hit | null
  return hit ? { cat: hit.cat, ...(hit.note ? { note: hit.note } : {}) } : direct
}

/** 自动分段：切块 → 逐块分类 → 相邻同类合并（减少行数，语义块更完整）。 */
export function autoSegs(text: string, ctx: FrameCtx, region: Region = 'positive'): Seg[] {
  const segs: Seg[] = []
  for (const c of splitChunks(text)) {
    const last = segs[segs.length - 1]
    // 纯空白/换行块【不独立成段】——它没有归属，独立成段只会把同一个槽的连续内容切断
    // （实证：char_caption `hair down,loli,\noppai loli,\nnear (sound voltex),` 被两个 \n 劈成 3 段角色）
    if (!c.trim() && last) { last.text += c; continue }
    const cl = classifySeg(c, ctx, region)
    if (last && last.cat === cl.cat && last.note === cl.note) last.text += c
    else segs.push({ cat: cl.cat, ...(cl.note ? { note: cl.note } : {}), text: c })
  }
  return segs
}

/** 重组：必须与区域原文逐字节相等。 */
export function joinSegs(segs: Seg[]): string {
  return segs.map(s => s.text).join('')
}

/** 分段是否仍与区域文本一致（不一致=脱节，UI 提示重新分段）。 */
export function segsMatch(segs: Seg[] | undefined, text: string): boolean {
  return Array.isArray(segs) && segs.length > 0 && joinSegs(segs) === text
}

/** 片段文本 → 槽值用的干净词（去首尾空白与分隔标点；片段本身语义保留）。 */
export function segWord(text: string): string {
  return text.replace(/^[\s,，。！？!?]+/, '').replace(/[\s,，。！？!?]+$/, '').trim()
}

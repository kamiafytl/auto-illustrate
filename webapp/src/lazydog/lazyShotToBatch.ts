// 懒狗单图/帧 slots+blocks → NAI 队列预设(NaiBatchItem 的 baseBlocks + characters)。
// 纯函数,无 React 依赖。映射严格对齐 tools/run_db_draw.py:32-64（CLI 与 webapp 同一套换 AW 语义）。
// 换 AW 的精妙:切槽已把身份切进 character 槽 → 换 AW = 不输出该槽、characters[0] 用 adult woman 顶上、
// persona 由加装层补（无需 strip 发瞳）。多女糊弄 girl，女角排第 1 槽。
import { BLOCK_ORDER, BLOCK_LABELS, type NaiPromptBlock, type NaiCharacterPrompt, type ViewKey } from '../types'
import type { LazyShot } from '../types/lazydog'

const QUALITY = 'absurdres, masterpiece, no text, best quality, very aesthetic' // 对齐 run_db_draw.py:32
const COUNT_WORD: Record<number, string> = { 1: '1girl', 2: '2girls', 3: '3girls' }

let _seq = 0
function genId(prefix: string): string {
  return `${prefix}${Date.now()}_${(_seq++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function joinNonEmpty(...parts: (string | undefined)[]): string {
  return parts.map(p => (p || '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ')
}

/** 拍扁 character 槽里的命名女角数 = franchise '(' 计数；兜底扫 blocks 里的 NgirlsTag。对齐 run_db_draw.py:37-44。
 * ★已知隐患(backlog)：服装变体括号 `kyoka (summer) (princess connect!` 会被多数一次 → 暂靠手动兜，根治按 franchise 标记计数。 */
export function nFemales(characterSlot: string, blocks: Record<string, string | undefined>): number {
  const parenCount = (characterSlot.match(/\(/g) || []).length
  const joined = characterSlot + ' ' + Object.values(blocks).filter(Boolean).join(' ')
  const m = joined.match(/\b([2-6])\s*girls?\b|\bmultiple girls\b/i)
  const fromTag = m && m[1] ? parseInt(m[1], 10) : 0
  return Math.max(1, parenCount, fromTag)
}

export interface LazyBatchPrefill {
  comment: string
  baseBlocks: NaiPromptBlock[]
  characters: NaiCharacterPrompt[]
}

/** 把一张懒狗单图/帧组装成 NAI 队列预设的预填字段（喂给 useNaiBatch.addItem）。 */
export function lazyShotToBatchItem(shot: LazyShot, opts: { swapAw: boolean }): LazyBatchPrefill {
  const sl = shot.slots || {}
  const bl = (shot.blocks || {}) as Record<string, string | undefined>
  const nf = nFemales(sl.character || '', bl)
  const countWord = COUNT_WORD[nf] || `${nf}girls`

  // 9 区块归位（保持 BLOCK_ORDER，与 NAI tab UI 一致）。
  // 角色身份一律进 characters[0]（NAI 分槽铁律 §五.6），故 character 基础块恒空；
  // 衣服/动作/表情也归 characters[0]（对齐 CLI char1），base 只留全局：画师质量/场景/镜头/特效。
  const blockText: Record<string, string> = {
    style: joinNonEmpty(QUALITY, countWord, sl.artist),
    sub_style: '',
    character: '',
    clothing: '',
    action: '',
    expression: '',
    scene: sl.scene || '',
    camera: bl.camera || '',
    effect: bl.effect || '',
  }
  const baseBlocks: NaiPromptBlock[] = BLOCK_ORDER.map(b => ({
    id: genId(`b_${b}_`),
    name: BLOCK_LABELS[b],
    text: blockText[b] || '',
    enabled: !!(blockText[b] || '').trim(),
    isPrivate: b === 'sub_style' ? true : undefined,
  }))

  // characters[0] = 女主（换 AW 或保留原角色）+ 衣服 + 动作 + 表情；多女补 girl。女角排第 1 槽（加装层 char_index=1 落此）。
  const ident = opts.swapAw ? 'adult woman' : (sl.character || 'girl')
  const char1 = joinNonEmpty(ident, sl.clothing, bl.action, bl.expression)
  // 带上挖槽时定的 slots.view → 角色加装层按"原来给的 view"选 persona 变体（Owner 需求）
  const view = (sl.view || undefined) as ViewKey | undefined
  const characters: NaiCharacterPrompt[] = [
    { id: genId('c_'), name: '女主', text: char1, enabled: true, position: { x: 0.5, y: 0.5 }, view },
  ]
  for (let i = 1; i < nf; i++) {
    characters.push({ id: genId('c_'), name: `女${i + 1}`, text: 'girl', enabled: true, position: { x: 0.5, y: 0.5 } })
  }

  const comment = shot.title || shot.source?.file || shot.id
  return { comment, baseBlocks, characters }
}

/** Prompt区块 */
export type PromptBlock =
  | 'style'
  | 'sub_style'
  | 'character'
  | 'clothing'
  | 'action'
  | 'expression'
  | 'scene'
  | 'camera'
  | 'effect'

export const BLOCK_LABELS: Record<PromptBlock, string> = {
  style: '画风质量',
  sub_style: '次画风',
  character: '角色特征',
  clothing: '衣服',
  action: '动作',
  expression: '表情',
  scene: '场景',
  camera: '镜头机位',
  effect: '特殊效果',
}

export const BLOCK_ORDER: PromptBlock[] = [
  'style',
  'sub_style',
  'character',
  'clothing',
  'action',
  'expression',
  'scene',
  'camera',
  'effect',
]

/** 视角（独立维度1）：正面 / 背面 */
export type Perspective = 'front' | 'back'

/** 构图（独立维度2）：全身 / 牛仔 / 上半身 / 中身 / 下半身 */
export type Composition = 'full' | 'cowboy' | 'upper' | 'mid' | 'lower'

/** 视角×构图 的组合 key */
export type ViewKey = `${Perspective}_${Composition}`

export const PERSPECTIVES: { id: Perspective; label: string; hint: string }[] = [
  { id: 'front', label: '正面', hint: '面向镜头' },
  { id: 'back', label: '背面', hint: '从背后看（看不到脸）' },
]

export const COMPOSITIONS: { id: Composition; label: string; hint: string }[] = [
  { id: 'full', label: '全身', hint: '完整身体（含鞋）' },
  { id: 'cowboy', label: '牛仔', hint: '大腿以上（不含鞋）' },
  { id: 'upper', label: '上半身', hint: '腰部以上' },
  { id: 'mid', label: '中身', hint: '腰部以下，不含鞋（头出框）' },
  { id: 'lower', label: '下半身', hint: '腰部以下，含鞋（完整下半身）' },
]

/** 10 个组合的完整 key 列表（迭代用） */
export const VIEW_KEYS: ViewKey[] = [
  'front_full',
  'front_cowboy',
  'front_upper',
  'front_mid',
  'front_lower',
  'back_full',
  'back_cowboy',
  'back_upper',
  'back_mid',
  'back_lower',
]

export interface PromptDoc {
  id: string
  version: 1
  title?: string
  target: 'nai'
  baseSections: PromptSection[]
  characterSections: CharacterPromptSection[]
  meta: {
    createdAt: string
    updatedAt: string
  }
}

export interface PromptSection {
  id: string
  role: 'quality' | 'artist' | 'action_scene' | 'camera' | 'effect' | 'free'
  block?: PromptBlock
  enabled: boolean
  private: boolean
  atoms: PromptAtom[]
}

export interface CharacterPromptSection {
  id: string
  name: string
  enabled: boolean
  characterId?: string
  outfitId?: string
  view: {
    perspective: Perspective
    composition: Composition
    linkedToCamera: boolean
    manuallyOverridden: boolean
  }
  position?: {
    x: number
    y: number
  }
  negativeAtoms?: PromptAtom[]
  atoms: PromptAtom[]
  relationAtoms?: PromptAtom[]
}

export type PromptAtomSource =
  | { type: 'tag'; file: string; tag: string }
  | { type: 'recipe'; file: string; id: string }
  | { type: 'character'; characterId: string; field: string }
  | { type: 'lazydog'; id: string; field: string } // 懒狗库帧/单图选入（id=LazyShot.id 或 comp id，field=blocks.xxx / slots.xxx）
  | { type: 'nai-config'; field: string } // nai_config 默认串（权威源，库页只展示不改）
  | { type: 'manual' }
  | { type: 'translation-cache' }

export interface PromptAtom {
  id: string
  kind: 'tag' | 'recipe' | 'natural' | 'raw' | 'character_trait' | 'outfit' | 'relation'
  text: string
  labelZh?: string
  weight?: {
    mode: 'nai_colon' | 'brace' | 'bracket' | 'plain'
    value: number
  }
  enabled: boolean
  private: boolean
  block?: PromptBlock
  category?: string
  source: PromptAtomSource
  editable: boolean
  dirty?: boolean
  relation?: {
    verb: string
    sourceIndex: number
    targetIndex: number
    sourceSectionId?: string
    targetSectionId?: string
  }
}

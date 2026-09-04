export type TableKey = 'recipes' | 'tags' | 'characters' | 'inspirations' | 'research'

export type DataRecord = Record<string, unknown> & {
  __file?: string
}

export type TableManifest = {
  key: TableKey
  label: string
  kind: 'dir' | 'file'
  files: string[]
  idField: string
  blockField: string | null
  editable: boolean
}

export type ManifestItem = TableManifest

export type ApiError = {
  error: string
}

export type ViewMap = Record<string, string>

export type Outfit = {
  id: string
  name: string
  preview_image?: string | null
  tags: ViewMap
  negative_text?: string
}

export type CharacterRecord = DataRecord & {
  id: string
  name: string
  preview_image?: string | null
  traits: ViewMap
  outfits: Outfit[]
  negative_text?: string
}

export type ToastState = {
  tone: 'success' | 'danger' | 'warning'
  message: string
}

export const tableOrder: TableKey[] = ['recipes', 'tags', 'characters', 'inspirations', 'research']

export const fallbackLabels: Record<TableKey, string> = {
  recipes: '配方库',
  tags: 'Tag 词典',
  characters: '角色库',
  inspirations: '灵感库',
  research: '研究课题',
}

export const recipeBlocks = [
  'style',
  'sub_style',
  'character',
  'clothing',
  'action',
  'expression',
  'scene',
  'effect',
]

export const tagBlocks = ['style', 'character', 'clothing', 'action', 'expression', 'scene', 'effect']

export const viewKeys = [
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

export const viewLabels: Record<string, string> = {
  front_full: '正面全身',
  front_cowboy: '正面牛仔',
  front_upper: '正面上半',
  front_mid: '正面中景',
  front_lower: '正面下半',
  back_full: '背面全身',
  back_cowboy: '背面牛仔',
  back_upper: '背面上半',
  back_mid: '背面中景',
  back_lower: '背面下半',
}

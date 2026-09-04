import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import { dataClient, type CharacterEntry, type PublicNaiConfig, type RecipeEntry, type TagEntry, type TagThumbIndex } from '../lib/dataClient'
import { entityThumbUrl } from '../lib/thumbs'
import { PickerModal, type PickerArea, type PickerItem, type PickerSectionConfig } from '../PickerModal'
import {
  BLOCK_LABELS,
  COMPOSITIONS,
  PERSPECTIVES,
  type CharacterPromptSection,
  type Composition,
  type Perspective,
  type PromptAtom,
  type PromptAtomSource,
  type PromptBlock,
  type PromptDoc,
  type PromptSection,
  type ViewKey,
} from '../types/prompt'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      tags: TagEntry[]
      recipes: RecipeEntry[]
      characters: CharacterEntry[]
      naiConfig: PublicNaiConfig
      imagePaths: string[]
      tagThumbs: TagThumbIndex
    }

type BaseRole = PromptSection['role']

type BaseSectionConfig = {
  role: BaseRole
  title: string
  hint: string
  blocks: PromptBlock[]
  includeTags: boolean
  includeRecipes: boolean
  pickerMode?: 'tag' | 'recipe'
}

type PaletteItem = PickerItem & {
  id: string
  kind: 'tag' | 'recipe'
  block: PromptBlock
  category: string
  title: string
  subtitle: string
  text: string
  image?: string | null
  source: PromptAtomSource
}

type CharacterPickerItem = PickerItem & {
  kind: 'character'
  character: CharacterEntry
}

type OutfitPickerItem = PickerItem & {
  kind: 'outfit'
  characterId: string
  outfit: CharacterEntry['outfits'][number]
}

type ViewVariantTexts = CharacterEntry['traits']

type PickerTarget =
  | { type: 'base'; role: BaseRole; area?: SubjectArea }
  | { type: 'character'; sectionId?: string }
  | { type: 'outfit'; sectionId: string }
  | { type: 'accessory'; sectionId: string; accessoryType: string }

const blockColors: Record<PromptBlock, string> = {
  style: '#8b5cf6',
  sub_style: '#d946ef',
  character: '#06b6d4',
  clothing: '#ec4899',
  action: '#f97316',
  expression: '#22c55e',
  scene: '#3b82f6',
  camera: '#6366f1',
  effect: '#eab308',
}

const baseSectionConfigs: BaseSectionConfig[] = [
  {
    role: 'quality',
    title: '开头质量词',
    hint: 'style tags / 默认种子',
    blocks: ['style'],
    includeTags: false,
    includeRecipes: false,
  },
  {
    role: 'artist',
    title: '画师串',
    hint: 'style recipes',
    blocks: ['style'],
    includeTags: false,
    includeRecipes: true,
    pickerMode: 'recipe',
  },
  {
    role: 'action_scene',
    title: '主体动作',
    hint: '批量出图常不变的主体核心：概念 / 动作 / 表情 / 场景 / 其他效果',
    blocks: ['action', 'expression', 'scene', 'effect'],
    includeTags: true,
    includeRecipes: true,
  },
  {
    role: 'camera',
    title: '镜头',
    hint: 'camera',
    blocks: ['camera'],
    includeTags: true,
    includeRecipes: true,
  },
]

const baseRoleOrder = baseSectionConfigs.map((section) => section.role)

type SubjectArea = PickerArea

// 概念/表情/场景/其他效果 内容少 → 挤成紧凑一行；动作内容最多 → 占满整行放最后（图4）
const subjectAreas: { id: SubjectArea; title: string; block?: PromptBlock; accent: PromptBlock }[] = [
  { id: 'concept', title: '概念', block: 'action', accent: 'sub_style' },
  { id: 'expression', title: '表情', block: 'expression', accent: 'expression' },
  { id: 'scene', title: '场景', block: 'scene', accent: 'scene' },
  { id: 'effect', title: '其他效果', block: 'effect', accent: 'effect' },
  { id: 'action', title: '动作', block: 'action', accent: 'action' },
]

// 角色配件区：四类，数据从 tags 库按 (block, 分类) 白名单取，留出选择空间
type AccessoryType = { id: string; title: string; accent: PromptBlock; cats: [PromptBlock, string][]; blocks?: PromptBlock[] }
const accessoryTypes: AccessoryType[] = [
  { id: 'prop', title: '道具', accent: 'clothing', cats: [['clothing', '杂项配件'], ['action', '手交道具']] },
  { id: 'jewelry', title: '饰品', accent: 'character', cats: [['character', '穿环改造'], ['clothing', '特殊设定']] },
  { id: 'effect', title: '效果', accent: 'effect', cats: [['clothing', '精液痕迹'], ['action', '特殊效果']] },
  { id: 'expr', title: '表情', accent: 'expression', cats: [], blocks: ['expression'] },
]
const ACCESSORY_CATEGORY_PREFIX = 'accessory:'

function accessoryMatches(type: AccessoryType, item: PaletteItem): boolean {
  if (item.kind !== 'tag') return false
  if (type.blocks?.includes(item.block)) return true
  return type.cats.some(([block, category]) => item.block === block && item.category === category)
}

function isAccessoryAtom(atom: PromptAtom): boolean {
  return Boolean(atom.category?.startsWith(ACCESSORY_CATEGORY_PREFIX))
}

const defaultView = {
  perspective: 'front' as Perspective,
  composition: 'full' as Composition,
}

// TODO: 从基础区“镜头”胶囊解析 perspective/composition 后更新 cameraView。
const gridPositions = [0.1, 0.3, 0.5, 0.7, 0.9]

function isPromptBlock(value: string): value is PromptBlock {
  return Object.prototype.hasOwnProperty.call(BLOCK_LABELS, value)
}

function blockColor(block?: PromptBlock): string {
  return block ? blockColors[block] : '#64748b'
}

function blockLabel(block: PromptBlock): string {
  return BLOCK_LABELS[block]
}

function dataImageUrl(path: string | null | undefined): string | null {
  if (!path) return null
  const cleaned = path.replace(/^\/+/, '').replace(/^data\/+/, '')
  if (!cleaned) return null
  return `/api/data/image?path=${encodeURIComponent(cleaned)}`
}

function inputKey(role: BaseRole, area?: SubjectArea): string {
  return area ? `${role}:${area}` : role
}

function baseSectionAccent(role: BaseRole): string {
  if (role === 'quality') return '#14b8a6'
  if (role === 'artist') return '#ec4899'
  if (role === 'action_scene') return '#f97316'
  if (role === 'camera') return '#6366f1'
  return '#38bdf8'
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeText(value: string): string {
  return value.trim().replace(/,+$/g, '').trim()
}

function dedupeTexts(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizeText(value)
    if (!normalized) continue
    const key = normalized.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function getViewText(v: ViewVariantTexts | undefined, perspective: Perspective, composition: Composition): string {
  if (!v) return ''
  const key = `${perspective}_${composition}` as ViewKey
  if (v[key]) return v[key] as string
  if (composition === 'lower') {
    const midKey = `${perspective}_mid` as ViewKey
    if (v[midKey]) return v[midKey] as string
  }
  if (composition === 'mid') {
    const lowerKey = `${perspective}_lower` as ViewKey
    if (v[lowerKey]) return v[lowerKey] as string
  }
  if (perspective === 'back' && v.back_full) return v.back_full
  const frontKey = `front_${composition}` as ViewKey
  if (v[frontKey]) return v[frontKey] as string
  return v.front_full || ''
}

function formatWeight(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))
}

function formatWeightInput(value: number): string {
  return value.toFixed(2).replace(/0$/, '')
}

function atomPrompt(atom: PromptAtom): string {
  const text = normalizeText(atom.text)
  if (!atom.enabled || !text) return ''
  if (atom.weight?.mode === 'nai_colon' && atom.weight.value !== 1) {
    return `${formatWeight(atom.weight.value)}::${text}::`
  }
  return text
}

function buildPrompt(sections: PromptSection[]): string {
  return sections
    .filter((section) => section.enabled && baseRoleOrder.includes(section.role))
    .flatMap((section) => section.atoms.map(atomPrompt))
    .filter(Boolean)
    .join(', ')
}

function positionPrompt(section: CharacterPromptSection): string {
  const position = section.position ?? { x: 0.5, y: 0.5 }
  return `position(${position.x.toFixed(1)},${position.y.toFixed(1)})`
}

function relationPrompt(atom: PromptAtom): string {
  const text = normalizeText(atom.text)
  if (!atom.enabled || !text) return ''
  if (atom.category === 'source') return `source#${text}`
  if (atom.category === 'target') return `target#${text}`
  return text
}

function buildCharacterSegment(section: CharacterPromptSection, index: number): string {
  if (!section.enabled) return ''
  const positive = section.atoms.map(atomPrompt).filter(Boolean)
  const relations = (section.relationAtoms ?? []).map(relationPrompt).filter(Boolean)
  const negatives = (section.negativeAtoms ?? []).map(atomPrompt).filter(Boolean)
  const caption = [...positive, positionPrompt(section), ...relations].filter(Boolean).join(', ')
  if (!caption) return ''
  const negative = negatives.length > 0 ? ` | 角色负面: ${negatives.join(', ')}` : ''
  return `char_index ${index + 1} / ${section.name || '未命名角色'}: ${caption}${negative}`
}

function buildFullPrompt(baseSections: PromptSection[], characterSections: CharacterPromptSection[]): string {
  const base = buildPrompt(baseSections)
  const characters = characterSections.map(buildCharacterSegment).filter(Boolean)
  return [base, ...characters].filter(Boolean).join('\n\n')
}

function countPromptWords(prompt: string): number {
  return prompt
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean).length
}

function parseWeightedToken(token: string): { text: string; weight?: PromptAtom['weight'] } {
  const match = token.trim().match(/^([+-]?\d+(?:\.\d+)?)::([\s\S]+)::$/)
  if (!match) return { text: normalizeText(token) }
  return {
    text: normalizeText(match[2]),
    weight: { mode: 'nai_colon', value: Number(match[1]) },
  }
}

function splitPromptList(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let round = 0
  let square = 0
  let curly = 0
  let quote: '"' | "'" | null = null
  let inColonWeight = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (quote) {
      current += char
      if (char === quote && input[index - 1] !== '\\') quote = null
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === ':' && next === ':') {
      const before = current.trim()
      if (inColonWeight) {
        inColonWeight = false
      } else if (/^[+-]?\d+(?:\.\d+)?$/.test(before) || /^[A-Za-z][\w.-]*$/.test(before)) {
        inColonWeight = true
      }
      current += '::'
      index += 1
      continue
    }

    if (!inColonWeight) {
      if (char === '(') round += 1
      if (char === ')' && round > 0) round -= 1
      if (char === '[') square += 1
      if (char === ']' && square > 0) square -= 1
      if (char === '{') curly += 1
      if (char === '}' && curly > 0) curly -= 1
    }

    if (char === ',' && !inColonWeight && round === 0 && square === 0 && curly === 0) {
      const item = normalizeText(current)
      if (item) parts.push(item)
      current = ''
      continue
    }

    current += char
  }

  const last = normalizeText(current)
  if (last) parts.push(last)
  return parts
}

function makeManualAtom(text: string, block?: PromptBlock, kind: PromptAtom['kind'] = 'raw', category?: string): PromptAtom {
  const parsed = parseWeightedToken(text)
  return {
    id: uid('atom'),
    kind,
    text: parsed.text,
    weight: parsed.weight,
    enabled: true,
    private: false,
    block,
    category,
    source: { type: 'manual' },
    editable: true,
    dirty: true,
  }
}

function makeCharacterAtom(text: string, characterId: string, field: string, kind: 'character_trait' | 'outfit', block: PromptBlock): PromptAtom {
  const parsed = parseWeightedToken(text)
  return {
    id: uid('atom'),
    kind,
    text: parsed.text,
    weight: parsed.weight,
    enabled: true,
    private: false,
    block,
    source: { type: 'character', characterId, field },
    editable: true,
  }
}

function makeRelationAtom(text: string, sourceIndex: number, targetIndex: number, sourceSectionId: string, targetSectionId: string): PromptAtom {
  const verb = normalizeText(text)
  return {
    id: uid('relation'),
    kind: 'relation',
    text: verb,
    enabled: true,
    private: false,
    category: 'relation',
    source: { type: 'manual' },
    editable: true,
    dirty: true,
    relation: {
      verb,
      sourceIndex,
      targetIndex,
      sourceSectionId,
      targetSectionId,
    },
  }
}

function buildCharacterAtoms(character: CharacterEntry, outfit: CharacterEntry['outfits'][number] | undefined, perspective: Perspective, composition: Composition): PromptAtom[] {
  const traitText = normalizeText(getViewText(character.traits, perspective, composition))
  const outfitText = normalizeText(getViewText(outfit?.tags, perspective, composition))
  // 与基础提示词一致：按逗号拆成一个个可单独编辑的胶囊，而不是一大坨 blob（图2/图3 原则）
  const traitAtoms = splitPromptList(traitText).map((part) => makeCharacterAtom(part, character.id, 'traits', 'character_trait', 'character'))
  const outfitAtoms = outfit
    ? splitPromptList(outfitText).map((part) => makeCharacterAtom(part, character.id, `outfit:${outfit.id}`, 'outfit', 'clothing'))
    : []
  return [...traitAtoms, ...outfitAtoms]
}

// 视角/换衣服/跟随镜头时重建「角色 trait + 衣服」胶囊，但保留用户额外加的配件(accessory:*)、
// 自然语言补充、手写胶囊——否则切个视角就把配件/补充全抹了(数据丢失)。
function rebuildViewAtoms(
  prevAtoms: PromptAtom[],
  character: CharacterEntry,
  outfit: CharacterEntry['outfits'][number] | undefined,
  perspective: Perspective,
  composition: Composition,
): PromptAtom[] {
  const preserved = prevAtoms.filter(
    (atom) => !(atom.source?.type === 'character' && (atom.kind === 'character_trait' || atom.kind === 'outfit')),
  )
  return [...buildCharacterAtoms(character, outfit, perspective, composition), ...preserved]
}

function buildNegativeAtoms(character: CharacterEntry, outfit: CharacterEntry['outfits'][number] | undefined): PromptAtom[] {
  const parts = dedupeTexts([character.negative_text ?? '', outfit?.negative_text ?? ''].flatMap(splitPromptList))
  return parts.map((part) => makeCharacterAtom(part, character.id, outfit ? `negative:${outfit.id}` : 'negative', 'character_trait', 'effect'))
}

function subjectAreaForAtom(atom: PromptAtom): SubjectArea {
  if (atom.category && (atom.category.includes('概念') || /concept/i.test(atom.category))) return 'concept'
  if (atom.block === 'expression') return 'expression'
  if (atom.block === 'scene') return 'scene'
  if (atom.block === 'effect') return 'effect'
  return 'action'
}

function makePaletteAtom(item: PaletteItem): PromptAtom {
  const parsed = parseWeightedToken(item.text)
  return {
    id: uid('atom'),
    kind: item.kind,
    text: parsed.text,
    labelZh: item.kind === 'tag' ? item.subtitle || undefined : undefined,
    weight: parsed.weight,
    enabled: true,
    private: false,
    block: item.block,
    category: item.category,
    source: item.source,
    editable: true,
  }
}

function toPaletteItems(tags: TagEntry[], recipes: RecipeEntry[]): PaletteItem[] {
  return [
    ...tags.flatMap((tag, index): PaletteItem[] => {
      const block = String(tag.block)
      if (!isPromptBlock(block)) return []
      return [
        {
          id: `tag:${tag.tag}:${index}`,
          kind: 'tag',
          block,
          category: tag.category || '未分类',
          title: tag.tag,
          subtitle: tag.name_zh,
          text: tag.tag,
          source: { type: 'tag', file: 'tags', tag: tag.tag },
        },
      ]
    }),
    ...recipes.flatMap((recipe): PaletteItem[] => {
      const block = String(recipe.block)
      if (!isPromptBlock(block)) return []
      return [
        {
          id: `recipe:${recipe.id}`,
          kind: 'recipe',
          block,
          category: recipe.category || recipe.group || '未分类',
          title: recipe.name || recipe.id,
          subtitle: recipe.tags,
          text: recipe.tags,
          image: recipe.image,
          source: { type: 'recipe', file: 'recipes', id: recipe.id },
        },
      ]
    }),
  ]
}

function toCharacterPickerItems(characters: CharacterEntry[]): CharacterPickerItem[] {
  return characters.map((character): CharacterPickerItem => ({
    id: `character:${character.id}`,
    kind: 'character',
    block: 'character',
    category: '角色',
    title: character.name,
    subtitle: `${character.outfits.length} 套衣服`,
    text: character.name,
    // preview_image 多为空 → 回退旧命名约定，让选择器卡片也有缩略图
    image: character.preview_image || `images/char--${character.id}_full.webp`,
    character,
  }))
}

function toOutfitPickerItems(character: CharacterEntry | undefined): OutfitPickerItem[] {
  if (!character) return []
  return character.outfits.map((outfit): OutfitPickerItem => ({
    id: `outfit:${character.id}:${outfit.id}`,
    kind: 'outfit',
    block: 'clothing',
    category: character.name,
    title: outfit.name,
    subtitle: outfit.note ?? '',
    text: outfit.name,
    image: outfit.preview_image || `images/outfit--${outfit.id}_full.webp`,
    characterId: character.id,
    outfit,
  }))
}

function paletteForSection(section: BaseSectionConfig, items: PaletteItem[]): PaletteItem[] {
  return items.filter((item) => {
    if (!section.blocks.includes(item.block)) return false
    if (item.kind === 'tag' && !section.includeTags) return false
    if (item.kind === 'recipe' && !section.includeRecipes) return false
    return true
  })
}

function extractDefaultQualityAtoms(config: PublicNaiConfig): PromptAtom[] {
  const fallback = 'masterpiece, best quality, very aesthetic'
  if (!Array.isArray(config.default_base_blocks)) {
    return splitPromptList(fallback).map((part) => makeManualAtom(part, 'style', 'tag'))
  }
  const qualityBlock = config.default_base_blocks.find((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const record = entry as Record<string, unknown>
    return record.name === '画风质量'
  })
  if (!qualityBlock || typeof qualityBlock !== 'object') {
    return splitPromptList(fallback).map((part) => makeManualAtom(part, 'style', 'tag'))
  }

  const text = (qualityBlock as Record<string, unknown>).text
  if (typeof text !== 'string' || !normalizeText(text)) {
    return splitPromptList(fallback).map((part) => makeManualAtom(part, 'style', 'tag'))
  }

  return splitPromptList(text).map((part) => makeManualAtom(part, 'style', 'tag'))
}

function updateSection(
  doc: PromptDoc,
  role: BaseRole,
  updater: (section: PromptSection) => PromptSection,
): PromptDoc {
  return {
    ...doc,
    baseSections: doc.baseSections.map((section) => (section.role === role ? updater(section) : section)),
    meta: {
      ...doc.meta,
      updatedAt: new Date().toISOString(),
    },
  }
}

function refreshRelationIndexes(sections: CharacterPromptSection[]): CharacterPromptSection[] {
  const indexById = new Map(sections.map((section, index) => [section.id, index + 1]))
  return sections.map((section) => ({
    ...section,
    relationAtoms: (section.relationAtoms ?? [])
      .filter((atom) => {
        if (!atom.relation?.sourceSectionId || !atom.relation.targetSectionId) return true
        return indexById.has(atom.relation.sourceSectionId) && indexById.has(atom.relation.targetSectionId)
      })
      .map((atom) => {
        if (!atom.relation?.sourceSectionId || !atom.relation.targetSectionId) return atom
        return {
          ...atom,
          relation: {
            ...atom.relation,
            sourceIndex: indexById.get(atom.relation.sourceSectionId) ?? atom.relation.sourceIndex,
            targetIndex: indexById.get(atom.relation.targetSectionId) ?? atom.relation.targetIndex,
          },
        }
      }),
  }))
}

type PromptEditorProps = {
  state: LoadState
  doc: PromptDoc
  setDoc: Dispatch<SetStateAction<PromptDoc>>
}

export function PromptEditor({ state, doc, setDoc }: PromptEditorProps) {
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null)
  const [editingAtomId, setEditingAtomId] = useState<string | null>(null)
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({})
  const [naturalInputs, setNaturalInputs] = useState<Record<string, string>>({})
  const [negativeInputs, setNegativeInputs] = useState<Record<string, string>>({})
  const [cameraView, setCameraView] = useState(defaultView)
  const [collapsedNegatives, setCollapsedNegatives] = useState<Record<string, boolean>>({})
  const [relationInput, setRelationInput] = useState({ sourceId: '', targetId: '', text: '' })
  const [translating, setTranslating] = useState(false)
  const translateRequestedRef = useRef<Set<string>>(new Set())

  const paletteItems = useMemo(() => {
    if (state.status !== 'ready') return []
    return toPaletteItems(state.tags, state.recipes)
  }, [state])

  const characterPickerItems = useMemo(() => (state.status === 'ready' ? toCharacterPickerItems(state.characters) : []), [state])
  const prompt = useMemo(() => buildFullPrompt(doc.baseSections, doc.characterSections), [doc.baseSections, doc.characterSections])
  const basePrompt = useMemo(() => buildPrompt(doc.baseSections), [doc.baseSections])
  const characterCaptions = useMemo(() => doc.characterSections.map(buildCharacterSegment).filter(Boolean), [doc.characterSections])
  const promptWordCount = useMemo(() => countPromptWords(prompt), [prompt])
  const activePaletteConfig = pickerTarget?.type === 'base' ? (baseSectionConfigs.find((section) => section.role === pickerTarget.role) ?? null) : null
  const activePaletteArea = pickerTarget?.type === 'base' ? pickerTarget.area : undefined
  const activePaletteItems = useMemo(() => {
    if (!activePaletteConfig) return []
    return paletteForSection(activePaletteConfig, paletteItems)
  }, [activePaletteConfig, paletteItems])
  const activeOutfitSection = pickerTarget?.type === 'outfit' ? doc.characterSections.find((section) => section.id === pickerTarget.sectionId) : null
  const activeOutfitCharacter =
    state.status === 'ready' && activeOutfitSection?.characterId ? state.characters.find((character) => character.id === activeOutfitSection.characterId) : undefined
  const activeOutfitItems = useMemo(() => toOutfitPickerItems(activeOutfitCharacter), [activeOutfitCharacter])
  const activeAccessoryType = pickerTarget?.type === 'accessory' ? accessoryTypes.find((type) => type.id === pickerTarget.accessoryType) : undefined
  const activeAccessoryItems = useMemo(() => {
    if (!activeAccessoryType) return []
    return paletteItems.filter((item) => accessoryMatches(activeAccessoryType, item))
  }, [activeAccessoryType, paletteItems])
  const pickerBlockMeta = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(blockColors).map((block) => [block, { label: blockLabel(block as PromptBlock), color: blockColor(block as PromptBlock) }]),
      ) as Record<PromptBlock, { label: string; color: string }>,
    [],
  )

  useEffect(() => {
    if (state.status !== 'ready') return
    setDoc((current) => ({
      ...current,
      characterSections: current.characterSections.map((section) => {
        if (!section.view.linkedToCamera || section.view.manuallyOverridden) return section
        const character = state.characters.find((item) => item.id === section.characterId)
        const outfit = character?.outfits.find((item) => item.id === section.outfitId)
        return {
          ...section,
          view: {
            ...section.view,
            perspective: cameraView.perspective,
            composition: cameraView.composition,
          },
          atoms: character ? rebuildViewAtoms(section.atoms, character, outfit, cameraView.perspective, cameraView.composition) : section.atoms,
        }
      }),
      meta: {
        ...current.meta,
        updatedAt: new Date().toISOString(),
      },
    }))
  }, [cameraView, state])

  // 自动翻译：收集英文、无 labelZh、非自然语言段的胶囊 → 防抖批量请求 → 回填 labelZh。
  // 离线优先在调用方已做(name_zh 即 labelZh)；这里只补缺，服务端再走缓存>API。
  useEffect(() => {
    const hasCjk = (value: string) => /[一-鿿]/.test(value)
    const pending = new Set<string>()
    const collect = (atoms: PromptAtom[]) => {
      for (const atom of atoms) {
        if (atom.kind === 'natural' || atom.labelZh) continue
        // 隐私红线：私有 atom / __PRIVATE 占位符绝不送翻译端点
        if (atom.private || atom.text.includes('__PRIVATE')) continue
        const text = atom.text.trim()
        if (!text || hasCjk(text) || !/[a-zA-Z]/.test(text)) continue
        if (translateRequestedRef.current.has(text.toLocaleLowerCase())) continue
        pending.add(text)
      }
    }
    doc.baseSections.forEach((section) => collect(section.atoms))
    doc.characterSections.forEach((section) => {
      collect(section.atoms)
      if (section.negativeAtoms) collect(section.negativeAtoms)
    })

    const texts = Array.from(pending)
    if (texts.length === 0) return
    const handle = window.setTimeout(async () => {
      texts.forEach((text) => translateRequestedRef.current.add(text.toLocaleLowerCase()))
      setTranslating(true)
      try {
        const result = await dataClient.translateTexts(texts)
        const map = result.translations
        if (Object.keys(map).length === 0) return
        const patch = (atoms: PromptAtom[]) => atoms.map((atom) => (!atom.labelZh && map[atom.text.trim()] ? { ...atom, labelZh: map[atom.text.trim()] } : atom))
        setDoc((current) => ({
          ...current,
          baseSections: current.baseSections.map((section) => ({ ...section, atoms: patch(section.atoms) })),
          characterSections: current.characterSections.map((section) => ({
            ...section,
            atoms: patch(section.atoms),
            negativeAtoms: section.negativeAtoms ? patch(section.negativeAtoms) : section.negativeAtoms,
          })),
        }))
      } finally {
        setTranslating(false)
      }
    }, 700)
    return () => window.clearTimeout(handle)
  }, [doc.baseSections, doc.characterSections, setDoc])

  function appendAtoms(role: BaseRole, atoms: PromptAtom[]): void {
    if (atoms.length === 0) return
    setDoc((current) =>
      updateSection(current, role, (section) => ({
        ...section,
        atoms: [...section.atoms, ...atoms],
      })),
    )
  }

  function removeAtom(role: BaseRole, atomId: string): void {
    setEditingAtomId((current) => (current === atomId ? null : current))
    setDoc((current) =>
      updateSection(current, role, (section) => ({
        ...section,
        atoms: section.atoms.filter((atom) => atom.id !== atomId),
      })),
    )
  }

  function patchAtom(role: BaseRole, atomId: string, patch: Partial<PromptAtom>): void {
    setDoc((current) =>
      updateSection(current, role, (section) => ({
        ...section,
        atoms: section.atoms.map((atom) => (atom.id === atomId ? { ...atom, ...patch, dirty: true } : atom)),
      })),
    )
  }

  function addManual(role: BaseRole, block?: PromptBlock, area?: SubjectArea): void {
    const key = inputKey(role, area)
    const value = manualInputs[key] ?? ''
    const category = role === 'action_scene' && area === 'concept' ? '概念' : undefined
    const atoms = splitPromptList(value).map((part) => makeManualAtom(part, block, 'raw', category))
    appendAtoms(role, atoms)
    if (atoms.length > 0) {
      setManualInputs((current) => ({ ...current, [key]: '' }))
    }
  }

  function addNatural(role: BaseRole, block?: PromptBlock, area?: SubjectArea): void {
    const key = inputKey(role, area)
    const value = normalizeText(naturalInputs[key] ?? '')
    if (!value) return
    const category = role === 'action_scene' && area === 'concept' ? '概念' : undefined
    appendAtoms(role, [makeManualAtom(value, block, 'natural', category)])
    setNaturalInputs((current) => ({ ...current, [key]: '' }))
  }

  function seedQuality(): void {
    if (state.status !== 'ready') return
    appendAtoms('quality', extractDefaultQualityAtoms(state.naiConfig))
  }

  function copyPrompt(): void {
    void navigator.clipboard?.writeText(prompt)
  }

  function openPalette(role: BaseRole, area?: SubjectArea): void {
    setPickerTarget({ type: 'base', role, area })
  }

  function addPaletteItem(role: BaseRole, item: PaletteItem): void {
    const atoms = splitPromptList(item.text).map((part) => makePaletteAtom({ ...item, text: part }))
    if (atoms.length === 0) return
    const config = baseSectionConfigs.find((section) => section.role === role)
    if (config?.pickerMode === 'recipe') {
      // 画师串等 recipe 单选：替换本区原子，避免多选叠加（单选语义）
      setDoc((current) => updateSection(current, role, (section) => ({ ...section, atoms })))
      return
    }
    appendAtoms(role, atoms)
  }

  function updateCharacterSection(sectionId: string, updater: (section: CharacterPromptSection) => CharacterPromptSection): void {
    setDoc((current) => ({
      ...current,
      characterSections: current.characterSections.map((section) => (section.id === sectionId ? updater(section) : section)),
      meta: {
        ...current.meta,
        updatedAt: new Date().toISOString(),
      },
    }))
  }

  function makeEmptyCharacterSection(index: number, patch: Partial<CharacterPromptSection> = {}): CharacterPromptSection {
    const id = uid('character')
    return {
      id,
      name: `角色 ${index + 1}`,
      enabled: true,
      view: {
        perspective: cameraView.perspective,
        composition: cameraView.composition,
        linkedToCamera: true,
        manuallyOverridden: false,
      },
      position: { x: 0.5, y: 0.5 },
      atoms: [],
      negativeAtoms: [],
      relationAtoms: [],
      ...patch,
    }
  }

  function addEmptyCharacterSection(): void {
    setDoc((current) => ({
      ...current,
      characterSections: [...current.characterSections, makeEmptyCharacterSection(current.characterSections.length)],
      meta: {
        ...current.meta,
        updatedAt: new Date().toISOString(),
      },
    }))
  }

  function addCharacterSection(): void {
    setPickerTarget({ type: 'character' })
  }

  function addCharacterFromLibrary(character: CharacterEntry): void {
    const outfit = character.outfits.find((item) => item.id === character.default_outfit) ?? character.outfits[0]
    setDoc((current) => {
      const nextSection = makeEmptyCharacterSection(current.characterSections.length, {
        name: character.name,
        characterId: character.id,
        outfitId: outfit?.id,
        atoms: buildCharacterAtoms(character, outfit, cameraView.perspective, cameraView.composition),
        negativeAtoms: buildNegativeAtoms(character, outfit),
      })
      return {
        ...current,
        characterSections: [...current.characterSections, nextSection],
        meta: {
          ...current.meta,
          updatedAt: new Date().toISOString(),
        },
      }
    })
    setPickerTarget(null)
  }

  function removeCharacterSection(sectionId: string): void {
    setDoc((current) => ({
      ...current,
      characterSections: refreshRelationIndexes(current.characterSections.filter((section) => section.id !== sectionId)),
      meta: {
        ...current.meta,
        updatedAt: new Date().toISOString(),
      },
    }))
    setCollapsedNegatives((current) => {
      const next = { ...current }
      delete next[sectionId]
      return next
    })
    setNaturalInputs((current) => {
      const next = { ...current }
      delete next[sectionId]
      return next
    })
    setNegativeInputs((current) => {
      const next = { ...current }
      delete next[sectionId]
      return next
    })
  }

  function selectCharacter(sectionId: string, character: CharacterEntry): void {
    const outfit = character.outfits.find((item) => item.id === character.default_outfit) ?? character.outfits[0]
    updateCharacterSection(sectionId, (section) => ({
      ...section,
      name: character.name,
      characterId: character.id,
      outfitId: outfit?.id,
      atoms: buildCharacterAtoms(character, outfit, section.view.perspective, section.view.composition),
      negativeAtoms: buildNegativeAtoms(character, outfit),
    }))
    setPickerTarget(null)
  }

  function moveCharacterSection(sectionId: string, direction: -1 | 1): void {
    setDoc((current) => {
      const index = current.characterSections.findIndex((section) => section.id === sectionId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= current.characterSections.length) return current
      const nextSections = [...current.characterSections]
      const [moved] = nextSections.splice(index, 1)
      nextSections.splice(nextIndex, 0, moved)
      return {
        ...current,
        characterSections: refreshRelationIndexes(nextSections),
        meta: {
          ...current.meta,
          updatedAt: new Date().toISOString(),
        },
      }
    })
  }

  function selectOutfit(sectionId: string, outfit: CharacterEntry['outfits'][number]): void {
    if (state.status !== 'ready') return
    updateCharacterSection(sectionId, (section) => {
      const character = state.characters.find((item) => item.id === section.characterId)
      if (!character) return section
      return {
        ...section,
        outfitId: outfit.id,
        atoms: rebuildViewAtoms(section.atoms, character, outfit, section.view.perspective, section.view.composition),
        negativeAtoms: buildNegativeAtoms(character, outfit),
      }
    })
    setPickerTarget(null)
  }

  function addAccessoryItem(sectionId: string, accessoryType: string, item: PaletteItem): void {
    const parts = splitPromptList(item.text)
    if (parts.length === 0) return
    updateCharacterSection(sectionId, (section) => ({
      ...section,
      // 配件用 category 前缀标记，便于按类归集；block 保留来源块用于配色/拼接
      atoms: [...section.atoms, ...parts.map((part) => ({ ...makePaletteAtom({ ...item, text: part }), category: `${ACCESSORY_CATEGORY_PREFIX}${accessoryType}` }))],
    }))
  }

  function setCharacterView(sectionId: string, patch: Partial<{ perspective: Perspective; composition: Composition }>, manual: boolean): void {
    if (state.status !== 'ready') return
    updateCharacterSection(sectionId, (section) => {
      const nextView = {
        ...section.view,
        ...patch,
        manuallyOverridden: manual ? true : section.view.manuallyOverridden,
      }
      const character = state.characters.find((item) => item.id === section.characterId)
      const outfit = character?.outfits.find((item) => item.id === section.outfitId)
      return {
        ...section,
        view: nextView,
        atoms: character ? rebuildViewAtoms(section.atoms, character, outfit, nextView.perspective, nextView.composition) : section.atoms,
      }
    })
  }

  function relinkCharacterToCamera(sectionId: string): void {
    if (state.status !== 'ready') return
    updateCharacterSection(sectionId, (section) => {
      const character = state.characters.find((item) => item.id === section.characterId)
      const outfit = character?.outfits.find((item) => item.id === section.outfitId)
      return {
        ...section,
        view: {
          perspective: cameraView.perspective,
          composition: cameraView.composition,
          linkedToCamera: true,
          manuallyOverridden: false,
        },
        atoms: character ? rebuildViewAtoms(section.atoms, character, outfit, cameraView.perspective, cameraView.composition) : section.atoms,
      }
    })
  }

  function patchCharacterAtom(sectionId: string, atomId: string, patch: Partial<PromptAtom>, bucket: 'atoms' | 'negativeAtoms' | 'relationAtoms' = 'atoms'): void {
    updateCharacterSection(sectionId, (section) => ({
      ...section,
      [bucket]: (section[bucket] ?? []).map((atom) => (atom.id === atomId ? { ...atom, ...patch, dirty: true } : atom)),
    }))
  }

  function removeCharacterAtom(sectionId: string, atomId: string, bucket: 'atoms' | 'negativeAtoms' | 'relationAtoms' = 'atoms'): void {
    setEditingAtomId((current) => (current === atomId ? null : current))
    updateCharacterSection(sectionId, (section) => ({
      ...section,
      [bucket]: (section[bucket] ?? []).filter((atom) => atom.id !== atomId),
    }))
  }

  function addCharacterNatural(sectionId: string): void {
    const value = normalizeText(naturalInputs[sectionId] ?? '')
    if (!value) return
    updateCharacterSection(sectionId, (section) => ({
      ...section,
      atoms: [...section.atoms, makeManualAtom(value, 'character', 'natural')],
    }))
    setNaturalInputs((current) => ({ ...current, [sectionId]: '' }))
  }

  function addCharacterNegative(sectionId: string): void {
    const value = negativeInputs[sectionId] ?? ''
    const atoms = splitPromptList(value).map((part) => makeManualAtom(part, 'effect', 'raw'))
    if (atoms.length === 0) return
    updateCharacterSection(sectionId, (section) => ({
      ...section,
      negativeAtoms: [...(section.negativeAtoms ?? []), ...atoms],
    }))
    setNegativeInputs((current) => ({ ...current, [sectionId]: '' }))
    setCollapsedNegatives((current) => ({ ...current, [sectionId]: false }))
  }

  function addRelation(): void {
    const text = normalizeText(relationInput.text)
    if (!relationInput.sourceId || !relationInput.targetId || !text || relationInput.sourceId === relationInput.targetId) return
    setDoc((current) => ({
      ...current,
      characterSections: current.characterSections.map((section) => {
        const sourceIndex = current.characterSections.findIndex((item) => item.id === relationInput.sourceId) + 1
        const targetIndex = current.characterSections.findIndex((item) => item.id === relationInput.targetId) + 1
        const atom = makeRelationAtom(text, sourceIndex, targetIndex, relationInput.sourceId, relationInput.targetId)
        if (section.id === relationInput.sourceId) {
          return { ...section, relationAtoms: [...(section.relationAtoms ?? []), atom] }
        }
        if (section.id === relationInput.targetId) {
          return { ...section, relationAtoms: [...(section.relationAtoms ?? []), { ...atom, id: uid('relation') }] }
        }
        return section
      }),
      meta: {
        ...current.meta,
        updatedAt: new Date().toISOString(),
      },
    }))
    setRelationInput((current) => ({ ...current, text: '' }))
  }

  function thumbnailForAtom(atom: PromptAtom): string | null {
    if (atom.source.type === 'recipe') {
      const recipeId = atom.source.id
      const item = paletteItems.find((paletteItem) => paletteItem.kind === 'recipe' && paletteItem.source.type === 'recipe' && paletteItem.source.id === recipeId)
      return dataImageUrl(item?.image)
    }
    if (atom.source.type === 'character' && state.status === 'ready') {
      const source = atom.source
      const character = state.characters.find((item) => item.id === source.characterId)
      if (atom.kind === 'outfit') {
        const outfitId = source.field.startsWith('outfit:') ? source.field.slice('outfit:'.length) : ''
        const outfit = character?.outfits.find((item) => item.id === outfitId)
        return dataImageUrl(outfit?.preview_image ?? character?.preview_image)
      }
      return dataImageUrl(character?.preview_image)
    }
    return null
  }

  if (state.status === 'loading') {
    return <div className="page-state">加载数据...</div>
  }

  if (state.status === 'error') {
    return <div className="page-state error">数据加载失败：{state.message}</div>
  }

  return (
    <div className="prompt-editor">
      {translating && (
        <div className="translate-status" role="status">
          翻译中…
        </div>
      )}
      <div className="workspace">
        <section className="editor-panel" aria-label="基础区编辑器">
          {baseSectionConfigs.map((config) => {
            const section = doc.baseSections.find((item) => item.role === config.role)
            if (!section) return null
            const manualKey = inputKey(config.role)
            const naturalKey = inputKey(config.role)
            const manualValue = manualInputs[manualKey] ?? ''
            const naturalValue = naturalInputs[naturalKey] ?? ''
            const activeBlock = config.blocks[0]

            return (
              <section
                className={`base-section base-section-${config.role} ${config.role === 'action_scene' ? 'is-primary' : ''}`}
                key={config.role}
                style={{ '--section-accent': baseSectionAccent(config.role) } as CSSProperties}
              >
                <header className="section-head">
                  <div>
                    <h2>{config.title}</h2>
                    <p>{config.hint}</p>
                  </div>
                  <div className="section-actions">
                    {config.role === 'quality' && (
                      <button className="ghost-button" type="button" onClick={seedQuality}>
                        默认种子
                      </button>
                    )}
                    {(config.includeTags || config.includeRecipes) && (
                      <button
                        className="add-button"
                        type="button"
                        aria-label={`添加${config.title}`}
                        title="打开调色板"
                        onClick={() => openPalette(config.role)}
                      >
                        <span>+</span>
                        添加
                      </button>
                    )}
                  </div>
                </header>

                {config.role === 'action_scene' ? (
                  <div className="subject-area-grid">
                    {subjectAreas.map((area) => {
                      const areaAtoms = section.atoms.filter((atom) => subjectAreaForAtom(atom) === area.id)
                      const areaManualKey = inputKey(config.role, area.id)
                      const areaNaturalKey = inputKey(config.role, area.id)
                      const areaManualValue = manualInputs[areaManualKey] ?? ''
                      const areaNaturalValue = naturalInputs[areaNaturalKey] ?? ''
                      return (
                        <section
                          className={`subject-area-card ${area.id === 'action' ? 'is-primary-area' : ''}`}
                          key={area.id}
                          style={{ '--area-accent': blockColor(area.accent) } as CSSProperties}
                        >
                          <header className="subject-area-head">
                            <div>
                              <h3>{area.title}</h3>
                              <p>{areaAtoms.length} 个胶囊</p>
                            </div>
                            <button className="chip-add-tile" type="button" aria-label={`添加${area.title}`} onClick={() => openPalette(config.role, area.id)}>
                              +
                            </button>
                          </header>
                          <div className="chip-zone subject-chip-zone">
                            {areaAtoms.length === 0 ? (
                              <button className="empty-row" type="button" onClick={() => openPalette(config.role, area.id)}>
                                从调色板或手写输入添加胶囊
                              </button>
                            ) : (
                              areaAtoms.map((atom) => (
                                <PromptChip
                                  atom={atom}
                                  thumbnailUrl={thumbnailForAtom(atom)}
                                  key={atom.id}
                                  editing={editingAtomId === atom.id}
                                  onEdit={() => setEditingAtomId((current) => (current === atom.id ? null : atom.id))}
                                  onClose={() => setEditingAtomId(null)}
                                  onRemove={() => removeAtom(config.role, atom.id)}
                                  onPatch={(patch) => patchAtom(config.role, atom.id, patch)}
                                />
                              ))
                            )}
                          </div>
                          <div className="input-grid input-grid-mixed">
                            <label className="tag-input-field">
                              <span>手写 tags</span>
                              <div className="inline-input">
                                <input
                                  value={areaManualValue}
                                  onChange={(event) => setManualInputs((current) => ({ ...current, [areaManualKey]: event.target.value }))}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') addManual(config.role, area.block, area.id)
                                  }}
                                  placeholder="tag, 1.05::tag::"
                                />
                                <button type="button" onClick={() => addManual(config.role, area.block, area.id)}>
                                  添加
                                </button>
                              </div>
                            </label>
                            <label className="natural-input-field">
                              <span>自然语言段</span>
                              <div className="inline-input">
                                <textarea
                                  value={areaNaturalValue}
                                  onChange={(event) => setNaturalInputs((current) => ({ ...current, [areaNaturalKey]: event.target.value }))}
                                  placeholder="整段保留，不按逗号拆分"
                                />
                                <button type="button" onClick={() => addNatural(config.role, area.block, area.id)}>
                                  加段
                                </button>
                              </div>
                            </label>
                          </div>
                        </section>
                      )
                    })}
                  </div>
                ) : (
                  <>
                    {config.role === 'camera' && (
                      <div className="camera-view-controls" aria-label="镜头视角">
                        <span>镜头视角</span>
                        <select
                          value={cameraView.perspective}
                          onChange={(event) => setCameraView((current) => ({ ...current, perspective: event.target.value as Perspective }))}
                        >
                          {PERSPECTIVES.map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={cameraView.composition}
                          onChange={(event) => setCameraView((current) => ({ ...current, composition: event.target.value as Composition }))}
                        >
                          {COMPOSITIONS.map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="chip-zone">
                      {section.atoms.length === 0 ? (
                        <button
                          className="empty-row"
                          type="button"
                          disabled={!config.includeTags && !config.includeRecipes}
                          onClick={() => openPalette(config.role)}
                        >
                          从调色板或手写输入添加胶囊
                        </button>
                      ) : (
                        <>
                          {section.atoms.map((atom) => (
                            <PromptChip
                              atom={atom}
                              thumbnailUrl={thumbnailForAtom(atom)}
                              key={atom.id}
                              editing={editingAtomId === atom.id}
                              onEdit={() => setEditingAtomId((current) => (current === atom.id ? null : atom.id))}
                              onClose={() => setEditingAtomId(null)}
                              onRemove={() => removeAtom(config.role, atom.id)}
                              onPatch={(patch) => patchAtom(config.role, atom.id, patch)}
                            />
                          ))}
                          {(config.includeTags || config.includeRecipes) && (
                            <button className="chip-add-tile" type="button" aria-label={`添加${config.title}`} onClick={() => openPalette(config.role)}>
                              +
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    <div className="input-grid input-grid-mixed">
                      <label className="tag-input-field">
                        <span>手写 tags</span>
                        <div className="inline-input">
                          <input
                            value={manualValue}
                            onChange={(event) => setManualInputs((current) => ({ ...current, [manualKey]: event.target.value }))}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') addManual(config.role, activeBlock)
                            }}
                            placeholder="a, b, 1.05::c::"
                          />
                          <button type="button" onClick={() => addManual(config.role, activeBlock)}>
                            添加
                          </button>
                        </div>
                      </label>
                      <label className="natural-input-field">
                        <span>自然语言段</span>
                        <div className="inline-input">
                          <textarea
                            value={naturalValue}
                            onChange={(event) => setNaturalInputs((current) => ({ ...current, [naturalKey]: event.target.value }))}
                            placeholder="整段保留，不按逗号拆分"
                          />
                          <button type="button" onClick={() => addNatural(config.role, activeBlock)}>
                            加段
                          </button>
                        </div>
                      </label>
                    </div>
                  </>
                )}
              </section>
            )
          })}

          <section className="character-section">
            <header className="section-head">
              <div>
                <h2>角色提示词</h2>
                <p>多角色 caption / 衣服 / 位置 / 关系动作</p>
              </div>
              <div className="section-actions">
                <button className="ghost-button" type="button" onClick={addEmptyCharacterSection}>
                  空角色
                </button>
                <button className="add-button" type="button" onClick={addCharacterSection}>
                  <span>+</span>
                  角色
                </button>
              </div>
            </header>

            {doc.characterSections.length > 1 && (
              <div className="relation-builder">
                <strong>+ 关系动作</strong>
                <select value={relationInput.sourceId} onChange={(event) => setRelationInput((current) => ({ ...current, sourceId: event.target.value }))}>
                  <option value="">源角色</option>
                  {doc.characterSections.map((section, index) => (
                    <option value={section.id} key={section.id}>
                      {index + 1}. {section.name}
                    </option>
                  ))}
                </select>
                <select value={relationInput.targetId} onChange={(event) => setRelationInput((current) => ({ ...current, targetId: event.target.value }))}>
                  <option value="">目标角色</option>
                  {doc.characterSections.map((section, index) => (
                    <option value={section.id} key={section.id}>
                      {index + 1}. {section.name}
                    </option>
                  ))}
                </select>
                <input
                  value={relationInput.text}
                  onChange={(event) => setRelationInput((current) => ({ ...current, text: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addRelation()
                  }}
                  placeholder="动作文本，如 kiss"
                />
                <button className="ghost-button" type="button" onClick={addRelation}>
                  生成关系
                </button>
              </div>
            )}

            <div className="character-card-list">
              {doc.characterSections.length === 0 ? (
                <button className="empty-row" type="button" onClick={addCharacterSection}>
                  从角色库添加角色，或点“空角色”手写
                </button>
              ) : (
                doc.characterSections.map((section, index) => {
                  const character = state.characters.find((item) => item.id === section.characterId)
                  const outfit = character?.outfits.find((item) => item.id === section.outfitId)
                  const characterThumb = entityThumbUrl('char', character?.id, character?.preview_image, state.imagePaths)
                  const outfitThumb = entityThumbUrl('outfit', outfit?.id, outfit?.preview_image, state.imagePaths) ?? characterThumb
                  const captionAtoms = section.atoms.filter((atom) => atom.block !== 'clothing' && !isAccessoryAtom(atom))
                  const clothingAtoms = section.atoms.filter((atom) => atom.block === 'clothing' && !isAccessoryAtom(atom))
                  const negativeCollapsed = collapsedNegatives[section.id] ?? true
                  const characterNaturalValue = naturalInputs[section.id] ?? ''
                  const characterNegativeValue = negativeInputs[section.id] ?? ''
                  return (
                    <article
                      className={`character-card ${section.enabled ? '' : 'is-disabled'}`}
                      key={section.id}
                      style={{ '--character-accent': blockColor(index % 3 === 0 ? 'character' : index % 3 === 1 ? 'clothing' : 'sub_style') } as CSSProperties}
                    >
                      <header className="character-card-head">
                        <div className="character-card-title">
                          {characterThumb ? <img src={characterThumb} alt="" loading="lazy" /> : <span className="character-thumb-fallback">{index + 1}</span>}
                          <div>
                            <h3>char_index {index + 1}</h3>
                            <p>{character ? `${character.name} / ${outfit?.name ?? '未选择衣服'}` : '尚未选择角色'}</p>
                          </div>
                        </div>
                        <div className="section-actions">
                          <button className="ghost-button" type="button" disabled={index === 0} onClick={() => moveCharacterSection(section.id, -1)}>
                            上移
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            disabled={index === doc.characterSections.length - 1}
                            onClick={() => moveCharacterSection(section.id, 1)}
                          >
                            下移
                          </button>
                          <label className="switch-row">
                            <input
                              type="checkbox"
                              checked={section.enabled}
                              onChange={(event) => updateCharacterSection(section.id, (current) => ({ ...current, enabled: event.target.checked }))}
                            />
                            启用
                          </label>
                          <button className="ghost-button danger-button" type="button" onClick={() => removeCharacterSection(section.id)}>
                            删除
                          </button>
                        </div>
                      </header>

                      <label className="character-name-input">
                        <span>角色名</span>
                        <input value={section.name} onChange={(event) => updateCharacterSection(section.id, (current) => ({ ...current, name: event.target.value }))} />
                      </label>

                      <div className="character-setup">
                      <div className="character-pickers">
                        <button className="picker-summary" type="button" onClick={() => setPickerTarget({ type: 'character', sectionId: section.id })}>
                          {characterThumb ? (
                            <img className="picker-summary-thumb" src={characterThumb} alt="" loading="lazy" />
                          ) : (
                            <span className="picker-summary-thumb">角色</span>
                          )}
                          <span className="picker-summary-text">
                            <span>{character?.name ?? '选择角色'}</span>
                            <small>{character ? `${character.outfits.length} 套衣服` : '打开角色选择器'}</small>
                          </span>
                        </button>
                        <button
                          className="picker-summary"
                          type="button"
                          disabled={!character}
                          onClick={() => setPickerTarget({ type: 'outfit', sectionId: section.id })}
                        >
                          {outfitThumb ? (
                            <img className="picker-summary-thumb" src={outfitThumb} alt="" loading="lazy" />
                          ) : (
                            <span className="picker-summary-thumb">衣服</span>
                          )}
                          <span className="picker-summary-text">
                            <span>{outfit?.name ?? '选择衣服'}</span>
                            <small>{outfit?.negative_text ? '含衣服负面' : '打开衣服选择器'}</small>
                          </span>
                        </button>
                      </div>
                        <div className="character-setup-side">
                          <span className="setup-side-label">位置</span>
                          <div className="position-grid" aria-label="角色位置">
                            {gridPositions.map((y) =>
                              gridPositions.map((x) => {
                                const selected = (section.position?.x ?? 0.5) === x && (section.position?.y ?? 0.5) === y
                                return (
                                  <button
                                    className={selected ? 'is-active' : ''}
                                    type="button"
                                    aria-label={`位置 ${x.toFixed(1)}, ${y.toFixed(1)}`}
                                    key={`${x}:${y}`}
                                    onClick={() => updateCharacterSection(section.id, (current) => ({ ...current, position: { x, y } }))}
                                  />
                                )
                              }),
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="character-controls">
                        <div className="view-segment" aria-label="角色视角">
                          {PERSPECTIVES.map((item) => (
                            <button
                              className={section.view.perspective === item.id ? 'is-active' : ''}
                              type="button"
                              title={item.hint}
                              key={item.id}
                              onClick={() => setCharacterView(section.id, { perspective: item.id }, true)}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                        <div className="view-segment view-segment-wide" aria-label="角色构图">
                          {COMPOSITIONS.map((item) => (
                            <button
                              className={section.view.composition === item.id ? 'is-active' : ''}
                              type="button"
                              title={item.hint}
                              key={item.id}
                              onClick={() => setCharacterView(section.id, { composition: item.id }, true)}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                        <label className="switch-row">
                          <input
                            type="checkbox"
                            checked={section.view.linkedToCamera}
                            onChange={(event) =>
                              updateCharacterSection(section.id, (current) => ({
                                ...current,
                                view: { ...current.view, linkedToCamera: event.target.checked },
                              }))
                            }
                          />
                          跟随镜头
                        </label>
                        {section.view.manuallyOverridden && (
                          <button className="ghost-button" type="button" onClick={() => relinkCharacterToCamera(section.id)}>
                            重新跟随镜头
                          </button>
                        )}
                      </div>
                      <p className="view-status">
                        {section.view.linkedToCamera && !section.view.manuallyOverridden ? '跟随镜头' : '角色独立视角'} / {section.view.perspective}_{section.view.composition}
                      </p>

                      <div className="character-prompt-groups">
                        <section className="char-prompt-group" style={{ '--group-accent': blockColor('character') } as CSSProperties}>
                          <h4 className="char-prompt-group-head">
                            <span>角色 caption</span>
                            <em>{captionAtoms.length}</em>
                          </h4>
                          <div className="chip-zone character-chip-zone">
                            {captionAtoms.length === 0 ? (
                              <button className="empty-row" type="button" onClick={() => setPickerTarget({ type: 'character', sectionId: section.id })}>
                                选择角色后按视角解析为胶囊
                              </button>
                            ) : (
                              captionAtoms.map((atom) => (
                                <PromptChip
                                  atom={atom}
                                  thumbnailUrl={thumbnailForAtom(atom)}
                                  key={atom.id}
                                  editing={editingAtomId === atom.id}
                                  onEdit={() => setEditingAtomId((current) => (current === atom.id ? null : atom.id))}
                                  onClose={() => setEditingAtomId(null)}
                                  onRemove={() => removeCharacterAtom(section.id, atom.id)}
                                  onPatch={(patch) => patchCharacterAtom(section.id, atom.id, patch)}
                                />
                              ))
                            )}
                          </div>
                        </section>
                        <section className="char-prompt-group" style={{ '--group-accent': blockColor('clothing') } as CSSProperties}>
                          <h4 className="char-prompt-group-head">
                            <span>衣服</span>
                            <em>{clothingAtoms.length}</em>
                          </h4>
                          <div className="chip-zone character-chip-zone">
                            {clothingAtoms.length === 0 ? (
                              <button className="empty-row" type="button" disabled={!character} onClick={() => setPickerTarget({ type: 'outfit', sectionId: section.id })}>
                                选择衣服后解析为胶囊
                              </button>
                            ) : (
                              clothingAtoms.map((atom) => (
                                <PromptChip
                                  atom={atom}
                                  thumbnailUrl={thumbnailForAtom(atom)}
                                  key={atom.id}
                                  editing={editingAtomId === atom.id}
                                  onEdit={() => setEditingAtomId((current) => (current === atom.id ? null : atom.id))}
                                  onClose={() => setEditingAtomId(null)}
                                  onRemove={() => removeCharacterAtom(section.id, atom.id)}
                                  onPatch={(patch) => patchCharacterAtom(section.id, atom.id, patch)}
                                />
                              ))
                            )}
                          </div>
                        </section>
                      </div>

                      <div className="character-accessory-groups">
                        {accessoryTypes.map((type) => {
                          const typeAtoms = section.atoms.filter((atom) => atom.category === `${ACCESSORY_CATEGORY_PREFIX}${type.id}`)
                          return (
                            <section className="char-prompt-group" key={type.id} style={{ '--group-accent': blockColor(type.accent) } as CSSProperties}>
                              <h4 className="char-prompt-group-head">
                                <span>{type.title}</span>
                                <em>{typeAtoms.length}</em>
                                <button
                                  className="accessory-add"
                                  type="button"
                                  aria-label={`选择${type.title}`}
                                  onClick={() => setPickerTarget({ type: 'accessory', sectionId: section.id, accessoryType: type.id })}
                                >
                                  +
                                </button>
                              </h4>
                              <div className="chip-zone character-chip-zone">
                                {typeAtoms.length === 0 ? (
                                  <button
                                    className="empty-row"
                                    type="button"
                                    onClick={() => setPickerTarget({ type: 'accessory', sectionId: section.id, accessoryType: type.id })}
                                  >
                                    选择{type.title}
                                  </button>
                                ) : (
                                  typeAtoms.map((atom) => (
                                    <PromptChip
                                      atom={atom}
                                      thumbnailUrl={thumbnailForAtom(atom)}
                                      key={atom.id}
                                      editing={editingAtomId === atom.id}
                                      onEdit={() => setEditingAtomId((current) => (current === atom.id ? null : atom.id))}
                                      onClose={() => setEditingAtomId(null)}
                                      onRemove={() => removeCharacterAtom(section.id, atom.id)}
                                      onPatch={(patch) => patchCharacterAtom(section.id, atom.id, patch)}
                                    />
                                  ))
                                )}
                              </div>
                            </section>
                          )
                        })}
                      </div>

                      <div className="input-grid character-input-grid">
                        <label>
                          <span>自然语言补充</span>
                          <div className="inline-input">
                            <input
                              value={characterNaturalValue}
                              onChange={(event) => setNaturalInputs((current) => ({ ...current, [section.id]: event.target.value }))}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') addCharacterNatural(section.id)
                              }}
                              placeholder="整段保留，不按逗号拆分"
                            />
                            <button type="button" onClick={() => addCharacterNatural(section.id)}>
                              加段
                            </button>
                          </div>
                        </label>
                        <label>
                          <span>角色负面词</span>
                          <div className="inline-input">
                            <input
                              value={characterNegativeValue}
                              onChange={(event) => setNegativeInputs((current) => ({ ...current, [section.id]: event.target.value }))}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') addCharacterNegative(section.id)
                              }}
                              placeholder="bad hands, extra fingers"
                            />
                            <button type="button" onClick={() => addCharacterNegative(section.id)}>
                              添加
                            </button>
                          </div>
                        </label>
                      </div>

                      <section className="negative-block">
                        <button
                          className="negative-toggle"
                          type="button"
                          onClick={() => setCollapsedNegatives((current) => ({ ...current, [section.id]: !negativeCollapsed }))}
                        >
                          <span>{negativeCollapsed ? '+' : '-'}</span>
                          角色负面
                          <em>{section.negativeAtoms?.length ?? 0}</em>
                        </button>
                        {!negativeCollapsed && (
                          <div className="chip-zone character-chip-zone">
                            {(section.negativeAtoms ?? []).length === 0 ? (
                              <div className="empty-row">无角色负面</div>
                            ) : (
                              (section.negativeAtoms ?? []).map((atom) => (
                                <PromptChip
                                  atom={atom}
                                  thumbnailUrl={thumbnailForAtom(atom)}
                                  key={atom.id}
                                  editing={editingAtomId === atom.id}
                                  onEdit={() => setEditingAtomId((current) => (current === atom.id ? null : atom.id))}
                                  onClose={() => setEditingAtomId(null)}
                                  onRemove={() => removeCharacterAtom(section.id, atom.id, 'negativeAtoms')}
                                  onPatch={(patch) => patchCharacterAtom(section.id, atom.id, patch, 'negativeAtoms')}
                                />
                              ))
                            )}
                          </div>
                        )}
                      </section>

                      {(section.relationAtoms ?? []).length > 0 && (
                        <div className="chip-zone character-chip-zone relation-chip-zone">
                          {(section.relationAtoms ?? []).map((atom) => (
                            <PromptChip
                              atom={atom}
                              thumbnailUrl={thumbnailForAtom(atom)}
                              key={atom.id}
                              editing={editingAtomId === atom.id}
                              onEdit={() => setEditingAtomId((current) => (current === atom.id ? null : atom.id))}
                              onClose={() => setEditingAtomId(null)}
                              onRemove={() => removeCharacterAtom(section.id, atom.id, 'relationAtoms')}
                              onPatch={(patch) => patchCharacterAtom(section.id, atom.id, patch, 'relationAtoms')}
                            />
                          ))}
                        </div>
                      )}
                    </article>
                  )
                })
              )}
            </div>
          </section>
          <details className="preview-panel" aria-label="实时 prompt 预览">
            <summary>
              <span>实时 prompt 预览</span>
              <em>
                {promptWordCount} 词 / 约 {prompt.length} 字符
              </em>
            </summary>
            <header>
              <div>
                <h2>实时 prompt 预览</h2>
                <p>
                  {promptWordCount} 词 / 约 {prompt.length} 字符
                </p>
              </div>
              <button type="button" onClick={copyPrompt} disabled={!prompt}>
                复制 prompt
              </button>
            </header>
            <section className="preview-block">
              <h3>基础正向 prompt</h3>
              <textarea readOnly value={basePrompt} placeholder="这里会实时拼接基础区 prompt" />
            </section>
            <section className="preview-block character-preview-block">
              <h3>角色 captions</h3>
              {characterCaptions.length === 0 ? (
                <div className="preview-empty">启用角色后显示角色 caption</div>
              ) : (
                <div className="character-caption-list">
                  {characterCaptions.map((caption, index) => (
                    <pre key={`${index}:${caption}`}>{caption}</pre>
                  ))}
                </div>
              )}
            </section>
          </details>
        </section>
      </div>

      {activePaletteConfig && (
        <PickerModal
          section={
            {
              role: activePaletteConfig.role,
              title: activePaletteConfig.title,
              blocks: activePaletteConfig.blocks,
              mode: activePaletteConfig.pickerMode ?? 'tag',
            } satisfies PickerSectionConfig
          }
          items={activePaletteItems}
          imagePaths={state.imagePaths}
          tagThumbs={state.tagThumbs}
          blockMeta={pickerBlockMeta}
          lockedArea={activePaletteConfig.role === 'action_scene' ? activePaletteArea : undefined}
          onPick={(item) => {
            addPaletteItem(activePaletteConfig.role, item)
            // 画师串(recipe 整串)是单选语义：挑一个完整画师串即结束，不逐个添加(2.1)
            if (activePaletteConfig.pickerMode === 'recipe') setPickerTarget(null)
          }}
          onClose={() => setPickerTarget(null)}
        />
      )}

      {pickerTarget?.type === 'character' && (
        <PickerModal
          section={
            {
              role: 'free',
              title: '选择角色',
              blocks: ['character'],
              mode: 'character',
            } satisfies PickerSectionConfig
          }
	          items={characterPickerItems}
	          imagePaths={state.imagePaths}
	          tagThumbs={state.tagThumbs}
	          blockMeta={pickerBlockMeta}
	          onPick={(item) => (pickerTarget.sectionId ? selectCharacter(pickerTarget.sectionId, item.character) : addCharacterFromLibrary(item.character))}
	          onClose={() => setPickerTarget(null)}
	        />
      )}

      {pickerTarget?.type === 'outfit' && (
        <PickerModal
          section={
            {
              role: 'free',
              title: '选择衣服',
              blocks: ['clothing'],
              mode: 'outfit',
            } satisfies PickerSectionConfig
          }
          items={activeOutfitItems}
          imagePaths={state.imagePaths}
          tagThumbs={state.tagThumbs}
          blockMeta={pickerBlockMeta}
          onPick={(item) => selectOutfit(pickerTarget.sectionId, item.outfit)}
          onClose={() => setPickerTarget(null)}
        />
      )}

      {pickerTarget?.type === 'accessory' && (
        <PickerModal
          section={
            {
              role: 'free',
              title: `配件 · ${activeAccessoryType?.title ?? ''}`,
              blocks: ['clothing'],
              mode: 'tag',
            } satisfies PickerSectionConfig
          }
          items={activeAccessoryItems}
          imagePaths={state.imagePaths}
          tagThumbs={state.tagThumbs}
          blockMeta={pickerBlockMeta}
          onPick={(item) => addAccessoryItem(pickerTarget.sectionId, pickerTarget.accessoryType, item as PaletteItem)}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </div>
  )
}

function PromptChip({
  atom,
  thumbnailUrl,
  editing,
  onEdit,
  onClose,
  onRemove,
  onPatch,
}: {
  atom: PromptAtom
  thumbnailUrl?: string | null
  editing: boolean
  onEdit: () => void
  onClose: () => void
  onRemove: () => void
  onPatch: (patch: Partial<PromptAtom>) => void
}) {
  const chipRef = useRef<HTMLElement | null>(null)
  const hasTranslation = Boolean(atom.labelZh)
  const displayText = atom.kind === 'natural' ? atom.text : atom.text || atom.labelZh || '未命名'
  const weightValue = atom.weight?.mode === 'nai_colon' ? atom.weight.value : 1

  useEffect(() => {
    if (!editing) return

    const handlePointerDown = (event: PointerEvent) => {
      if (chipRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [editing, onClose])

  function patchWeight(value: string): void {
    const next = Number(value)
    if (value === '' || Number.isNaN(next)) {
      onPatch({ weight: undefined })
      return
    }
    // 出图红线：权重上限 1.2（极端值），编辑器不放行超过的值
    const clamped = Math.max(0, Math.min(1.2, next))
    onPatch({
      weight: clamped === 1 ? undefined : { mode: 'nai_colon', value: clamped },
    })
  }

  function stepWeight(delta: number): void {
    patchWeight(formatWeight(Math.max(0, Math.min(1.2, weightValue + delta))))
  }

  return (
    <article
      ref={chipRef}
      className={`prompt-chip ${atom.enabled ? '' : 'is-disabled'} ${atom.kind === 'natural' ? 'is-natural' : ''} ${editing ? 'is-editing' : ''}`}
      style={{ '--chip-color': blockColor(atom.block) } as CSSProperties}
    >
      <span className="chip-bar" style={{ backgroundColor: blockColor(atom.block) }} />
      {thumbnailUrl && <img className="chip-thumb" src={thumbnailUrl} alt="" loading="lazy" />}
      <button className="chip-body" type="button" onClick={onEdit}>
        <strong>{displayText}</strong>
        <small>{hasTranslation ? atom.labelZh : '待译'}</small>
      </button>
      {atom.weight?.mode === 'nai_colon' && atom.weight.value !== 1 && (
        <span className={`weight-pill ${atom.weight.value > 1 ? 'is-boost' : 'is-reduce'}`}>×{formatWeight(atom.weight.value)}</span>
      )}
      <button className="remove-chip" type="button" aria-label="删除胶囊" onClick={onRemove}>
        ×
      </button>

      {editing && (
        <div className="chip-popover">
          <label>
            文本
            <input value={atom.text} onChange={(event) => onPatch({ text: event.target.value })} />
          </label>
          <label>
            中文名
            <input value={atom.labelZh ?? ''} onChange={(event) => onPatch({ labelZh: event.target.value || undefined })} />
          </label>
          <label>
            权重
            <span className="weight-stepper">
              <button type="button" aria-label="降低权重" onClick={() => stepWeight(-0.05)}>
                -
              </button>
              <input type="number" min="0" max="1.2" step="0.05" value={formatWeightInput(weightValue)} onChange={(event) => patchWeight(event.target.value)} />
              <button type="button" aria-label="提高权重" onClick={() => stepWeight(0.05)}>
                +
              </button>
            </span>
            <input
              className="weight-slider"
              type="range"
              min="0"
              max="1.2"
              step="0.05"
              value={weightValue}
              onChange={(event) => patchWeight(event.target.value)}
            />
          </label>
          <label className="switch-row">
            <input type="checkbox" checked={atom.enabled} onChange={(event) => onPatch({ enabled: event.target.checked })} />
            启用
          </label>
        </div>
      )}
    </article>
  )
}

export default PromptEditor

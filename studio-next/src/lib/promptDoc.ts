import type { CharacterEntry, PublicNaiConfig, RecipeEntry, TagEntry } from './dataClient'
import type { PickerItem } from '../PickerModal'
import {
  BLOCK_LABELS,
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

export type BaseRole = PromptSection['role']

export type BaseSectionConfig = {
  role: BaseRole
  title: string
  hint: string
  blocks: PromptBlock[]
  includeTags: boolean
  includeRecipes: boolean
  pickerMode?: 'tag' | 'recipe'
}

export type PaletteItem = PickerItem & {
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

export type CharacterPickerItem = PickerItem & {
  kind: 'character'
  character: CharacterEntry
}

export type OutfitPickerItem = PickerItem & {
  kind: 'outfit'
  characterId: string
  outfit: CharacterEntry['outfits'][number]
}

type ViewVariantTexts = CharacterEntry['traits']

export const blockColors: Record<PromptBlock, string> = {
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

export const baseSectionConfigs: BaseSectionConfig[] = [
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

export const baseRoleOrder = baseSectionConfigs.map((section) => section.role)

export const defaultView = {
  perspective: 'front' as Perspective,
  composition: 'full' as Composition,
}

export function isPromptBlock(value: string): value is PromptBlock {
  return Object.prototype.hasOwnProperty.call(BLOCK_LABELS, value)
}

export function blockColor(block?: PromptBlock): string {
  return block ? blockColors[block] : '#64748b'
}

export function blockLabel(block: PromptBlock): string {
  return BLOCK_LABELS[block]
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function createEmptyDoc(): PromptDoc {
  const now = new Date().toISOString()
  return {
    id: uid('doc'),
    version: 1,
    title: '基础提示词',
    target: 'nai',
    baseSections: baseSectionConfigs.map((config): PromptSection => ({
      id: `base_${config.role}`,
      role: config.role,
      block: config.blocks[0],
      enabled: true,
      private: false,
      atoms: [],
    })),
    characterSections: [],
    meta: {
      createdAt: now,
      updatedAt: now,
    },
  }
}

export function normalizeText(value: string): string {
  return value.trim().replace(/,+$/g, '').trim()
}

export function dedupeTexts(values: string[]): string[] {
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

export function getViewText(v: ViewVariantTexts | undefined, perspective: Perspective, composition: Composition): string {
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

export function formatWeight(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))
}

export function formatWeightInput(value: number): string {
  return value.toFixed(2).replace(/0$/, '')
}

export function atomPrompt(atom: PromptAtom): string {
  const text = normalizeText(atom.text)
  if (!atom.enabled || !text) return ''
  if (atom.weight?.mode === 'nai_colon' && atom.weight.value !== 1) {
    return `${formatWeight(atom.weight.value)}::${text}::`
  }
  return text
}

export function buildPrompt(sections: PromptSection[]): string {
  return sections
    .filter((section) => section.enabled && baseRoleOrder.includes(section.role))
    .flatMap((section) => section.atoms.map(atomPrompt))
    .filter(Boolean)
    .join(', ')
}

export function positionPrompt(section: CharacterPromptSection): string {
  const position = section.position ?? { x: 0.5, y: 0.5 }
  return `position(${position.x.toFixed(1)},${position.y.toFixed(1)})`
}

export function relationPrompt(atom: PromptAtom): string {
  const text = normalizeText(atom.text)
  if (!atom.enabled || !text) return ''
  if (atom.category === 'source') return `source#${text}`
  if (atom.category === 'target') return `target#${text}`
  return text
}

export function buildCharacterSegment(section: CharacterPromptSection, index: number): string {
  if (!section.enabled) return ''
  const positive = section.atoms.map(atomPrompt).filter(Boolean)
  const relations = (section.relationAtoms ?? []).map(relationPrompt).filter(Boolean)
  const negatives = (section.negativeAtoms ?? []).map(atomPrompt).filter(Boolean)
  const caption = [...positive, positionPrompt(section), ...relations].filter(Boolean).join(', ')
  if (!caption) return ''
  const negative = negatives.length > 0 ? ` | 角色负面: ${negatives.join(', ')}` : ''
  return `char_index ${index + 1} / ${section.name || '未命名角色'}: ${caption}${negative}`
}

export function buildFullPrompt(baseSections: PromptSection[], characterSections: CharacterPromptSection[]): string {
  const base = buildPrompt(baseSections)
  const characters = characterSections.map(buildCharacterSegment).filter(Boolean)
  return [base, ...characters].filter(Boolean).join('\n\n')
}

export function countPromptWords(prompt: string): number {
  return prompt
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean).length
}

export function parseWeightedToken(token: string): { text: string; weight?: PromptAtom['weight'] } {
  const match = token.trim().match(/^([+-]?\d+(?:\.\d+)?)::([\s\S]+)::$/)
  if (!match) return { text: normalizeText(token) }
  return {
    text: normalizeText(match[2]),
    weight: { mode: 'nai_colon', value: Number(match[1]) },
  }
}

export function splitPromptList(input: string): string[] {
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

export function makeManualAtom(text: string, block?: PromptBlock, kind: PromptAtom['kind'] = 'raw', category?: string): PromptAtom {
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

export function makeCharacterAtom(text: string, characterId: string, field: string, kind: 'character_trait' | 'outfit', block: PromptBlock): PromptAtom {
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

export function makeRelationAtom(text: string, sourceIndex: number, targetIndex: number, sourceSectionId: string, targetSectionId: string): PromptAtom {
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

export function buildCharacterAtoms(
  character: CharacterEntry,
  outfit: CharacterEntry['outfits'][number] | undefined,
  perspective: Perspective,
  composition: Composition,
): PromptAtom[] {
  const traitText = normalizeText(getViewText(character.traits, perspective, composition))
  const outfitText = normalizeText(getViewText(outfit?.tags, perspective, composition))
  return [
    traitText ? makeCharacterAtom(traitText, character.id, 'traits', 'character_trait', 'character') : null,
    outfitText ? makeCharacterAtom(outfitText, character.id, `outfit:${outfit?.id ?? ''}`, 'outfit', 'clothing') : null,
  ].filter((atom): atom is PromptAtom => Boolean(atom))
}

export function buildNegativeAtoms(character: CharacterEntry, outfit: CharacterEntry['outfits'][number] | undefined): PromptAtom[] {
  const parts = dedupeTexts([character.negative_text ?? '', outfit?.negative_text ?? ''].flatMap(splitPromptList))
  return parts.map((part) => makeCharacterAtom(part, character.id, outfit ? `negative:${outfit.id}` : 'negative', 'character_trait', 'effect'))
}

export function makePaletteAtom(item: PaletteItem): PromptAtom {
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

export function toPaletteItems(tags: TagEntry[], recipes: RecipeEntry[]): PaletteItem[] {
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

export function toCharacterPickerItems(characters: CharacterEntry[]): CharacterPickerItem[] {
  return characters.map((character): CharacterPickerItem => ({
    id: `character:${character.id}`,
    kind: 'character',
    block: 'character',
    category: '角色',
    title: character.name,
    subtitle: `${character.outfits.length} 套衣服`,
    text: character.name,
    image: character.preview_image,
    character,
  }))
}

export function toOutfitPickerItems(character: CharacterEntry | undefined): OutfitPickerItem[] {
  if (!character) return []
  return character.outfits.map((outfit): OutfitPickerItem => ({
    id: `outfit:${character.id}:${outfit.id}`,
    kind: 'outfit',
    block: 'clothing',
    category: character.name,
    title: outfit.name,
    subtitle: outfit.note ?? '',
    text: outfit.name,
    image: outfit.preview_image,
    characterId: character.id,
    outfit,
  }))
}

export function paletteForSection(section: BaseSectionConfig, items: PaletteItem[]): PaletteItem[] {
  return items.filter((item) => {
    if (!section.blocks.includes(item.block)) return false
    if (item.kind === 'tag' && !section.includeTags) return false
    if (item.kind === 'recipe' && !section.includeRecipes) return false
    return true
  })
}

export function extractDefaultQualityAtoms(config: PublicNaiConfig): PromptAtom[] {
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

export function updateSection(doc: PromptDoc, role: BaseRole, updater: (section: PromptSection) => PromptSection): PromptDoc {
  return {
    ...doc,
    baseSections: doc.baseSections.map((section) => (section.role === role ? updater(section) : section)),
    meta: {
      ...doc.meta,
      updatedAt: new Date().toISOString(),
    },
  }
}

export function refreshRelationIndexes(sections: CharacterPromptSection[]): CharacterPromptSection[] {
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

import type { PromptBlock, ViewKey } from '../types/prompt'

export interface TagEntry {
  tag: string
  name_zh: string
  block: PromptBlock | string
  category: string
  note: string
}

export interface RecipeEntry {
  id: string
  name: string
  name_zh?: string
  block: PromptBlock | string
  category: string
  group: string
  tags: string
  note: string
  image: string | null
  source: 'legacy' | 'xlsx' | 'manual' | string
  negative_text?: string
  tags_front_cowboy?: string
  tags_front_upper?: string
  tags_front_mid?: string
  tags_front_lower?: string
  tags_back_full?: string
  tags_back_cowboy?: string
  tags_back_upper?: string
  tags_back_mid?: string
  tags_back_lower?: string
  tags_cowboy?: string
  tags_upper?: string
  tags_back?: string
}

export type ViewVariantTexts = {
  front_full: string
} & Partial<Record<ViewKey, string>>

export interface Outfit {
  id: string
  name: string
  preview_image: string | null
  tags: ViewVariantTexts
  note?: string
  negative_text?: string
}

export interface CharacterEntry {
  id: string
  name: string
  preview_image: string | null
  traits: ViewVariantTexts
  outfits: Outfit[]
  default_outfit?: string
  negative_text?: string
  note?: string
  createdAt?: string
  updatedAt?: string
}

export interface InspirationEntry {
  id: string
  text: string
  type: string
  image?: string | null
  note?: string
  created: string
}

export interface PublicNaiConfig {
  default_base_blocks?: unknown
  size_presets?: unknown
  default_params?: unknown
  batch?: unknown
}

export type TagThumbIndex = Record<string, string | null>

export interface RatingSummaryItem {
  folder: string
  count: number
  distribution: Record<string, number>
  average: number | null
  ratedCount: number
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

export interface TranslateResult {
  translations: Record<string, string>
  untranslated: string[]
  error: string | null
}

async function translateTexts(texts: string[]): Promise<TranslateResult> {
  if (texts.length === 0) return { translations: {}, untranslated: [], error: null }
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  })
  if (!response.ok) {
    return { translations: {}, untranslated: texts, error: `translate failed: ${response.status}` }
  }
  return (await response.json()) as TranslateResult
}

export const dataClient = {
  getTags: () => fetchJson<TagEntry[]>('/api/data/tags'),
  getRecipes: () => fetchJson<RecipeEntry[]>('/api/data/recipes'),
  getCharacters: () => fetchJson<CharacterEntry[]>('/api/data/characters'),
  fetchInspirations: () => fetchJson<InspirationEntry[]>('/api/data/inspirations'),
  getNaiConfig: () => fetchJson<PublicNaiConfig>('/api/data/nai-config'),
  getImages: () => fetchJson<string[]>('/api/data/images'),
  fetchTagThumbs: () => fetchJson<TagThumbIndex>('/api/data/tag-thumbs'),
  fetchRatingSummary: () => fetchJson<RatingSummaryItem[]>('/api/rating/summary'),
  translateTexts,
}

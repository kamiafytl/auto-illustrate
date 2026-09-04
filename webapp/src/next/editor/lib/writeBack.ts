// 两级写回（E2 蓝图 §四.3）：编辑器里改胶囊=只改本 doc；点「写回库」才写数据文件，弹 diff 确认。
// 语义：对 doc 中带 {type:'recipe'} 来源的胶囊按配方 id 重新拼串（含权重语法回序列化），
// 与库内现值（canonical 归一后）不同 → 生成一条写回项；tag 来源=单胶囊文本改动。
// 落盘走旧版同端点 POST /api/save（type recipes/tags，dataApi.ts 已有，双写 public+root）。
import type { PromptAtom, PromptDoc } from '../types/prompt'
import type { RecipeEntry, TagEntry } from './dataClient'
import { formatWeight, splitPromptList } from './promptDoc'

export type WriteBackItem =
  | { key: string; kind: 'recipe'; recipe: RecipeEntry; name: string; oldText: string; newText: string }
  | { key: string; kind: 'tag'; entry: TagEntry; name: string; oldText: string; newText: string }

/** 胶囊 → 库内文本形态（weight 回序列化成 N::text:: 原语法，与 parseWeightedToken 互逆） */
export function serializeAtomText(atom: PromptAtom): string {
  const text = atom.text.trim()
  if (!text) return ''
  if (atom.weight?.mode === 'nai_colon' && atom.weight.value !== 1) {
    return `${formatWeight(atom.weight.value)}::${text}::`
  }
  return text
}

/** 库值归一（只吃分隔/空白差异，不动内容），用于新旧比较 */
export function canonicalTags(raw: string): string {
  return splitPromptList(raw).join(', ')
}

function allAtoms(doc: PromptDoc): PromptAtom[] {
  return [
    ...doc.baseSections.flatMap((section) => section.atoms),
    ...doc.characterSections.flatMap((section) => [...section.atoms, ...(section.negativeAtoms ?? [])]),
  ]
}

export function collectWriteBacks(doc: PromptDoc, recipes: RecipeEntry[], tags: TagEntry[]): WriteBackItem[] {
  const items: WriteBackItem[] = []
  const atoms = allAtoms(doc)

  // —— 配方：按来源 id 聚合（保持出现顺序，仅启用中的胶囊） ——
  const byRecipe = new Map<string, PromptAtom[]>()
  for (const atom of atoms) {
    if (atom.source.type !== 'recipe') continue
    const list = byRecipe.get(atom.source.id) ?? []
    list.push(atom)
    byRecipe.set(atom.source.id, list)
  }
  for (const [recipeId, group] of byRecipe) {
    const recipe = recipes.find((entry) => entry.id === recipeId)
    if (!recipe) continue
    const newText = group
      .filter((atom) => atom.enabled)
      .map(serializeAtomText)
      .filter(Boolean)
      .join(', ')
    const oldCanon = canonicalTags(recipe.tags || '')
    if (!newText || newText === oldCanon) continue
    items.push({ key: `recipe:${recipeId}`, kind: 'recipe', recipe, name: recipe.name || recipeId, oldText: oldCanon, newText })
  }

  // —— tag 词典：单胶囊改文本（dirty 且与来源不同），同一来源取最后一次改动 ——
  const tagEdits = new Map<string, PromptAtom>()
  for (const atom of atoms) {
    if (atom.source.type !== 'tag' || !atom.dirty) continue
    const newText = atom.text.trim()
    if (!newText || newText === atom.source.tag) continue
    tagEdits.set(atom.source.tag, atom)
  }
  for (const [oldTag, atom] of tagEdits) {
    const entry = tags.find((candidate) => candidate.tag === oldTag)
    if (!entry) continue
    items.push({ key: `tag:${oldTag}`, kind: 'tag', entry, name: entry.name_zh || oldTag, oldText: oldTag, newText: atom.text.trim() })
  }

  return items
}

export async function applyWriteBacks(items: WriteBackItem[]): Promise<{ ok: number; failed: string[] }> {
  let ok = 0
  const failed: string[] = []
  for (const item of items) {
    const body =
      item.kind === 'recipe'
        ? { type: 'recipes', data: { ...item.recipe, tags: item.newText }, old: item.recipe }
        : { type: 'tags', data: { ...item.entry, tag: item.newText }, old: item.entry }
    try {
      const response = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok) ok += 1
      else failed.push(item.name)
    } catch {
      failed.push(item.name)
    }
  }
  return { ok, failed }
}

/** 写回成功后清 doc 内对应胶囊的 dirty 标记（tag 来源同步指向新 tag 名） */
export function markWrittenClean(doc: PromptDoc, written: WriteBackItem[]): PromptDoc {
  const recipeIds = new Set(written.filter((item) => item.kind === 'recipe').map((item) => (item.kind === 'recipe' ? item.recipe.id : '')))
  const tagRenames = new Map(written.filter((item) => item.kind === 'tag').map((item) => [item.oldText, item.newText]))
  const patch = (atoms: PromptAtom[]): PromptAtom[] =>
    atoms.map((atom) => {
      if (atom.source.type === 'recipe' && recipeIds.has(atom.source.id)) return { ...atom, dirty: false }
      if (atom.source.type === 'tag' && tagRenames.has(atom.source.tag)) {
        return { ...atom, dirty: false, source: { ...atom.source, tag: tagRenames.get(atom.source.tag)! } }
      }
      return atom
    })
  return {
    ...doc,
    baseSections: doc.baseSections.map((section) => ({ ...section, atoms: patch(section.atoms) })),
    characterSections: doc.characterSections.map((section) => ({
      ...section,
      atoms: patch(section.atoms),
      negativeAtoms: section.negativeAtoms ? patch(section.negativeAtoms) : section.negativeAtoms,
    })),
  }
}

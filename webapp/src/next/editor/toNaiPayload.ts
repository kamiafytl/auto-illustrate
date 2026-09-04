import type { NaiBatchItem, NaiCharacterPrompt, NaiPromptBlock } from '../../types'
import { BLOCK_LABELS, type CharacterPromptSection, type PromptAtom, type PromptDoc, type PromptSection } from './types/prompt'
import { formatWeight, normalizeText } from './lib/promptDoc'

export type NaiPromptPayload = Pick<NaiBatchItem, 'baseBlocks' | 'characters'>

const BASE_ROLE_LABELS: Record<PromptSection['role'], string> = {
  quality: '画风质量',
  artist: '画师串',
  action_scene: '主体动作',
  camera: '镜头机位',
  effect: '特殊效果',
  free: '自由输入',
}

function atomText(atom: PromptAtom): string {
  const text = normalizeText(atom.text)
  if (!atom.enabled || !text) return ''
  if (atom.weight?.mode === 'nai_colon' && atom.weight.value !== 1) {
    return `(${text}:${formatWeight(Math.min(1.2, atom.weight.value))})`
  }
  return text
}

function atomList(atoms: PromptAtom[] | undefined): string[] {
  return (atoms ?? []).map(atomText).filter(Boolean)
}

function baseSectionName(section: PromptSection): string {
  if (section.role === 'free' && section.block) return BLOCK_LABELS[section.block]
  return BASE_ROLE_LABELS[section.role]
}

function toBaseBlock(section: PromptSection): NaiPromptBlock | null {
  if (!section.enabled) return null
  const parts = atomList(section.atoms)
  if (parts.length === 0) return null
  return {
    id: `next_${section.id}`,
    name: baseSectionName(section),
    text: parts.join(', '),
    enabled: true,
    isPrivate: section.private,
  }
}

function relationBucket(doc: PromptDoc): Map<number, string[]> {
  const byIndex = new Map<number, string[]>()
  const seen = new Set<string>()
  const push = (index: number, value: string) => {
    if (index < 1) return
    const list = byIndex.get(index) ?? []
    list.push(value)
    byIndex.set(index, list)
  }

  for (const section of doc.characterSections) {
    for (const atom of section.relationAtoms ?? []) {
      if (!atom.enabled) continue
      const verb = normalizeText(atom.relation?.verb ?? atom.text)
      if (!verb) continue
      const sourceIndex = atom.relation?.sourceIndex ?? 0
      const targetIndex = atom.relation?.targetIndex ?? 0
      const mutual = atom.category === 'mutual' || sourceIndex === targetIndex
      const key = `${sourceIndex}:${targetIndex}:${mutual ? 'mutual' : 'direct'}:${verb.toLocaleLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      if (mutual) {
        push(sourceIndex, `mutual#${verb}`)
        if (targetIndex !== sourceIndex) push(targetIndex, `mutual#${verb}`)
        continue
      }
      push(sourceIndex, `source#${verb}`)
      push(targetIndex, `target#${verb}`)
    }
  }

  return byIndex
}

function toCharacter(section: CharacterPromptSection, index: number, relations: Map<number, string[]>): NaiCharacterPrompt | null {
  if (!section.enabled) return null
  const positive = [...atomList(section.atoms), ...(relations.get(index + 1) ?? [])]
  const negative = atomList(section.negativeAtoms).join(', ')
  const view = `${section.view.perspective}_${section.view.composition}` as NaiCharacterPrompt['view']
  return {
    id: `next_${section.id}`,
    name: section.name || `角色 ${index + 1}`,
    text: positive.join(', '),
    enabled: true,
    position: section.position ? { x: section.position.x, y: section.position.y } : null,
    negative_text: negative,
    view,
  }
}

export function toNaiPayload(doc: PromptDoc): NaiPromptPayload {
  const baseBlocks = doc.baseSections
    .map(toBaseBlock)
    .filter((block): block is NaiPromptBlock => Boolean(block))
  const relations = relationBucket(doc)
  const characters = doc.characterSections
    .map((section, index) => toCharacter(section, index, relations))
    .filter((character): character is NaiCharacterPrompt => Boolean(character))
  return { baseBlocks, characters }
}

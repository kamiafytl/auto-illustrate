// E2 配方库 →「选入编辑器」动线（蓝图 §四）：
// 卡片点「选入编辑器」→ 胶囊落入编辑器对应区块，胶囊带来源 id（PromptAtomSource），
// 编辑器里改胶囊=只改本 doc；「写回库」（editor/lib/writeBack.ts）才落数据文件。
// 区块→区（role）映射照抄 PromptEditor.addPaletteItem / addCharacterFromLibrary 语义：
// 画师串(recipe 单选)=替换 artist 区；质量词=替换 quality 区；action/expression/scene/effect=追加主体动作区；
// camera=追加镜头区；clothing/character=进角色区块（无角色区块则新建）。
import type { CharacterPromptSection, PromptAtom, PromptBlock, PromptDoc } from '../editor/types/prompt'
import type { CharacterEntry, RecipeEntry, TagEntry } from '../editor/lib/dataClient'
import {
  buildCharacterAtoms,
  buildNegativeAtoms,
  defaultView,
  makePaletteAtom,
  splitPromptList,
  uid,
  type BaseRole,
  type PaletteItem,
} from '../editor/lib/promptDoc'
import type { LazyShot } from '../../types/lazydog'

export type DocMutator = (doc: PromptDoc) => PromptDoc

function touch(doc: PromptDoc): PromptDoc {
  return { ...doc, meta: { ...doc.meta, updatedAt: new Date().toISOString() } }
}

function baseRoleForBlock(block: PromptBlock): BaseRole | null {
  if (block === 'style' || block === 'sub_style') return 'artist'
  if (block === 'action' || block === 'expression' || block === 'scene' || block === 'effect') return 'action_scene'
  if (block === 'camera') return 'camera'
  return null // clothing / character 走角色区块
}

function mutateBase(doc: PromptDoc, role: BaseRole, mutate: (atoms: PromptAtom[]) => PromptAtom[]): PromptDoc {
  return touch({
    ...doc,
    baseSections: doc.baseSections.map((section) => (section.role === role ? { ...section, atoms: mutate(section.atoms) } : section)),
  })
}

// = PromptEditor.makeEmptyCharacterSection 同款默认值（相机联动/居中 position）
function makeCharacterSection(index: number, patch: Partial<CharacterPromptSection> = {}): CharacterPromptSection {
  return {
    id: uid('character'),
    name: `角色 ${index + 1}`,
    enabled: true,
    view: {
      perspective: defaultView.perspective,
      composition: defaultView.composition,
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

// 追加到第一个角色区块；一个都没有则新建（衣服/角色特征零件的落点）
function appendToCharacterSection(doc: PromptDoc, atoms: PromptAtom[], sectionName: string): PromptDoc {
  if (atoms.length === 0) return doc
  if (doc.characterSections.length === 0) {
    return touch({
      ...doc,
      characterSections: [makeCharacterSection(0, { name: sectionName, atoms })],
    })
  }
  return touch({
    ...doc,
    characterSections: doc.characterSections.map((section, index) =>
      index === 0 ? { ...section, atoms: [...section.atoms, ...atoms] } : section,
    ),
  })
}

function paletteAtomsFor(item: Omit<PaletteItem, 'id'>): PromptAtom[] {
  return splitPromptList(item.text).map((part) => makePaletteAtom({ ...item, id: '', text: part }))
}

/** 配方卡（recipes/*.json 主版）选入：带 {type:'recipe', id} 来源，可写回 */
export function applyRecipe(recipe: RecipeEntry): DocMutator {
  return (doc) => {
    const block = (recipe.block as PromptBlock) || 'style'
    const atoms = paletteAtomsFor({
      kind: 'recipe',
      block,
      category: recipe.category || recipe.group || '未分类',
      title: recipe.name || recipe.id,
      subtitle: recipe.tags,
      text: recipe.tags,
      image: recipe.image,
      source: { type: 'recipe', file: 'recipes', id: recipe.id },
    })
    if (atoms.length === 0) return doc
    const role = baseRoleForBlock(block)
    if (role === 'artist') return mutateBase(doc, 'artist', () => atoms) // 画师串单选：替换（照抄 addPaletteItem）
    if (role) return mutateBase(doc, role, (prev) => [...prev, ...atoms])
    return appendToCharacterSection(doc, atoms, recipe.name || '角色 1')
  }
}

/** tag 词典条目选入：带 {type:'tag', tag} 来源 */
export function applyTag(tag: TagEntry): DocMutator {
  return (doc) => {
    const block = (tag.block as PromptBlock) || 'effect'
    const atoms = paletteAtomsFor({
      kind: 'tag',
      block,
      category: tag.category || '未分类',
      title: tag.tag,
      subtitle: tag.name_zh,
      text: tag.tag,
      source: { type: 'tag', file: 'tags', tag: tag.tag },
    })
    const role = baseRoleForBlock(block)
    if (role) return mutateBase(doc, role, (prev) => [...prev, ...atoms])
    return appendToCharacterSection(doc, atoms, '角色 1')
  }
}

/** nai_config 默认串（权威源，只展示不在库页改）选入：替换对应区（质量词→quality、默认画师串→artist） */
export function applyNaiDefault(text: string, field: string, role: 'quality' | 'artist'): DocMutator {
  return (doc) => {
    const atoms = splitPromptList(text).map((part) =>
      makePaletteAtom({
        id: '',
        kind: 'tag' as const,
        block: 'style' as PromptBlock,
        category: role === 'quality' ? '质量词' : '默认画师串',
        title: part,
        subtitle: '',
        text: part,
        source: { type: 'nai-config' as const, field },
      }),
    )
    if (atoms.length === 0) return doc
    return mutateBase(doc, role, () => atoms)
  }
}

/** 角色卡选入：整段照抄 PromptEditor.addCharacterFromLibrary（默认衣服+负面词+视角联动） */
export function applyCharacter(character: CharacterEntry): DocMutator {
  return (doc) => {
    const outfit = character.outfits.find((item) => item.id === character.default_outfit) ?? character.outfits[0]
    const nextSection = makeCharacterSection(doc.characterSections.length, {
      name: character.name,
      characterId: character.id,
      outfitId: outfit?.id,
      atoms: buildCharacterAtoms(character, outfit, defaultView.perspective, defaultView.composition),
      negativeAtoms: buildNegativeAtoms(character, outfit),
    })
    return touch({ ...doc, characterSections: [...doc.characterSections, nextSection] })
  }
}

/** 角色绑定衣柜（characters.json outfit）选入：整套角色+指定衣服（原则⑦双入口的编辑器落点） */
export function applyOutfit(character: CharacterEntry, outfitId: string): DocMutator {
  return (doc) => {
    const outfit = character.outfits.find((item) => item.id === outfitId)
    if (!outfit) return doc
    const nextSection = makeCharacterSection(doc.characterSections.length, {
      name: `${character.name}·${outfit.name}`,
      characterId: character.id,
      outfitId: outfit.id,
      atoms: buildCharacterAtoms(character, outfit, defaultView.perspective, defaultView.composition),
      negativeAtoms: buildNegativeAtoms(character, outfit),
    })
    return touch({ ...doc, characterSections: [...doc.characterSections, nextSection] })
  }
}

/** 懒狗帧/单图选入：blocks(骨架) 落对应基础区、slots(可换槽原值) 落画师/场景/角色区，全部带 lazydog 来源 */
export function applyLazyShot(shot: LazyShot, title: string): DocMutator {
  return (doc) => {
    let next = doc
    const lazyAtoms = (text: string | undefined, block: PromptBlock, field: string): PromptAtom[] => {
      if (!text?.trim()) return []
      return splitPromptList(text).map((part) =>
        makePaletteAtom({
          id: '',
          kind: 'tag',
          block,
          category: title,
          title: part,
          subtitle: '',
          text: part,
          source: { type: 'lazydog', id: shot.id, field },
        }),
      )
    }

    const artistAtoms = lazyAtoms(shot.slots?.artist, 'style', 'slots.artist')
    if (artistAtoms.length > 0) next = mutateBase(next, 'artist', () => artistAtoms)

    const subjectAtoms = [
      ...lazyAtoms(shot.blocks?.action, 'action', 'blocks.action'),
      ...lazyAtoms(shot.blocks?.expression, 'expression', 'blocks.expression'),
      ...lazyAtoms(shot.blocks?.effect, 'effect', 'blocks.effect'),
      ...lazyAtoms(shot.slots?.scene, 'scene', 'slots.scene'),
      ...lazyAtoms(shot.slots?.props, 'effect', 'slots.props'),
    ]
    if (subjectAtoms.length > 0) next = mutateBase(next, 'action_scene', (prev) => [...prev, ...subjectAtoms])

    const cameraAtoms = lazyAtoms(shot.blocks?.camera, 'camera', 'blocks.camera')
    if (cameraAtoms.length > 0) next = mutateBase(next, 'camera', (prev) => [...prev, ...cameraAtoms])

    const charAtoms = [
      ...lazyAtoms(shot.slots?.character, 'character', 'slots.character'),
      ...lazyAtoms(shot.slots?.clothing, 'clothing', 'slots.clothing'),
    ]
    if (charAtoms.length > 0) next = appendToCharacterSection(next, charAtoms, title)

    const maleText = shot.slots?.male?.trim()
    if (maleText) {
      const maleAtoms = maleText
        .split('||')
        .map((part) => part.trim())
        .filter(Boolean)
        .flatMap((caption) => lazyAtoms(caption, 'character', 'slots.male'))
      if (maleAtoms.length > 0) {
        next = touch({
          ...next,
          characterSections: [...next.characterSections, makeCharacterSection(next.characterSections.length, { name: `${title}·男角`, atoms: maleAtoms })],
        })
      }
    }
    return next === doc ? doc : next
  }
}

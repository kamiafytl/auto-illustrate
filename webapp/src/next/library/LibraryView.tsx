// E2 配方库（Owner 三大分类 IA·蓝图=internal-docs）：
// 骨相=整页照抄旧配方库（四问）：上=壳子黑条导航→大搜索框→蓝大类横幅→浅蓝中类横幅→卡片流；
// 左=侧栏（大类 chips + 两级树 + 计数右对齐，照抄 Sidebar.tsx nav 三级导航，block 层换三大类）；
// 大小=主区约 4/5；点=卡片绿钮复制、橙钮位「选入编辑器」（cart 已废，差异点2）。
// 纯 UI 分组：数据文件零合并零搬家（原料=recipes/*+nai_config+tags/*；懒狗=lazydog/*；角色=characters.json）。
import { useMemo, useState } from 'react'
import type { StudioDataState } from '../editor/lib/useStudioData'
import { useCharacters } from '../../hooks/useCharacters'
import { CharactersPane } from './CharactersPane'
import { LazyWallPane } from './LazyWallPane'
import { MaterialsPane, extractNaiDefaults } from './MaterialsPane'
import { scrollToAnchor, slugId } from './parts'
import type { DocMutator } from './selectToEditor'
import { useLazyLibrary } from './useLazyLibrary'
import './library.css'

type MajorId = 'materials' | 'lazydog' | 'characters'

type TreeGroup = { name: string; count: number }
type TreeMid = { id: string; name: string; count: number; groups: TreeGroup[] }

const MAJORS: { id: MajorId; label: string }[] = [
  { id: 'materials', label: '原料' },
  { id: 'lazydog', label: '懒狗库' },
  { id: 'characters', label: '角色' },
]

export default function LibraryView({ state, onApplyToEditor }: {
  state: StudioDataState
  onApplyToEditor: (mutator: DocMutator) => void
}) {
  const [major, setMajor] = useState<MajorId>('materials')
  const [search, setSearch] = useState('')
  const [activeNav, setActiveNav] = useState<{ mid: string; group: string }>({ mid: '', group: '' })
  const [expandedMids, setExpandedMids] = useState<Set<string>>(new Set())
  const { characters } = useCharacters()
  const lazy = useLazyLibrary(true)

  const ready = state.status === 'ready'
  const recipes = ready ? state.recipes : []
  const tags = ready ? state.tags : []
  const naiConfig = ready ? state.naiConfig : {}

  // —— 侧栏两级树（计数右对齐；照抄 Sidebar 的 cat/group 结构，数据换三大类） ——
  const tree = useMemo<Record<MajorId, TreeMid[]>>(() => {
    const groupCounts = (list: { key: string; count: number }[]): TreeGroup[] => list.map((entry) => ({ name: entry.key, count: entry.count }))
    const countBy = <T,>(items: T[], keyOf: (item: T) => string): { key: string; count: number }[] => {
      const order: string[] = []
      const map = new Map<string, number>()
      for (const item of items) {
        const key = keyOf(item) || '未分组'
        if (!map.has(key)) order.push(key)
        map.set(key, (map.get(key) ?? 0) + 1)
      }
      return order.map((key) => ({ key, count: map.get(key)! }))
    }

    const artists = recipes.filter((recipe) => recipe.block === 'style')
    const clothing = recipes.filter((recipe) => recipe.block === 'clothing')
    const scenes = recipes.filter((recipe) => recipe.block === 'scene')
    const effects = recipes.filter((recipe) => recipe.block === 'effect')
    const legacy = recipes.filter((recipe) => recipe.block === 'action' || recipe.block === 'expression')
    const naiDefaults = extractNaiDefaults(naiConfig)
    const boundOutfits = characters.flatMap((character) => character.outfits.map(() => character.name))

    const materials: TreeMid[] = [
      { id: 'artist', name: '画师串', count: artists.length, groups: groupCounts(countBy(artists, (recipe) => recipe.category)) },
      { id: 'quality', name: '质量词', count: naiDefaults.length, groups: [] },
      {
        id: 'clothing',
        name: '衣服',
        count: clothing.length + boundOutfits.length,
        groups: [
          ...groupCounts(countBy(clothing, (recipe) => recipe.group)).map((group) => ({ ...group, name: `通用 · ${group.name}` })),
          ...groupCounts(countBy(boundOutfits, (name) => name)).map((group) => ({ ...group, name: `角色绑定 · ${group.name}` })),
        ],
      },
      { id: 'scene', name: '场景', count: scenes.length, groups: [] },
      { id: 'effect', name: '特殊效果', count: effects.length, groups: [] },
      { id: 'tags', name: 'tag词典', count: tags.length, groups: groupCounts(countBy(tags, (tag) => String(tag.block))) },
      { id: 'legacy', name: 'legacy存档', count: legacy.length, groups: [] },
    ]

    const lazydog: TreeMid[] = [
      { id: 'sets', name: '套图·复刻', count: lazy.sets.filter((set) => !set.trashed).length, groups: [] },
      { id: 'std', name: '套图·标准', count: lazy.comps.filter((comp) => comp.type === 'standard' && !comp.trashed).length, groups: [] },
      { id: 'orig', name: '套图·原创', count: lazy.comps.filter((comp) => comp.type === 'original' && !comp.trashed).length, groups: [] },
      { id: 'shots', name: '单图', count: lazy.shots.filter((shot) => !shot.trashed && !shot.clip).length, groups: [] },
    ]

    const characterMids: TreeMid[] = characters.map((character) => ({
      id: character.id,
      name: character.name || '未命名',
      count: character.outfits.length,
      groups: [],
    }))

    return { materials, lazydog, characters: characterMids }
  }, [recipes, tags, naiConfig, characters, lazy])

  const majorCounts: Record<MajorId, number> = {
    materials: tree.materials.reduce((sum, mid) => sum + mid.count, 0),
    lazydog: tree.lazydog.reduce((sum, mid) => sum + mid.count, 0),
    characters: characters.length,
  }

  // 中类里 tag词典 的 group 锚点在 TagDictSection 内没逐组挂 id，group 点击就近落中类头
  const navTo = (mid: string, group?: string) => {
    setActiveNav({ mid, group: group ?? '' })
    const anchorId = group && major === 'materials' && (mid === 'artist' || mid === 'clothing')
      ? slugId(major, mid, group.replace(/^通用 · /, '').replace(/^角色绑定 · (.+)$/, '角色绑定·$1'))
      : slugId(major, mid)
    scrollToAnchor(anchorId)
  }

  const toggleMid = (mid: string) => {
    setExpandedMids((current) => {
      const next = new Set(current)
      if (next.has(mid)) next.delete(mid)
      else next.add(mid)
      return next
    })
  }

  return (
    <div className="lib-layout">
      {/* 侧栏（窄）：大类 chips + 两级树 + 计数右对齐 */}
      <aside className="lib-sidebar">
        <div className="lib-sidebar-header">
          <span className="lib-sidebar-title">目录导航</span>
        </div>
        <div className="lib-sb-blocks">
          {MAJORS.map((entry) => (
            <button
              key={entry.id}
              className={`lib-sb-block-btn ${major === entry.id ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setMajor(entry.id)
                setActiveNav({ mid: '', group: '' })
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            >
              {entry.label}
              <span className="lib-count">{majorCounts[entry.id]}</span>
            </button>
          ))}
        </div>
        <nav className="lib-tree">
          {tree[major].map((mid) => (
            <div key={mid.id}>
              <button
                className={`lib-cat-btn ${activeNav.mid === mid.id ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  if (mid.groups.length > 0) toggleMid(mid.id)
                  navTo(mid.id)
                }}
              >
                <span className="lib-cat-arrow">{mid.groups.length > 0 ? (expandedMids.has(mid.id) ? '▾' : '▸') : ''}</span>
                <span className="lib-cat-name">{mid.name}</span>
                <span className="lib-count">{mid.count}</span>
              </button>
              {mid.groups.length > 0 && expandedMids.has(mid.id) && (
                <div className="lib-groups">
                  {mid.groups.map((group) => (
                    <button
                      key={group.name}
                      className={`lib-group-btn ${activeNav.mid === mid.id && activeNav.group === group.name ? 'active' : ''}`}
                      type="button"
                      onClick={() => navTo(mid.id, group.name)}
                    >
                      <span className="lib-group-name">{group.name}</span>
                      <span className="lib-count">{group.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="lib-sb-footer">
          <button className="lib-scroll-top" type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            ↑ 回到顶部
          </button>
        </div>
      </aside>

      {/* 主区（宽·约 4/5）：大搜索框 → 大类横幅 → 中类横幅 → 卡片流/图墙 */}
      <div className="lib-content">
        <div className="lib-search">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={major === 'materials' ? '搜索原料（name / tags / 备注）...' : major === 'lazydog' ? '搜索懒狗库（套图名 / 帧名 / 标签）...' : '搜索角色 / 衣服...'}
          />
          {search && (
            <button className="lib-search-clear" type="button" onClick={() => setSearch('')}>×</button>
          )}
        </div>

        {!ready && <p className="lib-empty-hint">库数据加载中…</p>}
        {ready && major === 'materials' && (
          <MaterialsPane data={{ recipes, tags, characters, naiConfig }} search={search} onApply={onApplyToEditor} />
        )}
        {major === 'lazydog' && <LazyWallPane lazy={lazy} search={search} onApply={onApplyToEditor} />}
        {major === 'characters' && <CharactersPane search={search} onApply={onApplyToEditor} />}
      </div>
    </div>
  )
}

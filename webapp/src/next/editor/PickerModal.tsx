import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { PromptBlock, PromptSection } from './types/prompt'
import { normalizedImagePath, thumbnailFor } from './lib/thumbs'

export type PickerMode = 'tag' | 'recipe' | 'character' | 'outfit'

export type PickerSectionConfig = {
  role: PromptSection['role']
  title: string
  blocks: PromptBlock[]
  mode: PickerMode
}

export type PickerItem = {
  id: string
  kind: 'tag' | 'recipe' | 'character' | 'outfit'
  block: PromptBlock
  category: string
  title: string
  subtitle: string
  text: string
  image?: string | null
}

export type PickerBlockMeta = {
  label: string
  color: string
}

export type PickerArea = 'action' | 'concept' | 'expression' | 'scene' | 'effect'

type CategoryCard<TItem extends PickerItem> = {
  id: string
  title: string
  area: PickerArea
  items: TItem[]
  imageKey: string
  thumbnail?: string | null
}

type PickerModalProps<TItem extends PickerItem> = {
  section: PickerSectionConfig
  items: TItem[]
  imagePaths: string[]
  tagThumbs: Record<string, string | null>
  blockMeta: Record<PromptBlock, PickerBlockMeta>
  lockedArea?: PickerArea
  onPick: (item: TItem) => void
  onClose: () => void
}

const actionSceneAreas: { id: PickerArea; title: string }[] = [
  { id: 'concept', title: '概念' },
  { id: 'action', title: '动作' },
  { id: 'expression', title: '表情' },
  { id: 'scene', title: '场景' },
  { id: 'effect', title: '其他效果' },
]

function areaForItem(item: PickerItem, section: PickerSectionConfig): PickerArea {
  if (section.role !== 'action_scene') return 'action'
  if (item.category.includes('概念') || /concept/i.test(item.category)) return 'concept'
  if (item.block === 'action') return 'action'
  if (item.block === 'expression') return 'expression'
  if (item.block === 'scene') return 'scene'
  if (item.block === 'effect') return 'effect'
  return 'action'
}

// 解析分类名开头的价值轴标记，如 "[+3] 极端" → 3、"[-2] 负面" → -2、"[0] 中性" → 0
function valenceOf(title: string): number | null {
  const match = title.match(/^\[([+-]?\d+)\]/)
  return match ? Number(match[1]) : null
}

function matchesQuery(item: PickerItem, query: string, blockMeta: Record<PromptBlock, PickerBlockMeta>): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return [item.title, item.subtitle, item.category, blockMeta[item.block].label, item.kind]
    .join(' ')
    .toLocaleLowerCase()
    .includes(normalizedQuery)
}

function buildCategories<TItem extends PickerItem>(items: TItem[], section: PickerSectionConfig): CategoryCard<TItem>[] {
  const groups = new Map<string, CategoryCard<TItem>>()
  for (const item of items) {
    const area = areaForItem(item, section)
    const id = `${area}:${item.category || item.block}`
    const existing = groups.get(id)
    if (existing) {
      existing.items.push(item)
      if (!existing.thumbnail && normalizedImagePath(item.image)) existing.thumbnail = normalizedImagePath(item.image)
      continue
    }
    groups.set(id, {
      id,
      title: item.category || item.block,
      area,
      items: [item],
      imageKey: `${section.role}:${area}:${item.category || item.block}`,
      thumbnail: normalizedImagePath(item.image),
    })
  }

  return Array.from(groups.values()).sort((left, right) => {
    // 表情等带 [±N] 价值轴前缀的分类，按 -3→+3 数值升序；其余按中文排序
    const leftValence = valenceOf(left.title)
    const rightValence = valenceOf(right.title)
    if (leftValence !== null && rightValence !== null) return leftValence - rightValence
    if (leftValence !== null) return -1
    if (rightValence !== null) return 1
    return left.title.localeCompare(right.title, 'zh-Hans-CN')
  })
}

// 密集 tag：默认是 Excel 式「英文列 | 中文列」对齐的列表行；缩略图改为跟随鼠标的浮层(不再遮挡标题/其他行)
function TagRow<TItem extends PickerItem>({
  item,
  imagePaths,
  tagThumbs,
  blockMeta,
  picked,
  onPick,
  onHoverThumb,
}: {
  item: TItem
  imagePaths: string[]
  tagThumbs: Record<string, string | null>
  blockMeta: Record<PromptBlock, PickerBlockMeta>
  picked: boolean
  onPick: (item: TItem) => void
  onHoverThumb: (url: string | null, x: number, y: number) => void
}) {
  const thumbnail = thumbnailFor(item, imagePaths, tagThumbs)
  const zh = item.kind === 'tag' ? item.subtitle || '待译' : item.category || ''
  return (
    <button
      className={`picker-tag-row ${picked ? 'is-picked' : ''}`}
      type="button"
      onClick={() => onPick(item)}
      title={`${item.title}　${zh}`}
      onMouseMove={(event) => onHoverThumb(thumbnail, event.clientX, event.clientY)}
      onMouseLeave={() => onHoverThumb(null, 0, 0)}
    >
      <span className="ptr-bar" style={{ backgroundColor: blockMeta[item.block].color }} />
      <span className="ptr-en">{item.title}</span>
      <span className="ptr-zh">{zh}</span>
      {picked && <span className="ptr-added">✓ 已添加</span>}
    </button>
  )
}

// recipe/角色/衣服：有意义的封面图 → 卡片
function PickerItemCard<TItem extends PickerItem>({
  item,
  imagePaths,
  tagThumbs,
  blockMeta,
  picked,
  onPick,
}: {
  item: TItem
  imagePaths: string[]
  tagThumbs: Record<string, string | null>
  blockMeta: Record<PromptBlock, PickerBlockMeta>
  picked: boolean
  onPick: (item: TItem) => void
}) {
  const thumbnail = thumbnailFor(item, imagePaths, tagThumbs)
  return (
    <button className={`picker-item-card ${picked ? 'is-picked' : ''}`} type="button" onClick={() => onPick(item)} title={item.subtitle ? `${item.title} / ${item.subtitle}` : item.title}>
      {picked && <span className="picker-picked-badge">✓ 已添加</span>}
      <span className="picker-color-strip" style={{ backgroundColor: blockMeta[item.block].color }} />
      <span className="picker-thumb-wrap">
        {thumbnail ? (
          <img src={thumbnail} alt="" loading="lazy" />
        ) : (
          <span className="picker-thumb-fallback">{blockMeta[item.block].label.slice(0, 2)}</span>
        )}
        <span className="picker-card-label">
          <strong>{item.title}</strong>
          <small>{item.kind === 'tag' ? item.subtitle || '待译' : item.category || ''}</small>
        </span>
      </span>
    </button>
  )
}

// 一个中类分组：标题(中类名+数量) + 组内条目(tag=列表行 / recipe=卡片)，分门别类、上下区分，不再层层窗口
function PickerGroup<TItem extends PickerItem>({
  group,
  mode,
  imagePaths,
  tagThumbs,
  blockMeta,
  justPickedId,
  onPick,
  onHoverThumb,
}: {
  group: CategoryCard<TItem>
  mode: PickerMode
  imagePaths: string[]
  tagThumbs: Record<string, string | null>
  blockMeta: Record<PromptBlock, PickerBlockMeta>
  justPickedId: string | null
  onPick: (item: TItem) => void
  onHoverThumb: (url: string | null, x: number, y: number) => void
}) {
  const accent = blockMeta[group.items[0].block]?.color
  // 中类代表缩略图：直接显示在标题上(不悬浮)，一眼认出这组是什么(图4)
  const headThumb = group.thumbnail ?? group.items.map((item) => thumbnailFor(item, imagePaths, tagThumbs)).find(Boolean) ?? null
  return (
    <section className="picker-group">
      <h3 className="picker-group-head" style={{ '--group-accent': accent } as CSSProperties}>
        {headThumb && <img className="picker-group-thumb" src={headThumb} alt="" loading="lazy" />}
        <span>{group.title}</span>
        <em>{group.items.length}</em>
      </h3>
      {mode === 'tag' ? (
        <div className="picker-tag-table">
          {group.items.map((item) => (
            <TagRow item={item} imagePaths={imagePaths} tagThumbs={tagThumbs} blockMeta={blockMeta} picked={item.id === justPickedId} key={item.id} onPick={onPick} onHoverThumb={onHoverThumb} />
          ))}
        </div>
      ) : (
        <div className="picker-item-grid">
          {group.items.map((item) => (
            <PickerItemCard item={item} imagePaths={imagePaths} tagThumbs={tagThumbs} blockMeta={blockMeta} picked={item.id === justPickedId} key={item.id} onPick={onPick} />
          ))}
        </div>
      )}
    </section>
  )
}

export function PickerModal<TItem extends PickerItem>({
  section,
  items,
  imagePaths,
  tagThumbs,
  blockMeta,
  lockedArea,
  onPick,
  onClose,
}: PickerModalProps<TItem>) {
  const isActionScene = section.role === 'action_scene'
  const [query, setQuery] = useState('')
  const resolvedLockedArea = isActionScene ? (lockedArea ?? null) : null
  const [activeArea, setActiveArea] = useState<PickerArea | null>(resolvedLockedArea)
  const [justPickedId, setJustPickedId] = useState<string | null>(null)
  const [hoverThumb, setHoverThumb] = useState<{ url: string; x: number; y: number } | null>(null)

  // 缩略图跟随鼠标：放在光标右下方并夹住视口边界，永不被标题/其他行遮住(图1)
  const handleHoverThumb = (url: string | null, x: number, y: number) => {
    if (!url) {
      setHoverThumb(null)
      return
    }
    const size = 168
    const left = Math.min(x + 18, window.innerWidth - size - 12)
    const top = Math.min(Math.max(y + 18, 12), window.innerHeight - size - 12)
    setHoverThumb({ url, x: left, y: top })
  }

  // 点击添加后给明显的「✓ 已添加」高亮反馈
  const handlePick = (item: TItem) => {
    setJustPickedId(item.id)
    onPick(item)
    window.setTimeout(() => setJustPickedId((current) => (current === item.id ? null : current)), 700)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // 各区域条目数（action_scene 的顶部 tab 用）
  const areaCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    if (!isActionScene) return counts
    for (const item of items) {
      const area = areaForItem(item, section)
      counts[area] = (counts[area] ?? 0) + 1
    }
    return counts
  }, [isActionScene, items, section])

  // action_scene 默认选中锁定区域或第一个有内容的区域（顶部 tab，不再点卡进窗口）
  useEffect(() => {
    if (!isActionScene) return
    if (resolvedLockedArea) {
      setActiveArea(resolvedLockedArea)
      return
    }
    setActiveArea((current) => current ?? actionSceneAreas.find((area) => (areaCounts[area.id] ?? 0) > 0)?.id ?? null)
  }, [isActionScene, resolvedLockedArea, areaCounts])

  const scopedItems = useMemo(
    () => (isActionScene && activeArea ? items.filter((item) => areaForItem(item, section) === activeArea) : items),
    [isActionScene, activeArea, items, section],
  )
  const searchedItems = useMemo(() => scopedItems.filter((item) => matchesQuery(item, query, blockMeta)), [scopedItems, blockMeta, query])
  const groups = useMemo(() => buildCategories(searchedItems, section), [searchedItems, section])
  const totalCount = scopedItems.length

  return (
    <div className="picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="picker-modal" role="dialog" aria-modal="true" aria-label={section.title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="picker-head">
          <div>
            <h2>{section.title}</h2>
            <p>{totalCount} 个可选条目</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭选择器" onClick={onClose}>
            ×
          </button>
        </header>

        <input className="picker-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 tag / 中文名 / 分类" autoFocus />

        {isActionScene && !resolvedLockedArea && (
          <div className="picker-area-tabs" role="tablist" aria-label="主体动作区域">
            {actionSceneAreas.map((area) => (
              <button
                className={activeArea === area.id ? 'is-active' : ''}
                type="button"
                role="tab"
                key={area.id}
                disabled={(areaCounts[area.id] ?? 0) === 0}
                onClick={() => setActiveArea(area.id)}
              >
                {area.title}
                <em>{areaCounts[area.id] ?? 0}</em>
              </button>
            ))}
          </div>
        )}

        <div className="picker-scroll">
          {groups.length === 0 ? (
            <div className="picker-empty">无匹配条目</div>
          ) : (
            groups.map((group) => (
              <PickerGroup
                group={group}
                mode={section.mode}
                imagePaths={imagePaths}
                tagThumbs={tagThumbs}
                blockMeta={blockMeta}
                justPickedId={justPickedId}
                key={group.id}
                onPick={handlePick}
                onHoverThumb={handleHoverThumb}
              />
            ))
          )}
        </div>
      </section>
      {hoverThumb && (
        <div className="picker-hover-thumb" style={{ left: hoverThumb.x, top: hoverThumb.y }}>
          <img src={hoverThumb.url} alt="" />
        </div>
      )}
    </div>
  )
}

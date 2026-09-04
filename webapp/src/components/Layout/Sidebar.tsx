import { useState, useEffect, useMemo } from 'react'
import type { Recipe } from '../../types'
import { BLOCK_ORDER, BLOCK_LABELS, type PromptBlock } from '../../types'

interface SidebarProps {
  recipes: Recipe[]
  activeBlock: string
  activeCategory: string
  activeGroup: string
  onNav: (patch: { block?: string; category?: string; group?: string }) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

const blockLabels: Record<string, string> = BLOCK_LABELS

export default function Sidebar({
  recipes, activeBlock, activeCategory, activeGroup,
  onNav, collapsed, onToggleCollapse
}: SidebarProps) {
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set())

  // 构建导航树
  const tree = useMemo(() => {
    const blockRecipes = recipes.filter(r => r.block === activeBlock)
    const catMap: Record<string, Record<string, number>> = {}
    for (const r of blockRecipes) {
      if (!catMap[r.category]) catMap[r.category] = {}
      catMap[r.category][r.group] = (catMap[r.category][r.group] || 0) + 1
    }
    return Object.entries(catMap).map(([cat, groups]) => ({
      category: cat,
      count: Object.values(groups).reduce((a, b) => a + b, 0),
      groups: Object.entries(groups).map(([group, count]) => ({ group, count }))
    }))
  }, [recipes, activeBlock])

  // block切换时，自动展开活跃category
  useEffect(() => {
    if (activeCategory) {
      setExpandedCats(prev => new Set([...prev, activeCategory]))
    }
  }, [activeCategory])

  const blocks = useMemo(() => {
    const existing = new Set<string>()
    for (const r of recipes) existing.add(r.block)
    // 按BLOCK_ORDER排序，再追加不在ORDER中的block
    const ordered = BLOCK_ORDER.filter(b => existing.has(b)) as string[]
    for (const b of existing) {
      if (!BLOCK_ORDER.includes(b as PromptBlock)) ordered.push(b)
    }
    return ordered
  }, [recipes])

  const blockCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of recipes) counts[r.block] = (counts[r.block] || 0) + 1
    return counts
  }, [recipes])

  const toggleCat = (cat: string) => {
    setExpandedCats(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const handleGroupClick = (cat: string, group: string) => {
    onNav({ category: cat, group })
    // scroll到对应区域
    const el = document.getElementById(`group-${cat}-${group}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <button className="sidebar-expand-btn" onClick={onToggleCollapse} title="展开目录">
          ▸
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">目录导航</span>
        <button className="sidebar-collapse-btn" onClick={onToggleCollapse} title="折叠目录">
          ◂
        </button>
      </div>

      {/* Block选择 */}
      <div className="sidebar-blocks">
        {blocks.map(b => (
          <button
            key={b}
            className={`sidebar-block-btn ${activeBlock === b ? 'active' : ''}`}
            onClick={() => {
              const blockRecipes = recipes.filter(r => r.block === b)
              const firstCat = blockRecipes[0]?.category || ''
              const firstGroup = blockRecipes[0]?.group || ''
              onNav({ block: b, category: firstCat, group: firstGroup })
            }}
          >
            {blockLabels[b] || b}
            <span className="sidebar-count">{blockCounts[b] || 0}</span>
          </button>
        ))}
      </div>

      {/* Category + Group 树 */}
      <nav className="sidebar-tree">
        {tree.map(({ category, count, groups }) => (
          <div key={category} className="sidebar-cat">
            <button
              className={`sidebar-cat-btn ${activeCategory === category ? 'active' : ''}`}
              onClick={() => {
                toggleCat(category)
                const firstGroup = groups[0]?.group || ''
                onNav({ category, group: firstGroup })
              }}
            >
              <span className="sidebar-cat-arrow">{expandedCats.has(category) ? '▾' : '▸'}</span>
              <span className="sidebar-cat-name">{category}</span>
              <span className="sidebar-count">{count}</span>
            </button>
            {expandedCats.has(category) && (
              <div className="sidebar-groups">
                {groups.map(({ group, count: groupCount }) => (
                  <button
                    key={group}
                    className={`sidebar-group-btn ${activeCategory === category && activeGroup === group ? 'active' : ''}`}
                    onClick={() => handleGroupClick(category, group)}
                  >
                    <span className="sidebar-group-name">{group}</span>
                    <span className="sidebar-count">{groupCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* 回到顶部 */}
      <div className="sidebar-footer">
        <button className="sidebar-scroll-top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          ↑ 回到顶部
        </button>
      </div>
    </aside>
  )
}

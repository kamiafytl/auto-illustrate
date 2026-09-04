import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { TagEntry } from '../../types'
import { BLOCK_LABELS, type PromptBlock } from '../../types'
import { useNavMemory } from '../../hooks/useNavMemory'
import SearchBar from '../common/SearchBar'
import { copyText } from '../../utils/clipboard'

interface TagDictionaryProps {
  tags: TagEntry[]
  onEdit: (tag: TagEntry) => void
  onDelete: (tag: string, block: string) => void
  onAddToCart: (tag: TagEntry) => void
  onTagsChange: (tags: TagEntry[] | ((prev: TagEntry[]) => TagEntry[])) => void
}

const ALL_CATEGORY = '__all__'

export default function TagDictionary({ tags, onEdit, onDelete, onAddToCart, onTagsChange }: TagDictionaryProps) {
  const [search, setSearch] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  // 双击编辑状态
  const [editingCell, setEditingCell] = useState<{ key: string; field: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // 拖拽状态（实时排序）
  const originalTagsRef = useRef<TagEntry[]>([])
  const dragInfoRef = useRef<{
    type: 'category' | 'tag'; sourceId: string; block: string
  } | null>(null)

  const { blocks, categoriesByBlock } = useMemo(() => {
    const blockSet = new Set<string>()
    const catMap: Record<string, Set<string>> = {}
    for (const t of tags) {
      blockSet.add(t.block)
      if (!catMap[t.block]) catMap[t.block] = new Set()
      catMap[t.block].add(t.category)
    }
    return {
      blocks: Array.from(blockSet),
      categoriesByBlock: Object.fromEntries(
        Object.entries(catMap).map(([k, v]) => {
          const firstIdx: Record<string, number> = {}
          tags.forEach((t, i) => {
            if (t.block === k && !(t.category in firstIdx)) firstIdx[t.category] = i
          })
          return [k, Array.from(v).sort((a, b) => (firstIdx[a] ?? 999) - (firstIdx[b] ?? 999))]
        })
      )
    }
  }, [tags])

  const [nav, setNav] = useNavMemory('tags', {
    block: blocks[0] || 'expression',
    category: ALL_CATEGORY,
  })

  useEffect(() => {
    if (blocks.length === 0) return
    let currentBlock = nav.block
    if (!blocks.includes(currentBlock)) currentBlock = blocks[0]
    const cats = categoriesByBlock[currentBlock] || []
    let currentCat = nav.category
    if (currentCat !== ALL_CATEGORY && cats.length > 0 && !cats.includes(currentCat)) {
      currentCat = ALL_CATEGORY
    }
    if (currentBlock !== nav.block || currentCat !== nav.category) {
      setNav({ block: currentBlock, category: currentCat })
    }
  }, [blocks, categoriesByBlock, nav.block, nav.category, setNav])

  const currentCategories = categoriesByBlock[nav.block] || []
  const isAllView = nav.category === ALL_CATEGORY

  const blockCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of tags) counts[t.block] = (counts[t.block] || 0) + 1
    return counts
  }, [tags])

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    const list = tags.filter(t => t.block === nav.block)
    for (const t of list) counts[t.category] = (counts[t.category] || 0) + 1
    return counts
  }, [tags, nav.block])

  const groupedTags = useMemo(() => {
    if (!isAllView) return null
    let list = tags.filter(t => t.block === nav.block)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(t =>
        t.tag.toLowerCase().includes(q) ||
        t.name_zh.toLowerCase().includes(q) ||
        t.note.toLowerCase().includes(q)
      )
    }
    const groups: { category: string; tags: TagEntry[] }[] = []
    const catOrder = categoriesByBlock[nav.block] || []
    for (const cat of catOrder) {
      const catTags = list.filter(t => t.category === cat)
      if (catTags.length > 0) groups.push({ category: cat, tags: catTags })
    }
    return groups
  }, [isAllView, tags, nav.block, search, categoriesByBlock])

  const filteredTags = useMemo(() => {
    if (isAllView) return []
    let list = tags.filter(t => t.block === nav.block && t.category === nav.category)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(t =>
        t.tag.toLowerCase().includes(q) ||
        t.name_zh.toLowerCase().includes(q) ||
        t.note.toLowerCase().includes(q)
      )
    }
    return list
  }, [isAllView, tags, nav.block, nav.category, search])

  const handleCopy = useCallback(async (tag: TagEntry) => {
    await copyText(tag.tag)
    const key = tag.tag + ':' + tag.block
    setCopiedKey(key)
    setToast(`已复制: ${tag.name_zh}`)
    setTimeout(() => { setCopiedKey(null); setToast('') }, 1500)
  }, [])

  const shortLabel = (cat: string) => cat.replace(/^\[([^\]]+)\].*$/, '$1')

  // === 双击编辑 ===
  const startEdit = (key: string, field: string, value: string) => {
    setEditingCell({ key, field })
    setEditValue(value)
    setTimeout(() => editInputRef.current?.focus(), 0)
  }

  const commitEdit = async () => {
    if (!editingCell) return
    const { key, field } = editingCell

    if (field === 'categoryName') {
      // 重命名category
      const oldCat = key // key is the category name
      const newCat = editValue.trim()
      if (newCat && newCat !== oldCat) {
        try {
          await fetch('/api/rename-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ block: nav.block, oldCategory: oldCat, newCategory: newCat })
          })
          onTagsChange(prev => prev.map(t =>
            t.block === nav.block && t.category === oldCat ? { ...t, category: newCat } : t
          ))
        } catch (err) {
          console.error('重命名失败:', err)
        }
      }
    } else {
      // 编辑tag的name_zh或tag字段
      const [tagId, block] = key.split('::')
      const tagEntry = tags.find(t => t.tag === tagId && t.block === block)
      if (tagEntry) {
        const updated = { ...tagEntry, [field]: editValue.trim() }
        try {
          await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'tags', data: updated, old: tagEntry })
          })
          onTagsChange(prev => prev.map(t =>
            t.tag === tagEntry.tag && t.block === tagEntry.block ? updated : t
          ))
        } catch (err) {
          console.error('编辑失败:', err)
        }
      }
    }
    setEditingCell(null)
  }

  const cancelEdit = () => setEditingCell(null)

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    if (e.key === 'Escape') cancelEdit()
  }

  // === 拖拽排序（实时移动） ===
  const saveBlockTags = async (block: string, newTags: TagEntry[]) => {
    try {
      await fetch('/api/reorder-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ block, tags: newTags })
      })
    } catch (err) {
      console.error('保存排序失败:', err)
    }
  }

  const handleCatDragStart = (e: React.DragEvent, category: string) => {
    originalTagsRef.current = [...tags]
    dragInfoRef.current = { type: 'category', sourceId: category, block: nav.block }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', category)
    ;(e.currentTarget as HTMLElement).style.opacity = '0.4'
  }

  const handleCatDragOver = (e: React.DragEvent, targetCat: string) => {
    const info = dragInfoRef.current
    if (!info || info.type !== 'category' || info.sourceId === targetCat) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const block = info.block
    const blockTags = tags.filter(t => t.block === block)
    const seen = new Set<string>(); const catOrder: string[] = []
    for (const t of blockTags) { if (!seen.has(t.category)) { seen.add(t.category); catOrder.push(t.category) } }
    const srcIdx = catOrder.indexOf(info.sourceId)
    const tgtIdx = catOrder.indexOf(targetCat)
    if (srcIdx === -1 || tgtIdx === -1) return
    // 网格布局用直接交换（手机app效果）：鼠标到target上→source和target交换位置
    // 交换后source元素在target旧位置（鼠标下方），自然防止振荡
    const newOrder = [...catOrder]
    newOrder[srcIdx] = catOrder[tgtIdx]
    newOrder[tgtIdx] = catOrder[srcIdx]
    if (newOrder.join() === catOrder.join()) return
    const reordered: TagEntry[] = []
    for (const cat of newOrder) reordered.push(...blockTags.filter(t => t.category === cat))
    onTagsChange(prev => [...prev.filter(t => t.block !== block), ...reordered])
  }

  const handleCatDrop = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleTagDragStart = (e: React.DragEvent, tag: TagEntry) => {
    e.stopPropagation()
    originalTagsRef.current = [...tags]
    dragInfoRef.current = { type: 'tag', sourceId: `${tag.tag}::${tag.block}`, block: tag.block }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tag.tag)
    ;(e.currentTarget as HTMLElement).style.opacity = '0.4'
  }

  const handleTagDragOver = (e: React.DragEvent, targetTag: TagEntry) => {
    const info = dragInfoRef.current
    if (!info || info.type !== 'tag') return
    const [srcId, srcBlock] = info.sourceId.split('::')
    if (srcBlock !== targetTag.block || srcId === targetTag.tag) return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const block = targetTag.block
    const blockTags = tags.filter(t => t.block === block)
    const srcIdx = blockTags.findIndex(t => t.tag === srcId)
    if (srcIdx === -1) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const insertBefore = e.clientY < rect.top + rect.height / 2
    const src = blockTags[srcIdx]
    const without = blockTags.filter((_, i) => i !== srcIdx)
    let ins = without.findIndex(t => t.tag === targetTag.tag && t.block === targetTag.block)
    if (!insertBefore) ins += 1
    without.splice(ins, 0, src)
    if (without.map(t => t.tag).join() === blockTags.map(t => t.tag).join()) return
    onTagsChange(prev => [...prev.filter(t => t.block !== block), ...without])
  }

  const handleTagDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
  }

  const handleDragEnd = async (e: React.DragEvent) => {
    ;(e.currentTarget as HTMLElement).style.opacity = ''
    const info = dragInfoRef.current
    if (info) {
      // 比较当前block的tags和原始状态，有变化就保存（不依赖drop事件）
      const block = info.block
      const currentBlockTags = tags.filter(t => t.block === block)
      const originalBlockTags = originalTagsRef.current.filter(t => t.block === block)
      const currentKeys = currentBlockTags.map(t => `${t.tag}:${t.category}`).join(',')
      const originalKeys = originalBlockTags.map(t => `${t.tag}:${t.category}`).join(',')
      if (currentKeys !== originalKeys) {
        await saveBlockTags(block, currentBlockTags)
      }
    }
    dragInfoRef.current = null
  }

  // === 渲染 ===
  const renderTagRow = (tag: TagEntry) => {
    const rowKey = tag.tag + ':' + tag.block
    const editKey = `${tag.tag}::${tag.block}`

    return (
      <tr
        key={rowKey}
        className={copiedKey === rowKey ? 'copied' : ''}
        title={tag.note || undefined}
        draggable
        onDragStart={e => handleTagDragStart(e, tag)}
        onDragOver={e => handleTagDragOver(e, tag)}
        onDrop={handleTagDrop}
        onDragEnd={handleDragEnd}
      >
        <td className="tg-drag" title="拖拽排序">⠿</td>
        <td className="tg-zh" onDoubleClick={() => startEdit(editKey, 'name_zh', tag.name_zh)}>
          {editingCell?.key === editKey && editingCell.field === 'name_zh' ? (
            <input
              ref={editInputRef}
              className="inline-edit"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={handleEditKeyDown}
            />
          ) : tag.name_zh}
        </td>
        <td className="tg-en" onDoubleClick={() => startEdit(editKey, 'tag', tag.tag)}>
          {editingCell?.key === editKey && editingCell.field === 'tag' ? (
            <input
              ref={editInputRef}
              className="inline-edit"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={handleEditKeyDown}
            />
          ) : tag.tag}
        </td>
        <td className="tg-btns">
          <button className="tg-copy" onClick={() => handleCopy(tag)}>复制</button>
          <button className="tg-cart" onClick={() => onAddToCart(tag)}>入车</button>
        </td>
        <td className="tg-actions">
          <button onClick={() => onEdit(tag)} title="编辑">&#9998;</button>
          <button onClick={() => onDelete(tag.tag, tag.block)} title="删除">&times;</button>
        </td>
      </tr>
    )
  }

  return (
    <div className="tag-dictionary">
      <SearchBar value={search} onChange={setSearch} placeholder="搜索Tag..." />

      <div className="block-tabs">
        {blocks.map(b => (
          <button
            key={b}
            className={`block-tab ${nav.block === b ? 'active' : ''}`}
            onClick={() => setNav({ block: b, category: ALL_CATEGORY })}
          >
            {BLOCK_LABELS[b as PromptBlock] || b} ({blockCounts[b] || 0})
          </button>
        ))}
      </div>

      {currentCategories.length > 0 && (
        <div className="category-chips">
          <button
            className={`category-chip ${isAllView ? 'active' : ''}`}
            onClick={() => setNav({ category: ALL_CATEGORY })}
          >
            全部 ({blockCounts[nav.block] || 0})
          </button>
          {currentCategories.map(cat => (
            <button
              key={cat}
              className={`category-chip ${nav.category === cat ? 'active' : ''}`}
              onClick={() => setNav({ category: cat })}
            >
              {shortLabel(cat)} ({categoryCounts[cat] || 0})
            </button>
          ))}
        </div>
      )}

      {/* 全部视图：4列网格 */}
      {isAllView && groupedTags && (
        <div className="tag-grid-4col">
          {groupedTags.map(group => (
              <div
                key={group.category}
                className="tag-col-block"
                draggable
                onDragStart={e => handleCatDragStart(e, group.category)}
                onDragOver={e => handleCatDragOver(e, group.category)}
                onDrop={handleCatDrop}
                onDragEnd={handleDragEnd}
              >
                <div
                  className="tag-col-header"
                  onDoubleClick={() => startEdit(group.category, 'categoryName', group.category)}
                >
                  <span className="drag-handle" title="拖拽排序">⠿</span>
                  {editingCell?.key === group.category && editingCell.field === 'categoryName' ? (
                    <input
                      ref={editInputRef}
                      className="inline-edit inline-edit-header"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={handleEditKeyDown}
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      {shortLabel(group.category)}
                      <span className="tag-col-count">({group.tags.length})</span>
                    </>
                  )}
                </div>
                <table className="tag-col-table">
                  <colgroup>
                    <col style={{ width: '18px' }} />
                    <col style={{ width: '35%' }} />
                    <col />
                    <col style={{ width: '92px' }} />
                    <col style={{ width: '44px' }} />
                  </colgroup>
                  <tbody>
                    {group.tags.map(renderTagRow)}
                  </tbody>
                </table>
              </div>
          ))}
          {groupedTags.length === 0 && <p className="empty-hint">没有找到匹配的Tag</p>}
        </div>
      )}

      {/* 单category视图 */}
      {!isAllView && (
        <div className="tag-single-wrap">
          <table className="tag-col-table full">
            <colgroup>
              <col style={{ width: '18px' }} />
              <col style={{ width: '20%' }} />
              <col />
              <col style={{ width: '92px' }} />
              <col style={{ width: '44px' }} />
            </colgroup>
            <tbody>
              {filteredTags.map(renderTagRow)}
            </tbody>
          </table>
          {filteredTags.length === 0 && <p className="empty-hint">没有找到匹配的Tag</p>}
        </div>
      )}

      <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>
    </div>
  )
}

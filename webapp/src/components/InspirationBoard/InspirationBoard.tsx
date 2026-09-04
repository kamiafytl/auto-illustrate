import { useState, useMemo, useCallback } from 'react'
import type { Inspiration } from '../../types'
import SearchBar from '../common/SearchBar'
import ImageLightbox from '../common/ImageLightbox'

interface ImageStore {
  images: Record<string, string>
  saveImage: (key: string, blob: Blob) => Promise<void>
  deleteImage: (key: string) => void
  handlePaste: (key: string, e: ClipboardEvent) => Promise<boolean>
}

interface InspirationBoardProps {
  inspirations: Inspiration[]
  onEdit: (item: Inspiration) => void
  onDelete: (id: string) => void
  imageStore: ImageStore
}

const TYPE_OPTIONS = ['长故事', '短故事', '视觉', 'h视觉'] as const

function getTypeClass(type: string): string {
  if (type === '长故事') return 'type-long-story'
  if (type === '短故事') return 'type-short-story'
  if (type === 'h视觉') return 'type-h-visual'
  return 'type-visual'
}

export default function InspirationBoard({ inspirations, onEdit, onDelete, imageStore }: InspirationBoardProps) {
  const [search, setSearch] = useState('')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('owner-nav:inspirations-type')
      if (stored && TYPE_OPTIONS.includes(stored as typeof TYPE_OPTIONS[number])) return stored
    } catch { /* ignore */ }
    return TYPE_OPTIONS[0]
  })

  const setTypeAndSave = (type: string) => {
    setTypeFilter(type)
    try { localStorage.setItem('owner-nav:inspirations-type', type) } catch { /* ignore */ }
  }

  const filtered = useMemo(() => {
    let list = inspirations.filter(i => i.type === typeFilter)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(i =>
        i.text.toLowerCase().includes(q) ||
        i.note.toLowerCase().includes(q)
      )
    }
    return list
  }, [inspirations, typeFilter, search])

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const i of inspirations) counts[i.type] = (counts[i.type] || 0) + 1
    return counts
  }, [inspirations])

  const onCardPaste = useCallback((itemId: string, e: React.ClipboardEvent) => {
    imageStore.handlePaste(`insp:${itemId}`, e.nativeEvent)
  }, [imageStore])

  return (
    <div className="inspiration-board">
      <div className="inspiration-toolbar">
        <SearchBar value={search} onChange={setSearch} placeholder="搜索灵感..." />
        <div className="type-filters">
          {TYPE_OPTIONS.map(t => (
            <button
              key={t}
              className={`filter-btn ${typeFilter === t ? 'active' : ''}`}
              onClick={() => setTypeAndSave(t)}
            >
              {t} ({typeCounts[t] || 0})
            </button>
          ))}
        </div>
      </div>

      <div className="inspiration-list">
        {filtered.map(item => {
          const imgSrc = imageStore.images[`insp:${item.id}`]
          return (
            <div
              key={item.id}
              className={`inspiration-card ${getTypeClass(item.type)}`}
              tabIndex={0}
              onPaste={e => onCardPaste(item.id, e)}
            >
              {imgSrc && (
                <div className="card-preview-wrap">
                  <img
                    src={imgSrc}
                    className="card-preview-image"
                    alt=""
                    onClick={() => setLightboxSrc(imgSrc)}
                  />
                  <button className="img-delete-btn" onClick={() => {
                    imageStore.deleteImage(`insp:${item.id}`)
                  }} title="删除图片">&times;</button>
                </div>
              )}
              <div className="inspiration-content">
                <span className="type-badge">{item.type}</span>
                <p className="inspiration-text">{item.text}</p>
                {item.note && <p className="inspiration-note">{item.note}</p>}
              </div>
              <div className="inspiration-meta">
                <span className="date">{item.created}</span>
                <div className="inspiration-actions">
                  <button className="btn-edit" onClick={() => onEdit(item)}>编辑</button>
                  <button className="btn-delete" onClick={() => onDelete(item.id)}>删除</button>
                </div>
              </div>
            </div>
          )
        })}
        {filtered.length === 0 && <p className="empty-hint">没有找到匹配的灵感</p>}
      </div>

      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  )
}

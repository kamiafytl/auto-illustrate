// tag 词典中类（E2 蓝图 §二·差异点6）：旧 TagDictionary 数据原样（data/tags/*.json 经 /api/data/tags），
// 查阅性质=简单列表+搜索（禁重UI，无拖拽/无行内编辑——编辑仍走旧 tab 到 E5）；
// danbooru 接网查 post 数/预览图（服务端缓存 data/cache/danbooru，失败静默降级为纯本地）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { BLOCK_LABELS, BLOCK_ORDER, type PromptBlock } from '../editor/types/prompt'
import type { TagEntry } from '../editor/lib/dataClient'
import { matchText } from './parts'
import { copyText } from '../../utils/clipboard'

type DanbooruInfo = { postCount: number | null; preview: string | null }

// 会话级缓存（服务端另有磁盘缓存）；null=已请求失败过，不再重试
const danbooruCache = new Map<string, DanbooruInfo>()

async function fetchDanbooru(tag: string): Promise<DanbooruInfo> {
  try {
    const response = await fetch(`/api/danbooru/tag-info?tag=${encodeURIComponent(tag)}`)
    if (!response.ok) return { postCount: null, preview: null }
    const data = (await response.json()) as { postCount?: number | null; preview?: string | null }
    return { postCount: data.postCount ?? null, preview: data.preview ?? null }
  } catch {
    return { postCount: null, preview: null }
  }
}

export function TagDictSection({ tags, search, onPick }: { tags: TagEntry[]; search: string; onPick: (tag: TagEntry) => void }) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [hover, setHover] = useState<{ tag: string; preview: string | null; x: number; y: number } | null>(null)
  const [, setTick] = useState(0) // danbooru 结果回填后触发重渲
  const fetchingRef = useRef(false)

  const filtered = useMemo(
    () => tags.filter((tag) => matchText(search, tag.tag, tag.name_zh, tag.note, tag.category)),
    [tags, search],
  )

  const byBlock = useMemo(() => {
    const known = BLOCK_ORDER.filter((block) => filtered.some((tag) => tag.block === block))
    const other = Array.from(new Set(filtered.map((tag) => String(tag.block)))).filter((block) => !known.includes(block as PromptBlock))
    return [...known, ...other].map((block) => ({
      block,
      label: BLOCK_LABELS[block as PromptBlock] ?? block,
      items: filtered.filter((tag) => String(tag.block) === block),
    }))
  }, [filtered])

  // 懒取 danbooru：只查当前过滤可见的 tag，并发 2、静默降级
  useEffect(() => {
    if (fetchingRef.current) return
    const pending = filtered.map((tag) => tag.tag).filter((name) => !danbooruCache.has(name))
    if (pending.length === 0) return
    fetchingRef.current = true
    let cancelled = false
    ;(async () => {
      const queue = [...pending]
      const worker = async () => {
        while (queue.length > 0 && !cancelled) {
          const name = queue.shift()!
          const info = await fetchDanbooru(name)
          danbooruCache.set(name, info)
          if (!cancelled) setTick((tick) => tick + 1)
        }
      }
      await Promise.all([worker(), worker()])
      fetchingRef.current = false
    })()
    return () => {
      cancelled = true
      fetchingRef.current = false
    }
  }, [filtered])

  const handleCopy = (tag: TagEntry) => {
    void copyText(tag.tag)
    const key = `${tag.tag}:${tag.block}`
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1200)
  }

  const shortLabel = (category: string) => category.replace(/^\[([^\]]+)\].*$/, '$1')

  return (
    <div>
      <div className="lib-group-header">
        tag 词典 <span className="lib-header-count">({filtered.length})</span>
        <span className="lib-header-note">danbooru 接网：post 数/悬浮预览，缓存 data/cache · 失败自动降级纯本地</span>
      </div>
      {byBlock.map((group) => (
        <div key={group.block} className="lib-tag-wrap">
          <div className="lib-tag-header">
            {group.label} <span className="lib-header-count">({group.items.length})</span>
          </div>
          <table className="lib-tag-table">
            <colgroup>
              <col style={{ width: '24%' }} />
              <col />
              <col style={{ width: '90px' }} />
              <col style={{ width: '130px' }} />
            </colgroup>
            <tbody>
              {group.items.map((tag, index) => {
                const key = `${tag.tag}:${tag.block}`
                const info = danbooruCache.get(tag.tag)
                return (
                  <tr
                    key={`${key}:${index}`}
                    className={copiedKey === key ? 'copied' : ''}
                    title={tag.note || undefined}
                    onMouseEnter={(event) => setHover({ tag: tag.tag, preview: info?.preview ?? null, x: event.clientX, y: event.clientY })}
                    onMouseMove={(event) => setHover((current) => (current && current.tag === tag.tag ? { ...current, x: event.clientX, y: event.clientY } : current))}
                    onMouseLeave={() => setHover(null)}
                  >
                    <td className="ltg-zh">{tag.name_zh}{tag.category ? <span className="lib-header-count"> · {shortLabel(tag.category)}</span> : null}</td>
                    <td className="ltg-en">{tag.tag}</td>
                    <td className="ltg-count">{info?.postCount != null ? info.postCount.toLocaleString() : ''}</td>
                    <td className="ltg-btns">
                      <button className="ltg-copy" type="button" onClick={() => handleCopy(tag)}>复制</button>
                      <button className="ltg-pick" type="button" onClick={() => onPick(tag)}>选入</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
      {filtered.length === 0 && <p className="lib-empty-hint">没有匹配的 tag</p>}
      {hover?.preview && (
        <div className="lib-tag-preview" style={{ left: Math.min(hover.x + 24, window.innerWidth - 260), top: Math.max(12, hover.y - 160) }}>
          <img src={hover.preview} alt="" />
          <span className="lib-tag-preview-note">danbooru 预览 · {hover.tag}</span>
        </div>
      )}
    </div>
  )
}

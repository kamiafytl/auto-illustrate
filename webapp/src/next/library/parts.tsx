import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { RecipeEntry } from '../editor/lib/dataClient'
import { copyText } from '../../utils/clipboard'

// E2 配方库共享零件：绿钮=复制（.copy-btn 原样）、橙钮位=选入编辑器（.cart-add-btn 原样·差异点2）、
// 三列卡片（.recipe-card 原样）、悬浮跟随大图（.lz-zoom 思路）。

export function CopyBtn({ text, label = '复制', disabled }: { text: string; label?: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`lib-copy-btn ${copied ? 'copied' : ''}`}
      type="button"
      disabled={disabled || !text}
      title={text ? '' : '（未填写）'}
      onClick={() => {
        void copyText(text).then(ok => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? '已复制' : label}
    </button>
  )
}

export function PickBtn({ onPick, label = '选入编辑器' }: { onPick: () => void; label?: string }) {
  return (
    <button className="lib-pick-btn" type="button" onClick={onPick}>
      {label}
    </button>
  )
}

/** 配方三列卡片 = 旧 .recipe-card 原样（图/题/group chip/tags/绿橙钮；衣服套装带 10 视角变体） */
export function RecipeCard({ recipe, onPick, extraTag }: { recipe: RecipeEntry; onPick: () => void; extraTag?: string }) {
  const isClothingSuit = recipe.block === 'clothing' && recipe.category === '套装'
  const variants: { key: string; label: string; text: string }[] = isClothingSuit
    ? [
        { key: 'front_full', label: '正·全身', text: recipe.tags },
        { key: 'front_cowboy', label: '正·牛仔', text: recipe.tags_front_cowboy || recipe.tags_cowboy || '' },
        { key: 'front_upper', label: '正·上半', text: recipe.tags_front_upper || recipe.tags_upper || '' },
        { key: 'front_mid', label: '正·中身', text: recipe.tags_front_mid || '' },
        { key: 'front_lower', label: '正·下半', text: recipe.tags_front_lower || '' },
        { key: 'back_full', label: '背·全身', text: recipe.tags_back_full || recipe.tags_back || '' },
        { key: 'back_cowboy', label: '背·牛仔', text: recipe.tags_back_cowboy || '' },
        { key: 'back_upper', label: '背·上半', text: recipe.tags_back_upper || '' },
        { key: 'back_mid', label: '背·中身', text: recipe.tags_back_mid || '' },
        { key: 'back_lower', label: '背·下半', text: recipe.tags_back_lower || '' },
      ].filter((variant) => variant.text)
    : []
  return (
    <div className="lib-card">
      {recipe.image && (
        <div className="lib-card-image">
          <img src={recipe.image} alt={recipe.name} loading="lazy" />
        </div>
      )}
      <div className="lib-card-info">
        <h3 className="lib-card-name">{recipe.name}</h3>
        <span className="lib-card-group-tag">{extraTag ?? recipe.group}</span>
        <div className="lib-btn-row">
          <CopyBtn text={recipe.tags} />
          <PickBtn onPick={onPick} />
        </div>
        <pre className={`lib-card-tags ${!recipe.tags ? 'is-empty' : ''}`}>{recipe.tags || '（未填写）'}</pre>
        {variants.length > 0 && (
          <div className="lib-variants">
            {variants.map((variant) => (
              <div key={variant.key} className="lib-variant">
                <div className="lib-variant-header">
                  <span className="lib-variant-label">{variant.label}</span>
                  <CopyBtn text={variant.text} label={`复制${variant.label}`} />
                </div>
                <pre className="lib-card-tags">{variant.text}</pre>
              </div>
            ))}
          </div>
        )}
        {recipe.note && <p className="lib-card-note">{recipe.note}</p>}
      </div>
    </div>
  )
}

/** 悬浮跟随大图（= LazyBrowser ZoomLayer 同款定位算法，类名换 lib-zoom） */
export function ZoomLayer({ src, x, y, note }: { src: string; x: number; y: number; note?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; vis: boolean }>({ left: -9999, top: -9999, vis: false })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const M = 12
    const right = x > vw / 2
    const left = Math.max(M, Math.min(right ? x - 28 - w : x + 28, vw - w - M))
    const top = Math.max(M, Math.min(y - h / 2, vh - h - M))
    setPos({ left, top, vis: true })
  }, [src, x, y])
  return (
    <div ref={ref} className="lib-zoom" style={{ left: pos.left, top: pos.top, visibility: pos.vis ? 'visible' : 'hidden' }}>
      <img src={src} alt="" />
      {note}
    </div>
  )
}

export function matchText(query: string, ...fields: (string | undefined | null)[]): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return fields.some((field) => (field ?? '').toLowerCase().includes(q))
}

export function slugId(...parts: string[]): string {
  return `lib-${parts.join('-').replace(/[^\w一-鿿-]/g, '_')}`
}

export function scrollToAnchor(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

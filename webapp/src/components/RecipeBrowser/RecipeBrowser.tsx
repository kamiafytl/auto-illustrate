import { useState, useMemo, useEffect, useCallback } from 'react'
import type { Recipe } from '../../types'
import { BLOCK_LABELS } from '../../types'
import SearchBar from '../common/SearchBar'
import CopyButton from '../common/CopyButton'
import ImageLightbox from '../common/ImageLightbox'

interface ImageStore {
  images: Record<string, string>
  saveImage: (key: string, blob: Blob) => Promise<void>
  deleteImage: (key: string) => void
  handlePaste: (key: string, e: ClipboardEvent) => Promise<boolean>
}

interface RecipeBrowserProps {
  recipes: Recipe[]
  onEdit: (recipe: Recipe) => void
  onDelete: (id: string) => void
  showImages: boolean
  imageStore: ImageStore
  onAddToCart: (recipe: Recipe) => void
  nav: { block: string; category: string; group: string }
  onNav: (patch: Partial<{ block: string; category: string; group: string }>) => void
  sidebarActive: boolean
}

const blockLabels: Record<string, string> = BLOCK_LABELS

// 分类置顶序（2026-08-29）：画师串的「主力整合串」永远排第一，别再随 style.json
// 数组顺序漂。表里没列到的分类保持原有出现顺序，排在置顶项之后。
// 新版配方库同规则在 next/library/MaterialsPane.tsx 的 ARTIST_CATEGORY_ORDER。
const CATEGORY_PRIORITY: Record<string, string[]> = {
  style: ['主力整合串'],
}
function orderCategories(block: string, cats: string[]): string[] {
  const priority = CATEGORY_PRIORITY[block]
  if (!priority) return cats
  const rank = (c: string) => {
    const i = priority.indexOf(c)
    return i < 0 ? priority.length : i
  }
  return [...cats].sort((x, y) => rank(x) - rank(y))  // 同 rank 保持原序（Array#sort 稳定）
}

export default function RecipeBrowser({
  recipes, onEdit, onDelete, showImages, imageStore, onAddToCart,
  nav, onNav, sidebarActive
}: RecipeBrowserProps) {
  const [search, setSearch] = useState('')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  // 构建导航数据
  const { blocks, categoriesByBlock, groupsByBlockCat } = useMemo(() => {
    const blockSet = new Set<string>()
    const catMap: Record<string, Set<string>> = {}
    const groupMap: Record<string, Set<string>> = {}
    for (const r of recipes) {
      blockSet.add(r.block)
      if (!catMap[r.block]) catMap[r.block] = new Set()
      catMap[r.block].add(r.category)
      const groupKey = `${r.block}:${r.category}`
      if (!groupMap[groupKey]) groupMap[groupKey] = new Set()
      groupMap[groupKey].add(r.group)
    }
    return {
      blocks: Array.from(blockSet),
      categoriesByBlock: Object.fromEntries(
        Object.entries(catMap).map(([k, v]) => [k, orderCategories(k, Array.from(v))])
      ),
      groupsByBlockCat: Object.fromEntries(
        Object.entries(groupMap).map(([k, v]) => [k, Array.from(v)])
      )
    }
  }, [recipes])

  // 确保nav值有效
  useEffect(() => {
    if (blocks.length === 0) return
    const patch: Partial<{ block: string; category: string; group: string }> = {}
    let currentBlock = nav.block
    if (!blocks.includes(currentBlock)) {
      currentBlock = blocks[0]
      patch.block = currentBlock
    }
    const cats = categoriesByBlock[currentBlock] || []
    let currentCat = nav.category
    if (cats.length > 0 && !cats.includes(currentCat)) {
      currentCat = cats[0]
      patch.category = currentCat
    }
    const groups = groupsByBlockCat[`${currentBlock}:${currentCat}`] || []
    const currentGroup = nav.group || ''
    if (groups.length > 0 && !groups.includes(currentGroup)) {
      patch.group = groups[0]
    }
    if (Object.keys(patch).length > 0) onNav(patch)
  }, [blocks, categoriesByBlock, groupsByBlockCat, nav.block, nav.category, nav.group, onNav])

  const currentCategories = categoriesByBlock[nav.block] || []
  const currentGroups = groupsByBlockCat[`${nav.block}:${nav.category}`] || []

  // 侧边栏模式：按category+group分组展示所有block下的配方
  const groupedRecipes = useMemo(() => {
    if (!sidebarActive) return null
    let list = recipes.filter(r => r.block === nav.block)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.tags.toLowerCase().includes(q) ||
        (r.tags_front_cowboy || r.tags_cowboy || '').toLowerCase().includes(q) ||
        (r.tags_front_upper  || r.tags_upper  || '').toLowerCase().includes(q) ||
        (r.tags_front_mid    || '').toLowerCase().includes(q) ||
        (r.tags_front_lower  || '').toLowerCase().includes(q) ||
        (r.tags_back_full    || r.tags_back   || '').toLowerCase().includes(q) ||
        (r.tags_back_cowboy  || '').toLowerCase().includes(q) ||
        (r.tags_back_upper   || '').toLowerCase().includes(q) ||
        (r.tags_back_mid     || '').toLowerCase().includes(q) ||
        (r.tags_back_lower   || '').toLowerCase().includes(q) ||
        r.note.toLowerCase().includes(q)
      )
    }
    const catOrder = categoriesByBlock[nav.block] || []
    const result: { category: string; groups: { group: string; recipes: Recipe[] }[] }[] = []
    for (const cat of catOrder) {
      const catRecipes = list.filter(r => r.category === cat)
      if (catRecipes.length === 0) continue
      const groupOrder = groupsByBlockCat[`${nav.block}:${cat}`] || []
      const groups: { group: string; recipes: Recipe[] }[] = []
      for (const g of groupOrder) {
        const gRecipes = catRecipes.filter(r => r.group === g)
        if (gRecipes.length > 0) groups.push({ group: g, recipes: gRecipes })
      }
      if (groups.length > 0) result.push({ category: cat, groups })
    }
    return result
  }, [sidebarActive, recipes, nav.block, search, categoriesByBlock, groupsByBlockCat])

  // 非侧边栏模式：平铺过滤
  const filtered = useMemo(() => {
    if (sidebarActive) return []
    let list = recipes.filter(r => r.block === nav.block)
    if (nav.category) list = list.filter(r => r.category === nav.category)
    if (nav.group) list = list.filter(r => r.group === nav.group)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.tags.toLowerCase().includes(q) ||
        (r.tags_front_cowboy || r.tags_cowboy || '').toLowerCase().includes(q) ||
        (r.tags_front_upper  || r.tags_upper  || '').toLowerCase().includes(q) ||
        (r.tags_front_mid    || '').toLowerCase().includes(q) ||
        (r.tags_front_lower  || '').toLowerCase().includes(q) ||
        (r.tags_back_full    || r.tags_back   || '').toLowerCase().includes(q) ||
        (r.tags_back_cowboy  || '').toLowerCase().includes(q) ||
        (r.tags_back_upper   || '').toLowerCase().includes(q) ||
        (r.tags_back_mid     || '').toLowerCase().includes(q) ||
        (r.tags_back_lower   || '').toLowerCase().includes(q) ||
        r.note.toLowerCase().includes(q)
      )
    }
    return list
  }, [sidebarActive, recipes, nav, search])

  // 计数
  const blockCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of recipes) counts[r.block] = (counts[r.block] || 0) + 1
    return counts
  }, [recipes])

  // 粘贴图片
  const onCardPaste = useCallback((recipeId: string, e: React.ClipboardEvent) => {
    imageStore.handlePaste(`recipe:${recipeId}`, e.nativeEvent)
  }, [imageStore])

  const getImage = (recipe: Recipe) => imageStore.images[`recipe:${recipe.id}`] || (showImages ? recipe.image : null)

  const renderCard = (recipe: Recipe) => {
    const imgSrc = getImage(recipe)
    const isClothingSuit = recipe.block === 'clothing' && recipe.category === '套装'
    const variants: { key: string; label: string; text: string }[] = isClothingSuit ? [
      { key: 'front_full',   label: '正·全身', text: recipe.tags },
      { key: 'front_cowboy', label: '正·牛仔', text: recipe.tags_front_cowboy || recipe.tags_cowboy || '' },
      { key: 'front_upper',  label: '正·上半', text: recipe.tags_front_upper  || recipe.tags_upper  || '' },
      { key: 'front_mid',    label: '正·中身', text: recipe.tags_front_mid    || '' },
      { key: 'front_lower',  label: '正·下半', text: recipe.tags_front_lower  || '' },
      { key: 'back_full',    label: '背·全身', text: recipe.tags_back_full    || recipe.tags_back   || '' },
      { key: 'back_cowboy',  label: '背·牛仔', text: recipe.tags_back_cowboy  || '' },
      { key: 'back_upper',   label: '背·上半', text: recipe.tags_back_upper   || '' },
      { key: 'back_mid',     label: '背·中身', text: recipe.tags_back_mid     || '' },
      { key: 'back_lower',   label: '背·下半', text: recipe.tags_back_lower   || '' },
    ] : []
    return (
      <div
        key={recipe.id}
        className="recipe-card"
        tabIndex={0}
        onPaste={e => onCardPaste(recipe.id, e)}
      >
        {imgSrc && (
          <div className="recipe-image" onClick={() => setLightboxSrc(imgSrc)}>
            <img src={imgSrc} alt={recipe.name} loading="lazy" />
            {imageStore.images[`recipe:${recipe.id}`] && (
              <button className="img-delete-btn" onClick={e => {
                e.stopPropagation()
                imageStore.deleteImage(`recipe:${recipe.id}`)
              }} title="删除图片">&times;</button>
            )}
          </div>
        )}
        <div className="recipe-info">
          <h3 className="recipe-name">{recipe.name}</h3>
          <span className="recipe-group-tag">{recipe.group}</span>
          {isClothingSuit ? (
            <>
              <div className="recipe-btn-row">
                <button className="cart-add-btn" onClick={() => onAddToCart(recipe)}>入车</button>
              </div>
              <div className="recipe-variants">
                {variants.map(v => (
                  <div key={v.key} className="recipe-variant">
                    <div className="variant-header">
                      <span className="variant-label">{v.label}</span>
                      <CopyButton text={v.text} label={`复制${v.label}`} title={v.text ? '' : '该变体尚未填写'} />
                    </div>
                    <pre className={`recipe-tags ${!v.text ? 'is-empty' : ''}`}>{v.text || '（未填写）'}</pre>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="recipe-btn-row">
                <CopyButton text={recipe.tags} />
                <button className="cart-add-btn" onClick={() => onAddToCart(recipe)}>入车</button>
              </div>
              <pre className="recipe-tags">{recipe.tags}</pre>
            </>
          )}
          {recipe.note && <p className="recipe-note">{recipe.note}</p>}
          <div className="recipe-actions">
            <button className="btn-edit" onClick={() => onEdit(recipe)}>编辑</button>
            <button className="btn-delete" onClick={() => onDelete(recipe.id)}>删除</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="recipe-browser">
      <SearchBar value={search} onChange={setSearch} placeholder="搜索配方..." />

      {/* 侧边栏折叠时显示chip导航 */}
      {!sidebarActive && (
        <>
          <div className="block-tabs">
            {blocks.map(b => (
              <button
                key={b}
                className={`block-tab ${nav.block === b ? 'active' : ''}`}
                onClick={() => {
                  const cats = categoriesByBlock[b] || []
                  const firstCat = cats[0] || ''
                  const groups = groupsByBlockCat[`${b}:${firstCat}`] || []
                  onNav({ block: b, category: firstCat, group: groups[0] || '' })
                }}
              >
                {blockLabels[b] || b} ({blockCounts[b] || 0})
              </button>
            ))}
          </div>

          {currentCategories.length > 0 && (
            <div className="category-chips">
              {currentCategories.map(cat => (
                <button
                  key={cat}
                  className={`category-chip ${nav.category === cat ? 'active' : ''}`}
                  onClick={() => {
                    const groups = groupsByBlockCat[`${nav.block}:${cat}`] || []
                    onNav({ category: cat, group: groups[0] || '' })
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          {currentGroups.length > 0 && (
            <div className="group-chips">
              {currentGroups.map(g => (
                <button
                  key={g}
                  className={`group-chip ${nav.group === g ? 'active' : ''}`}
                  onClick={() => onNav({ group: g })}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* 侧边栏模式：分组展示 */}
      {sidebarActive && groupedRecipes && (
        <div className="recipe-grouped">
          {groupedRecipes.map(({ category, groups }) => (
            <div key={category} className="recipe-section">
              <div className="section-header">{category}</div>
              {groups.map(({ group, recipes: groupRecipes }) => (
                <div key={group} id={`group-${category}-${group}`} className="recipe-group-section">
                  <div className="group-header">{group} <span className="group-count">({groupRecipes.length})</span></div>
                  <div className="recipe-grid">
                    {groupRecipes.map(renderCard)}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {groupedRecipes.length === 0 && <p className="empty-hint">没有找到匹配的配方</p>}
        </div>
      )}

      {/* 非侧边栏模式：平铺 */}
      {!sidebarActive && (
        <div className="recipe-grid">
          {filtered.map(renderCard)}
          {filtered.length === 0 && <p className="empty-hint">没有找到匹配的配方</p>}
        </div>
      )}

      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  )
}

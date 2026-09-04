import { useEffect } from 'react'
import type { TabId } from '../../types'
import GitSyncButton from './GitSyncButton'

// 配方库下辖三个子类：选中配方库后在黑框底下弹出子导航
const LIB_SUBTABS: { id: TabId; label: string }[] = [
  { id: 'recipes', label: '大配方' },
  { id: 'tags', label: 'Tag词典' },
  { id: 'characters', label: '角色' },
]
const LIB_TAB_IDS: TabId[] = LIB_SUBTABS.map(t => t.id)
const LIB_SUB_KEY = 'owner-nav:libSubTab'

// 顶级 tab。「生产」(production) 暂时下架：代码内容全保留，重启 ComfyUI 时把
// { id: 'production', label: '生产' } 加回本表即可（期间 ?tab=production 仍可直达）。
const TABS: { id: TabId; label: string }[] = [
  { id: 'recipes', label: '配方库' },
  { id: 'inspirations', label: '灵感库' },
  { id: 'nai-queue', label: 'NAI队列' },
  { id: 'lazydog', label: '懒狗库' },
  { id: 'rating', label: '评分' },
  { id: 'next', label: '新版' },
]

interface AppHeaderProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  showImages: boolean
  onToggleImages: () => void
  onAdd: () => void
  cartCount: number
  onCartToggle: () => void
}

export default function AppHeader({
  activeTab, onTabChange, showImages, onToggleImages,
  onAdd, cartCount, onCartToggle
}: AppHeaderProps) {
  const inLibrary = LIB_TAB_IDS.includes(activeTab)

  // 记住配方库内最后停留的子类，点顶栏「配方库」回到它
  useEffect(() => {
    if (inLibrary) {
      try { localStorage.setItem(LIB_SUB_KEY, activeTab) } catch { /* ignore */ }
    }
  }, [activeTab, inLibrary])

  const gotoLibrary = () => {
    let sub: TabId = 'recipes'
    try {
      const stored = localStorage.getItem(LIB_SUB_KEY)
      if (stored && LIB_TAB_IDS.includes(stored as TabId)) sub = stored as TabId
    } catch { /* ignore */ }
    onTabChange(sub)
  }

  return (
    <header className="app-header">
      <div className="header-top">
        <h1 className="header-logo">Auto Illustrate</h1>
        <nav className="header-tabs">
          {TABS.map(tab => {
            const isLib = tab.id === 'recipes'
            const active = isLib ? inLibrary : activeTab === tab.id
            return (
              <button
                key={tab.id}
                className={`header-tab ${active ? 'active' : ''}`}
                onClick={() => (isLib ? gotoLibrary() : onTabChange(tab.id))}
              >
                {tab.label}
              </button>
            )
          })}
        </nav>
        <div className="header-actions">
          {activeTab !== 'production' && activeTab !== 'nai-queue' && activeTab !== 'characters' && activeTab !== 'lazydog' && activeTab !== 'next' && (
            <>
              <button
                className={`header-btn header-btn-toggle ${showImages ? 'active' : ''}`}
                onClick={onToggleImages}
              >
                {showImages ? '隐藏图片' : '显示图片'}
              </button>
              <button className="header-btn header-btn-add" onClick={onAdd}>
                + 新增
              </button>
              <button
                className={`header-btn header-btn-cart ${cartCount > 0 ? 'has-items' : ''}`}
                onClick={onCartToggle}
              >
                Cart{cartCount > 0 && <span className="header-cart-badge">{cartCount}</span>}
              </button>
            </>
          )}
          <GitSyncButton />
        </div>
      </div>
      {inLibrary && (
        <nav className="header-subtabs">
          {LIB_SUBTABS.map(t => (
            <button
              key={t.id}
              className={`header-subtab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  )
}

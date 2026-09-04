import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Recipe, TagEntry, Inspiration, TabId, BlockRelation } from './types'
import type { LoraEntry, WorkflowTemplate } from './types/production'
import { loadAllRecipes, loadAllTags, loadInspirations, loadLoras, loadWorkflows } from './data/loader'
import { useDisplayPrefs } from './hooks/useDisplayPrefs'
import { useImageStore } from './hooks/useImageStore'
import { useCart } from './hooks/useCart'
import { useNavMemory } from './hooks/useNavMemory'
import { useComfyUI } from './hooks/useComfyUI'
import { useAssembly } from './hooks/useAssembly'
import { useNaiBatch } from './hooks/useNaiBatch'
import { useCharacters } from './hooks/useCharacters'
import AppHeader from './components/Layout/AppHeader'
import Sidebar from './components/Layout/Sidebar'
import ScrollToTop from './components/Layout/ScrollToTop'
import RecipeBrowser from './components/RecipeBrowser/RecipeBrowser'
import TagDictionary from './components/TagDictionary/TagDictionary'
import InspirationBoard from './components/InspirationBoard/InspirationBoard'
import EditorModal from './components/Editor/EditorModal'
import CartPanel from './components/Cart/CartPanel'
import ConflictModal from './components/Cart/ConflictModal'
import MemoBar from './components/common/MemoBar'
import ProductionPanel from './components/Production/ProductionPanel'
import NaiBatchPanel from './components/NaiBatch/NaiBatchPanel'
import CharacterManager from './components/CharacterManager/CharacterManager'
import RatingPanel from './components/Rating/RatingPanel'
import { LazyBrowser } from './lazydog/LazyBrowser'
import NextApp from './next/NextApp'
import './lazydog/lazydog.css'

/**
 * keep-alive 容器：一旦某 tab 被访问过就保持挂载，非激活时用 display:none 隐藏而非卸载，
 * 从而像 Chrome 多 tab 一样保留各页面的内部 state / 已加载图片 / 分类选择 / 滚动位置。
 * display:contents 让本 wrapper 不产生盒子，子组件等同直接挂在 .app-content 下（不改原布局）。
 */
function KeepAlive({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <div style={{ display: visible ? 'contents' : 'none' }}>{children}</div>
}

type EditTarget =
  | { type: 'recipe'; data: Recipe | null; navContext?: { block: string; category: string; group: string } }
  | { type: 'tag'; data: TagEntry | null; navContext?: { block: string; category: string } }
  | { type: 'inspiration'; data: Inspiration | null; navContext?: { inspType: string } }

function App() {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    // 'production'（生产）顶栏按钮已暂时下架（AppHeader TABS），保留在此=?tab=production 仍可直达，重启 ComfyUI 时恢复按钮即可
    const VALID = ['recipes', 'tags', 'inspirations', 'production', 'nai-queue', 'characters', 'rating', 'lazydog', 'next']
    try {
      // ?tab=lazydog 优先(HTA 启动器直达散图库,旧 lazydog.html 重定向到此)
      const q = new URLSearchParams(window.location.search).get('tab')
      if (q && VALID.includes(q)) return q as TabId
      const stored = localStorage.getItem('owner-nav:activeTab')
      if (stored && VALID.includes(stored)) return stored as TabId
    } catch { /* ignore */ }
    return 'recipes'
  })

  // keep-alive：记录访问过的 tab（首次访问才挂载，之后常驻）
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(() => new Set([activeTab]))
  // 各 tab 的窗口滚动位置（多数 tab 是页面级滚动，切走/切回需手动存还原）
  const scrollMemory = useRef<Partial<Record<TabId, number>>>({})

  const handleTabChange = (tab: TabId) => {
    if (tab === activeTab) return
    scrollMemory.current[activeTab] = window.scrollY  // 存离开 tab 的滚动位
    setActiveTab(tab)
    setVisitedTabs(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)))
    try { localStorage.setItem('owner-nav:activeTab', tab) } catch { /* ignore */ }
  }

  // 切 tab 后还原目标 tab 上次的滚动位（布局生效后、绘制前执行，避免闪烁）
  useLayoutEffect(() => {
    window.scrollTo(0, scrollMemory.current[activeTab] ?? 0)
  }, [activeTab])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [tags, setTags] = useState<TagEntry[]>([])
  const [inspirations, setInspirations] = useState<Inspiration[]>([])
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [loading, setLoading] = useState(true)
  const [cartOpen, setCartOpen] = useState(false)
  const [cartToast, setCartToast] = useState('')
  const [conflictModal, setConflictModal] = useState<{
    block: string
    existingName: string
    incomingName: string
    incomingItem: { type: 'recipe'; tag: string; name_zh: string; sourceId: string }
    wasEmpty: boolean
  } | null>(null)

  const imageStore = useImageStore()
  const cartApi = useCart()
  const comfyUI = useComfyUI()
  const assembly = useAssembly()
  const naiBatch = useNaiBatch()
  const charactersApi = useCharacters()
  const [loras, setLoras] = useState<LoraEntry[]>([])
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([])

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('owner-sidebar-collapsed') === 'true' } catch { return false }
  })
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('owner-sidebar-collapsed', String(next)) } catch { /* ignore */ }
      return next
    })
  }

  // 侧边栏用的配方导航状态（提升到App层以便sidebar和RecipeBrowser共享）
  const [recipeNav, setRecipeNav] = useNavMemory('recipes', {
    block: 'action', category: '', group: ''
  })

  const recipeImgPrefs = useDisplayPrefs('recipes', true)
  const tagImgPrefs = useDisplayPrefs('tags', false)
  const inspirationImgPrefs = useDisplayPrefs('inspirations', false)

  const currentImgPrefs = activeTab === 'recipes' ? recipeImgPrefs
    : activeTab === 'tags' ? tagImgPrefs
    : activeTab === 'inspirations' ? inspirationImgPrefs : recipeImgPrefs

  useEffect(() => {
    Promise.all([loadAllRecipes(), loadAllTags(), loadInspirations(), loadLoras(), loadWorkflows()])
      .then(([r, t, i, l, w]) => {
        setRecipes(r)
        setTags(t)
        setInspirations(i)
        setLoras(l)
        setWorkflows(w)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const showCartToast = (msg: string) => {
    setCartToast(msg)
    setTimeout(() => setCartToast(''), 1500)
  }

  // 把当前组装棚内容快照加入 NAI 队列（初始化为 8 个 Owner block）
  const handleAddCurrentAssemblyToNaiQueue = () => {
    const hasContent = Object.values(assembly.blocks).some(b => b?.text?.trim())
    if (!hasContent) {
      showCartToast('组装棚为空，先组装一个 prompt')
      return
    }
    naiBatch.addItemFromAssembly(assembly.blocks)
    showCartToast('已加入 NAI 预设档库')
  }

  const handleAddRecipeToCart = (recipe: Recipe) => {
    const wasEmpty = cartApi.itemCount === 0

    // 部件逻辑：category === '部件' 直接附加，不问冲突
    if (recipe.category === '部件') {
      cartApi.addComponent(recipe.block, {
        type: 'component',
        tag: recipe.tags,
        name_zh: recipe.name,
        sourceId: recipe.id,
      })
      showCartToast(`已加入部件: ${recipe.name}`)
      if (wasEmpty) setCartOpen(true)
      return
    }

    const conflict = cartApi.hasRecipeInBlock(recipe.block)
    const item = {
      type: 'recipe' as const,
      tag: recipe.tags,
      name_zh: recipe.name,
      sourceId: recipe.id,
    }
    if (conflict) {
      // 打开冲突解决弹窗
      setConflictModal({
        block: recipe.block,
        existingName: conflict.name_zh,
        incomingName: recipe.name,
        incomingItem: item,
        wasEmpty,
      })
    } else {
      cartApi.addItem(recipe.block, item)
      showCartToast(`已加入: ${recipe.name}`)
      if (wasEmpty) setCartOpen(true)
    }
  }

  const handleConflictReplace = () => {
    if (!conflictModal) return
    cartApi.replaceRecipeInBlock(conflictModal.block, conflictModal.incomingItem)
    showCartToast(`已替换: ${conflictModal.incomingName}`)
    if (conflictModal.wasEmpty) setCartOpen(true)
    setConflictModal(null)
  }

  const handleConflictAdd = (relation: BlockRelation) => {
    if (!conflictModal) return
    cartApi.addItem(conflictModal.block, conflictModal.incomingItem)
    cartApi.setBlockRelation(conflictModal.block, relation)
    showCartToast(`已加入: ${conflictModal.incomingName}`)
    if (conflictModal.wasEmpty) setCartOpen(true)
    setConflictModal(null)
  }

  const handleAddTagToCart = (tag: TagEntry) => {
    const wasEmpty = cartApi.itemCount === 0
    cartApi.addItem(tag.block, {
      type: 'tag',
      tag: tag.tag,
      name_zh: tag.name_zh,
      sourceId: `tag:${tag.tag}:${tag.block}`,
    })
    showCartToast(`已加入: ${tag.name_zh}`)
    if (wasEmpty) setCartOpen(true)
  }

  // 读取当前Tab的导航状态
  const readNav = (tabId: string) => {
    try {
      const s = localStorage.getItem(`owner-nav:${tabId}`)
      if (s) return JSON.parse(s)
    } catch { /* ignore */ }
    return {}
  }

  const handleSave = async (type: TabId, data: unknown) => {
    const oldTarget = editTarget
    setEditTarget(null)

    try {
      const body: Record<string, unknown> = { type, data }
      if (oldTarget?.type === 'tag' && oldTarget.data) {
        body.old = oldTarget.data
      } else if (oldTarget?.type === 'recipe' && oldTarget.data) {
        body.old = oldTarget.data
      }
      await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (err) {
      console.error('保存失败:', err)
      return
    }

    if (type === 'recipes') {
      const recipe = data as Recipe
      setRecipes(prev => {
        const filtered = prev.filter(r => r.id !== recipe.id)
        return [...filtered, recipe]
      })
    } else if (type === 'tags') {
      const tag = data as TagEntry
      setTags(prev => {
        let filtered = prev
        if (oldTarget?.type === 'tag' && oldTarget.data) {
          const old = oldTarget.data
          filtered = prev.filter(t => !(t.tag === old.tag && t.block === old.block))
        }
        return [...filtered, tag]
      })
    } else if (type === 'inspirations') {
      const insp = data as Inspiration
      setInspirations(prev => {
        const filtered = prev.filter(i => i.id !== insp.id)
        return [...filtered, insp]
      })
    }
  }

  const handleAdd = () => {
    switch (activeTab) {
      case 'recipes': {
        const nav = readNav('recipes')
        setEditTarget({
          type: 'recipe',
          data: null,
          navContext: {
            block: nav.block || 'action',
            category: nav.category || '',
            group: nav.group || ''
          }
        })
        break
      }
      case 'tags': {
        const nav = readNav('tags')
        const cat = nav.category === '__all__' ? '' : (nav.category || '')
        setEditTarget({
          type: 'tag',
          data: null,
          navContext: {
            block: nav.block || 'expression',
            category: cat
          }
        })
        break
      }
      case 'inspirations': {
        let inspType = '短故事'
        try {
          const stored = localStorage.getItem('owner-nav:inspirations-type')
          if (stored && ['长故事', '短故事', '视觉', 'h视觉'].includes(stored)) inspType = stored
        } catch { /* ignore */ }
        setEditTarget({ type: 'inspiration', data: null, navContext: { inspType } })
        break
      }
    }
  }

  const handleDeleteRecipe = async (id: string) => {
    if (!confirm('确定删除这条配方？')) return
    const recipe = recipes.find(r => r.id === id)
    if (!recipe) return
    try {
      await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'recipes', id, block: recipe.block })
      })
    } catch (err) {
      console.error('删除失败:', err)
    }
    setRecipes(prev => prev.filter(r => r.id !== id))
  }

  const handleDeleteTag = async (tag: string, block: string) => {
    if (!confirm(`确定删除 ${tag}？`)) return
    try {
      await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tags', tag, block })
      })
    } catch (err) {
      console.error('删除失败:', err)
    }
    setTags(prev => prev.filter(t => !(t.tag === tag && t.block === block)))
  }

  const handleDeleteInspiration = async (id: string) => {
    if (!confirm('确定删除这条灵感？')) return
    try {
      await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'inspirations', id })
      })
    } catch (err) {
      console.error('删除失败:', err)
    }
    setInspirations(prev => prev.filter(i => i.id !== id))
  }

  if (loading) {
    return <div className="loading">加载中...</div>
  }

  return (
    <div className="app">
      <AppHeader
        activeTab={activeTab}
        onTabChange={handleTabChange}
        showImages={currentImgPrefs.globalShow}
        onToggleImages={currentImgPrefs.toggleGlobal}
        onAdd={handleAdd}
        cartCount={cartApi.itemCount}
        onCartToggle={() => setCartOpen(!cartOpen)}
      />

      <MemoBar />

      <div className={`app-body ${activeTab === 'recipes' ? 'with-sidebar' : ''}`}>
        {visitedTabs.has('recipes') && (
          <KeepAlive visible={activeTab === 'recipes'}>
            <Sidebar
              recipes={recipes}
              activeBlock={recipeNav.block}
              activeCategory={recipeNav.category}
              activeGroup={recipeNav.group || ''}
              onNav={patch => setRecipeNav(patch)}
              collapsed={sidebarCollapsed}
              onToggleCollapse={toggleSidebar}
            />
          </KeepAlive>
        )}
        <main className="app-content">
          {visitedTabs.has('recipes') && (
            <KeepAlive visible={activeTab === 'recipes'}>
              <RecipeBrowser
                recipes={recipes}
                onEdit={r => setEditTarget({ type: 'recipe', data: r })}
                onDelete={handleDeleteRecipe}
                showImages={recipeImgPrefs.globalShow}
                imageStore={imageStore}
                onAddToCart={handleAddRecipeToCart}
                nav={{ block: recipeNav.block, category: recipeNav.category, group: recipeNav.group || '' }}
                onNav={setRecipeNav}
                sidebarActive={!sidebarCollapsed}
              />
            </KeepAlive>
          )}
          {visitedTabs.has('tags') && (
            <KeepAlive visible={activeTab === 'tags'}>
              <TagDictionary
                tags={tags}
                onEdit={t => setEditTarget({ type: 'tag', data: t })}
                onDelete={handleDeleteTag}
                onAddToCart={handleAddTagToCart}
                onTagsChange={setTags}
              />
            </KeepAlive>
          )}
          {visitedTabs.has('inspirations') && (
            <KeepAlive visible={activeTab === 'inspirations'}>
              <InspirationBoard
                inspirations={inspirations}
                onEdit={i => setEditTarget({ type: 'inspiration', data: i })}
                onDelete={handleDeleteInspiration}
                imageStore={imageStore}
              />
            </KeepAlive>
          )}
          {visitedTabs.has('production') && (
            <KeepAlive visible={activeTab === 'production'}>
              <ProductionPanel
                loras={loras}
                onLorasChange={setLoras}
                workflows={workflows}
                onWorkflowsChange={setWorkflows}
                comfyUI={comfyUI}
                cart={cartApi.cart}
                assembly={assembly}
                onAddToNaiQueue={handleAddCurrentAssemblyToNaiQueue}
              />
            </KeepAlive>
          )}
          {visitedTabs.has('nai-queue') && (
            <KeepAlive visible={activeTab === 'nai-queue'}>
              <NaiBatchPanel batch={naiBatch} characters={charactersApi.characters} />
            </KeepAlive>
          )}
          {visitedTabs.has('characters') && (
            <KeepAlive visible={activeTab === 'characters'}>
              <CharacterManager />
            </KeepAlive>
          )}
          {visitedTabs.has('rating') && (
            <KeepAlive visible={activeTab === 'rating'}>
              <RatingPanel active={activeTab === 'rating'} />
            </KeepAlive>
          )}
          {visitedTabs.has('lazydog') && (
            <KeepAlive visible={activeTab === 'lazydog'}>
              <LazyBrowser batch={naiBatch} onGotoNaiQueue={() => handleTabChange('nai-queue')} />
            </KeepAlive>
          )}
          {visitedTabs.has('next') && (
            <KeepAlive visible={activeTab === 'next'}>
              <NextApp addNaiItem={naiBatch.addItem} onGotoNaiQueue={() => handleTabChange('nai-queue')} />
            </KeepAlive>
          )}
        </main>
      </div>

      <ScrollToTop />

      <EditorModal
        target={editTarget}
        onSave={handleSave}
        onClose={() => setEditTarget(null)}
        recipes={recipes}
        tags={tags}
      />

      <CartPanel
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        cart={cartApi.cart}
        carts={cartApi.carts}
        removeItem={cartApi.removeItem}
        clearCart={cartApi.clearCart}
        renameCart={cartApi.renameCart}
        exportText={cartApi.exportText}
        createNewCart={cartApi.createNewCart}
        switchCart={cartApi.switchCart}
        deleteCart={cartApi.deleteCart}
        itemCount={cartApi.itemCount}
        setBlockRelation={cartApi.setBlockRelation}
      />

      {conflictModal && (
        <ConflictModal
          block={conflictModal.block}
          existingName={conflictModal.existingName}
          incomingName={conflictModal.incomingName}
          onReplace={handleConflictReplace}
          onAdd={handleConflictAdd}
          onCancel={() => setConflictModal(null)}
        />
      )}

      <div className={`toast ${cartToast ? 'show' : ''}`}>{cartToast}</div>
    </div>
  )
}

export default App

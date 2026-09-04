import { useEffect, useState } from 'react'
import { createEmptyDoc } from './lib/promptDoc'
import { useStudioData } from './lib/useStudioData'
import type { PromptDoc } from './types/prompt'
import { ProductionView } from './views/ProductionView'

type ThemeMode = 'dark' | 'light'

function App() {
  const studioData = useStudioData()
  const [doc, setDoc] = useState<PromptDoc>(() => createEmptyDoc())
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'dark'
    return window.localStorage.getItem('studio-next-theme') === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('studio-next-theme', theme)
  }, [theme])

  if (studioData.status === 'loading') {
    return <main className="app-shell page-state">加载数据...</main>
  }

  if (studioData.status === 'error') {
    return <main className="app-shell page-state error">数据加载失败：{studioData.message}</main>
  }

  return (
    <main className="app-shell app-shell-mvp">
      <section className="app-main">
        <header className="app-header">
          <div>
            <p>MVP · 评审中</p>
            <h1>统一 Prompt 编辑器</h1>
            <span>本期唯一交付物：胶囊化 prompt 编辑器（基础区 + 角色区）</span>
          </div>
          <div className="app-header-side">
            <div className="data-summary" aria-label="已加载数据">
              <span>tags {studioData.tags.length}</span>
              <span>recipes {studioData.recipes.length}</span>
              <span>characters {studioData.characters.length}</span>
            </div>
            <button className="theme-toggle" type="button" onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}>
              {theme === 'dark' ? '淡色主题' : '深色主题'}
            </button>
          </div>
        </header>

        <ProductionView data={studioData} doc={doc} setDoc={setDoc} />
      </section>
    </main>
  )
}

export default App

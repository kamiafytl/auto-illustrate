import { useCallback, useState } from 'react'
import GitSyncKnx from './GitSyncKnx'
import TokensDemo from './TokensDemo'
import PromptEditorView from './editor/PromptEditorView'
import InspirationView from './views/InspirationView'
import ProductionView from './views/ProductionView'
import RatingView from './views/RatingView'
import LibraryView from './library/LibraryView'
import { createEmptyDoc } from './editor/lib/promptDoc'
import { useStudioData } from './editor/lib/useStudioData'
import type { PromptDoc } from './editor/types/prompt'
import type { DocMutator } from './library/selectToEditor'
import type { NaiBatchItem } from '../types'
import './tokens.css'

type NextRoom = 'editor' | 'recipes' | 'inspirations' | 'production' | 'rating' | 'tokens'

const rooms: { id: NextRoom; label: string }[] = [
  { id: 'editor', label: '编辑器' },
  { id: 'recipes', label: '配方库' },
  { id: 'inspirations', label: '灵感库' },
  { id: 'production', label: '生产队列' },
  { id: 'rating', label: '评分' },
  { id: 'tokens', label: '设计规范' },
]

type NextAppProps = {
  addNaiItem?: (opts?: Partial<NaiBatchItem>) => string
  onGotoNaiQueue?: () => void
}

export default function NextApp({ addNaiItem, onGotoNaiQueue }: NextAppProps) {
  // 配方库=日常主页（蓝图 §四动线）：E2 起默认落配方库，编辑器=组装台
  const [activeRoom, setActiveRoom] = useState<NextRoom>('recipes')
  // doc 与库数据上提到壳层：配方库「选入编辑器」直接改同一份 doc，切房间不丢
  const { state, reload } = useStudioData()
  const [doc, setDoc] = useState<PromptDoc>(() => createEmptyDoc())

  // 库卡片「选入编辑器」：胶囊（带来源 id）落入编辑器对应区块并跳到编辑器
  const applyToEditor = useCallback((mutator: DocMutator) => {
    setDoc((current) => mutator(current))
    setActiveRoom('editor')
  }, [])

  return (
    <div className="knx">
      <div className="knx-shell">
        <nav className="knx-topbar" aria-label="新版模块">
          <span className="knx-logo">Auto Illustrate</span>
          <div className="knx-topbar-tabs">
            {rooms.map(room => (
              <button
                key={room.id}
                className={`knx-tab ${activeRoom === room.id ? 'is-active' : ''}`}
                type="button"
                onClick={() => setActiveRoom(room.id)}
              >
                {room.label}
              </button>
            ))}
          </div>
          <div className="knx-topbar-actions">
            <GitSyncKnx />
          </div>
        </nav>
        <main className="knx-main">
          {activeRoom === 'editor' && (
            <PromptEditorView state={state} reloadData={reload} doc={doc} setDoc={setDoc} addNaiItem={addNaiItem} onGotoNaiQueue={onGotoNaiQueue} />
          )}
          {activeRoom === 'recipes' && <LibraryView state={state} onApplyToEditor={applyToEditor} />}
          {activeRoom === 'inspirations' && <InspirationView />}
          {activeRoom === 'production' && <ProductionView />}
          {activeRoom === 'rating' && <RatingView />}
          {activeRoom === 'tokens' && <TokensDemo />}
        </main>
      </div>
    </div>
  )
}

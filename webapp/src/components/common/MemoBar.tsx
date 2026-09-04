import { useState, useCallback, useRef, useEffect } from 'react'

const STORAGE_KEY = 'owner-memo'
const COLLAPSED_KEY = 'owner-memo-collapsed'
const DEFAULT_MEMO = `1. qwen image edit + 自然语言改图的想法
2. 给AI讲newbie-image（支持JSON结构化prompt）
3. 研究这个画风: https://civitai.com/images/119936088`

export default function MemoBar() {
  const [text, setText] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored !== null ? stored : DEFAULT_MEMO
    } catch { return DEFAULT_MEMO }
  })
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const save = useCallback((val: string) => {
    setText(val)
    try { localStorage.setItem(STORAGE_KEY, val) } catch { /* ignore */ }
  }, [])

  const toggleCollapse = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
  }

  // 自动调整高度
  useEffect(() => {
    const ta = textareaRef.current
    if (ta && !collapsed) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }, [text, collapsed])

  return (
    <div className="memo-bar">
      <div className="memo-header" onClick={toggleCollapse}>
        <span className="memo-title">备忘录</span>
        <span className="memo-toggle">{collapsed ? '展开' : '收起'}</span>
      </div>
      {!collapsed && (
        <textarea
          ref={textareaRef}
          className="memo-textarea"
          value={text}
          onChange={e => save(e.target.value)}
          placeholder="写下你的备忘...每次打开都能看到"
          spellCheck={false}
        />
      )}
    </div>
  )
}

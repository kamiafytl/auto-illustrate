import { useMemo, useState } from 'react'
import type { WriteBackItem } from '../lib/writeBack'

// 写回库 diff 确认弹窗（E2 蓝图 §四.3）：逐条勾选，旧值红底/新值绿底，确认才落盘。
export function WriteBackModal({ items, busy, onConfirm, onClose }: {
  items: WriteBackItem[]
  busy: boolean
  onConfirm: (selected: WriteBackItem[]) => void
  onClose: () => void
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(items.map((item) => item.key)))
  const selected = useMemo(() => items.filter((item) => checked.has(item.key)), [items, checked])

  function toggle(key: string): void {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="picker-modal writeback-modal" role="dialog" aria-modal="true" aria-label="写回库确认" onMouseDown={(event) => event.stopPropagation()}>
        <header className="picker-head">
          <h3>写回库确认（{items.length} 处改动）</h3>
          <button className="knx-btn knx-btn-ghost" type="button" onClick={onClose}>关闭</button>
        </header>
        <p className="knx-muted writeback-hint">
          编辑器里的胶囊改动只存在本 doc；下面列出与库内现值不同的来源条目，勾选后点「确认写回」才写入数据文件。
        </p>
        <div className="writeback-list">
          {items.map((item) => (
            <label key={item.key} className="writeback-item">
              <span className="writeback-item-head">
                <input type="checkbox" checked={checked.has(item.key)} onChange={() => toggle(item.key)} />
                <strong>{item.name}</strong>
                <span className="knx-muted">{item.kind === 'recipe' ? `配方 tags · ${item.recipe.block}` : 'tag 词典条目'}</span>
              </span>
              <pre className="writeback-old">- {item.oldText}</pre>
              <pre className="writeback-new">+ {item.newText}</pre>
            </label>
          ))}
        </div>
        <footer className="knx-row writeback-foot">
          <button className="knx-btn knx-btn-ok" type="button" disabled={busy || selected.length === 0} onClick={() => onConfirm(selected)}>
            {busy ? '写回中…' : `确认写回（${selected.length}）`}
          </button>
          <button className="knx-btn" type="button" onClick={onClose} disabled={busy}>取消</button>
        </footer>
      </section>
    </div>
  )
}

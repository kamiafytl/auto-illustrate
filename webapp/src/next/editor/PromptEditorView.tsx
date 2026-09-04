import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { NaiBatchItem } from '../../types'
import { PromptEditor } from './components/PromptEditor'
import { WriteBackModal } from './components/WriteBackModal'
import { applyWriteBacks, collectWriteBacks, markWrittenClean, type WriteBackItem } from './lib/writeBack'
import type { StudioDataState } from './lib/useStudioData'
import type { PromptDoc } from './types/prompt'
import { toNaiPayload } from './toNaiPayload'
import './editor.css'

type PromptEditorViewProps = {
  state: StudioDataState
  reloadData: () => Promise<void>
  doc: PromptDoc
  setDoc: Dispatch<SetStateAction<PromptDoc>>
  addNaiItem?: (opts?: Partial<NaiBatchItem>) => string
  onGotoNaiQueue?: () => void
}

export default function PromptEditorView({ state, reloadData, doc, setDoc, addNaiItem, onGotoNaiQueue }: PromptEditorViewProps) {
  const [lastAddedId, setLastAddedId] = useState<string | null>(null)
  const [writeBackOpen, setWriteBackOpen] = useState(false)
  const [writeBackBusy, setWriteBackBusy] = useState(false)
  const [writeBackNote, setWriteBackNote] = useState<string | null>(null)
  const payload = useMemo(() => toNaiPayload(doc), [doc])
  const canAdd = payload.baseBlocks.length > 0 || payload.characters.some((character) => character.text.trim())

  // 两级写回：改胶囊只改本 doc；这里实时统计与库内现值的差异数
  const writeBacks = useMemo(() => {
    if (state.status !== 'ready') return []
    return collectWriteBacks(doc, state.recipes, state.tags)
  }, [doc, state])

  function addToNaiQueue() {
    if (!addNaiItem || !canAdd) return
    const id = addNaiItem({
      ...payload,
      comment: doc.title?.trim() || 'Next Prompt',
    })
    setLastAddedId(id)
  }

  async function confirmWriteBack(selected: WriteBackItem[]) {
    setWriteBackBusy(true)
    try {
      const { ok, failed } = await applyWriteBacks(selected)
      const written = selected.filter((item) => !failed.includes(item.name))
      setDoc((current) => markWrittenClean(current, written))
      await reloadData()
      setWriteBackNote(failed.length > 0 ? `已写回 ${ok} 条，失败：${failed.join('、')}` : `已写回 ${ok} 条到数据文件`)
      setWriteBackOpen(false)
    } finally {
      setWriteBackBusy(false)
    }
  }

  return (
    <section className="knx-page knx-editor-page">
      <header className="knx-editor-toolbar">
        <div>
          <h2>编辑器</h2>
          <p>PromptDoc 编辑结果会映射为 NAI 预设档，实际出图仍在现有 NAI 队列里执行。改胶囊只改本 doc，点「写回库」才落数据文件。</p>
        </div>
        <div className="knx-editor-actions">
          <button
            className="knx-btn"
            type="button"
            onClick={() => setWriteBackOpen(true)}
            disabled={writeBacks.length === 0}
            title={writeBacks.length === 0 ? '当前 doc 与库内现值无差异' : '弹出 diff 确认后写入数据文件'}
          >
            写回库{writeBacks.length > 0 ? `（${writeBacks.length}）` : ''}
          </button>
          <button className="knx-btn knx-btn-primary" type="button" onClick={addToNaiQueue} disabled={!addNaiItem || !canAdd}>
            加入 NAI 预设档库
          </button>
          <button className="knx-btn" type="button" onClick={onGotoNaiQueue} disabled={!onGotoNaiQueue}>
            去 NAI 队列
          </button>
        </div>
      </header>
      {lastAddedId && (
        <div className="knx-editor-notice" role="status">
          已加入 NAI 预设档库：{lastAddedId}。切到 NAI 队列 tab 后运行该预设。
        </div>
      )}
      {writeBackNote && (
        <div className="knx-editor-notice" role="status">
          {writeBackNote}
        </div>
      )}
      <PromptEditor state={state} doc={doc} setDoc={setDoc} />
      {writeBackOpen && (
        <WriteBackModal items={writeBacks} busy={writeBackBusy} onConfirm={confirmWriteBack} onClose={() => setWriteBackOpen(false)} />
      )}
    </section>
  )
}

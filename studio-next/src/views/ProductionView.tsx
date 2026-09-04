import type { Dispatch, SetStateAction } from 'react'
import { PromptEditor } from '../components/PromptEditor'
import type { StudioDataState } from '../lib/useStudioData'
import type { PromptDoc } from '../types/prompt'

type ProductionViewProps = {
  data: Extract<StudioDataState, { status: 'ready' }>
  doc: PromptDoc
  setDoc: Dispatch<SetStateAction<PromptDoc>>
}

export function ProductionView({ data, doc, setDoc }: ProductionViewProps) {
  return (
    <section className="view-stack">
      <div className="production-toolbar">
        <div>
          <h2>新建 / 编辑 prompt</h2>
          <p>当前轮次先保留编辑器与实时预览，出图接入留到 RoundF。</p>
        </div>
        <div className="queue-actions">
          <button className="ghost-button" type="button" disabled>
            加入队列 TODO
          </button>
          <button className="primary-button" type="button" disabled>
            出图 TODO
          </button>
        </div>
      </div>
      <PromptEditor state={data} doc={doc} setDoc={setDoc} />
    </section>
  )
}

import { useState } from 'react'
import type { LoraEntry, WorkflowTemplate } from '../../types/production'
import type { Cart } from '../../types'
import type { useComfyUI } from '../../hooks/useComfyUI'
import type { useAssembly } from '../../hooks/useAssembly'
import ConnectionStatus from './ConnectionStatus'
import LoraManager from './LoraManager'
import WorkflowImporter from './WorkflowImporter'
import QuickGenerate from './QuickGenerate'
import AssemblyPanel from '../Assembly/AssemblyPanel'

type ProductionSubTab = 'assembly' | 'generate' | 'loras' | 'workflows'

interface ProductionPanelProps {
  loras: LoraEntry[]
  onLorasChange: (loras: LoraEntry[]) => void
  workflows: WorkflowTemplate[]
  onWorkflowsChange: (wfs: WorkflowTemplate[]) => void
  comfyUI: ReturnType<typeof useComfyUI>
  cart: Cart
  assembly: ReturnType<typeof useAssembly>
  onAddToNaiQueue?: () => void
}

const SUB_TABS: { id: ProductionSubTab; label: string }[] = [
  { id: 'assembly', label: '组装棚' },
  { id: 'generate', label: '快速生产' },
  { id: 'loras', label: 'LoRA管理' },
  { id: 'workflows', label: '工作流' },
]

export default function ProductionPanel({
  loras, onLorasChange, workflows, onWorkflowsChange,
  comfyUI, cart, assembly, onAddToNaiQueue,
}: ProductionPanelProps) {
  const [subTab, setSubTab] = useState<ProductionSubTab>('assembly')

  return (
    <div className="production-panel">
      <div className="production-header">
        <ConnectionStatus conn={comfyUI.conn} onTest={comfyUI.testConnection} />
        <nav className="production-subtabs">
          {SUB_TABS.map(tab => (
            <button
              key={tab.id}
              className={`production-subtab ${subTab === tab.id ? 'active' : ''}`}
              onClick={() => setSubTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="production-content">
        {subTab === 'assembly' && (
          <AssemblyPanel assembly={assembly} cart={cart} onAddToNaiQueue={onAddToNaiQueue} />
        )}
        {subTab === 'generate' && (
          <QuickGenerate
            workflows={workflows}
            loras={loras}
            comfyUI={comfyUI}
            cart={cart}
          />
        )}
        {subTab === 'loras' && (
          <LoraManager
            loras={loras}
            onLorasChange={onLorasChange}
            comfyUI={comfyUI}
          />
        )}
        {subTab === 'workflows' && (
          <WorkflowImporter
            workflows={workflows}
            onWorkflowsChange={onWorkflowsChange}
          />
        )}
      </div>
    </div>
  )
}

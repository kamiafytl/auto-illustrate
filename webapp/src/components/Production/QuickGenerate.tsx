import { useState, useEffect, useCallback } from 'react'
import type { WorkflowTemplate, LoraEntry, TriggerVariant } from '../../types/production'
import { BLOCK_LABELS, BLOCK_ORDER, type PromptBlock, type Cart } from '../../types'
import type { useComfyUI } from '../../hooks/useComfyUI'
import { useJobQueue } from '../../hooks/useJobQueue'
import { resolveWorkflow, type LoraSelection } from '../../utils/workflowResolver'
import JobStatus from './JobStatus'

interface QuickGenerateProps {
  workflows: WorkflowTemplate[]
  loras: LoraEntry[]
  comfyUI: ReturnType<typeof useComfyUI>
  cart: Cart
}

interface LoraSlotState {
  loraId: string
  variantIndex: number
  weight: number
}

const STORAGE_PREFIX = 'owner-qg:'

function saveToStorage(wfId: string, key: string, value: unknown) {
  try { localStorage.setItem(`${STORAGE_PREFIX}${wfId}:${key}`, JSON.stringify(value)) } catch { /* ignore */ }
}

function loadFromStorage<T>(wfId: string, key: string): T | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${wfId}:${key}`)
    return raw ? JSON.parse(raw) as T : null
  } catch { return null }
}

/** 从rawWorkflow中读取节点的text字段默认值 */
function getDefaultText(wf: WorkflowTemplate, nodeId: string): string {
  try {
    const node = wf.rawWorkflow[nodeId] as { inputs?: { text?: string } } | undefined
    return node?.inputs?.text || ''
  } catch { return '' }
}

/** 从rawWorkflow中读取checkpoint默认名 */
function getDefaultCheckpoint(wf: WorkflowTemplate): string {
  if (!wf.checkpointSlot) return ''
  try {
    const node = wf.rawWorkflow[wf.checkpointSlot.nodeId] as { inputs?: Record<string, unknown> } | undefined
    if (!node?.inputs) return ''
    // field是 "inputs.ckpt_name"，取最后一段
    const fieldParts = wf.checkpointSlot.field.split('.')
    const fieldName = fieldParts[fieldParts.length - 1]
    return (node.inputs[fieldName] as string) || ''
  } catch { return '' }
}

export default function QuickGenerate({
  workflows, loras, comfyUI, cart,
}: QuickGenerateProps) {
  // 默认选第一个工作流
  const [selectedWfId, setSelectedWfId] = useState<string>(() => {
    if (workflows.length === 1) return workflows[0].id
    try {
      const stored = localStorage.getItem(`${STORAGE_PREFIX}lastWfId`)
      if (stored && workflows.find(w => w.id === stored)) return stored
    } catch { /* ignore */ }
    return workflows.length > 0 ? workflows[0].id : ''
  })

  const [blockPrompts, setBlockPrompts] = useState<Partial<Record<PromptBlock, string>>>({})
  const [negativePrompt, setNegativePrompt] = useState('')
  const [checkpointName, setCheckpointName] = useState('')
  const [checkpointOptions, setCheckpointOptions] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [loraSlotStates, setLoraSlotStates] = useState<LoraSlotState[]>([])
  const [paramValues, setParamValues] = useState<Record<string, number | string>>({})

  const selectedWf = workflows.find(w => w.id === selectedWfId) || null
  const jobQueue = useJobQueue(comfyUI.submitPrompt, comfyUI.pollHistory)

  // 自动选择：如果当前选的工作流不存在了，选第一个
  useEffect(() => {
    if (workflows.length === 0) return
    if (!selectedWfId || !workflows.find(w => w.id === selectedWfId)) {
      setSelectedWfId(workflows[0].id)
    }
  }, [workflows]) // eslint-disable-line react-hooks/exhaustive-deps

  // 连接成功时获取可用Checkpoint列表
  useEffect(() => {
    if (!comfyUI.conn.connected) return
    setLoadingModels(true)
    comfyUI.fetchModels('checkpoints')
      .then(models => setCheckpointOptions(models))
      .finally(() => setLoadingModels(false))
  }, [comfyUI.conn.connected]) // eslint-disable-line react-hooks/exhaustive-deps

  // 选择工作流时初始化（含localStorage恢复）
  useEffect(() => {
    if (!selectedWf) {
      setBlockPrompts({})
      setNegativePrompt('')
      setCheckpointName('')
      setLoraSlotStates([])
      setParamValues({})
      return
    }

    // 保存上次选的工作流ID
    try { localStorage.setItem(`${STORAGE_PREFIX}lastWfId`, selectedWf.id) } catch { /* ignore */ }

    // 恢复prompt
    const savedPrompts = loadFromStorage<Partial<Record<PromptBlock, string>>>(selectedWf.id, 'prompts')
    if (savedPrompts && Object.keys(savedPrompts).length > 0) {
      setBlockPrompts(savedPrompts)
    } else {
      const prompts: Partial<Record<PromptBlock, string>> = {}
      for (const block of Object.keys(selectedWf.blockSlots)) {
        prompts[block as PromptBlock] = ''
      }
      setBlockPrompts(prompts)
    }

    // 恢复负面词：优先localStorage，否则用rawWorkflow里的默认值
    const savedNeg = loadFromStorage<string>(selectedWf.id, 'negative')
    if (savedNeg !== null) {
      setNegativePrompt(savedNeg)
    } else if (selectedWf.negativeSlot) {
      setNegativePrompt(getDefaultText(selectedWf, selectedWf.negativeSlot))
    } else {
      setNegativePrompt('')
    }

    // 恢复Checkpoint：优先localStorage，否则用rawWorkflow默认
    const savedCkpt = loadFromStorage<string>(selectedWf.id, 'checkpoint')
    if (savedCkpt !== null) {
      setCheckpointName(savedCkpt)
    } else {
      setCheckpointName(getDefaultCheckpoint(selectedWf))
    }

    // 恢复LoRA slots
    const savedLoras = loadFromStorage<LoraSlotState[]>(selectedWf.id, 'loras')
    if (savedLoras && savedLoras.length === selectedWf.loraSlots.length) {
      setLoraSlotStates(savedLoras)
    } else {
      setLoraSlotStates(selectedWf.loraSlots.map(() => ({
        loraId: '',
        variantIndex: 0,
        weight: 1.0,
      })))
    }

    // 恢复参数
    const savedParams = loadFromStorage<Record<string, number | string>>(selectedWf.id, 'params')
    if (savedParams) {
      const params: Record<string, number | string> = {}
      for (const p of selectedWf.otherParams) {
        params[p.name] = savedParams[p.name] ?? p.default
      }
      setParamValues(params)
    } else {
      const params: Record<string, number | string> = {}
      for (const p of selectedWf.otherParams) {
        params[p.name] = p.default
      }
      setParamValues(params)
    }
  }, [selectedWfId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动保存prompt
  const updateBlockPrompts = useCallback((updater: (prev: Partial<Record<PromptBlock, string>>) => Partial<Record<PromptBlock, string>>) => {
    setBlockPrompts(prev => {
      const next = updater(prev)
      if (selectedWfId) saveToStorage(selectedWfId, 'prompts', next)
      return next
    })
  }, [selectedWfId])

  // 自动保存负面词
  const updateNegative = useCallback((value: string) => {
    setNegativePrompt(value)
    if (selectedWfId) saveToStorage(selectedWfId, 'negative', value)
  }, [selectedWfId])

  // 自动保存Checkpoint
  const updateCheckpoint = useCallback((value: string) => {
    setCheckpointName(value)
    if (selectedWfId) saveToStorage(selectedWfId, 'checkpoint', value)
  }, [selectedWfId])

  // 自动保存LoRA slots
  const updateLoraSlots = useCallback((updater: (prev: LoraSlotState[]) => LoraSlotState[]) => {
    setLoraSlotStates(prev => {
      const next = updater(prev)
      if (selectedWfId) saveToStorage(selectedWfId, 'loras', next)
      return next
    })
  }, [selectedWfId])

  // 自动保存参数
  const updateParams = useCallback((updater: (prev: Record<string, number | string>) => Record<string, number | string>) => {
    setParamValues(prev => {
      const next = updater(prev)
      if (selectedWfId) saveToStorage(selectedWfId, 'params', next)
      return next
    })
  }, [selectedWfId])

  // 从当前活跃Cart导入
  const importFromCart = () => {
    if (!selectedWf) return
    const newPrompts: Partial<Record<PromptBlock, string>> = { ...blockPrompts }
    for (const block of BLOCK_ORDER) {
      const items = cart.blocks[block]
      if (!items || items.length === 0) continue
      const text = items.map(item => item.tag.replace(/,\s*$/, '').trim()).filter(Boolean).join(', ')
      if (text) newPrompts[block] = text
    }
    setBlockPrompts(newPrompts)
    if (selectedWfId) saveToStorage(selectedWfId, 'prompts', newPrompts)
  }

  // 生成
  const handleGenerate = async () => {
    if (!selectedWf || !comfyUI.conn.connected) return

    const loraSelections: (LoraSelection | null)[] = loraSlotStates.map(slotState => {
      if (!slotState.loraId) return null
      const entry = loras.find(l => l.id === slotState.loraId)
      if (!entry) return null
      const variant: TriggerVariant = entry.triggerVariants[slotState.variantIndex] || { name: '', tags: '' }
      return { entry, variant, weight: slotState.weight }
    })

    const workflow = resolveWorkflow({
      template: selectedWf,
      blockPrompts,
      negativePrompt: selectedWf.negativeSlot ? negativePrompt : undefined,
      checkpointName: selectedWf.checkpointSlot ? checkpointName : undefined,
      loras: loraSelections,
      params: paramValues,
    })

    await jobQueue.submit(workflow)
  }

  const randomSeed = () => {
    updateParams(prev => ({
      ...prev,
      Seed: Math.floor(Math.random() * 2 ** 32),
    }))
  }

  // 有映射的block列表
  const mappedBlocks = selectedWf
    ? (BLOCK_ORDER.filter(b => selectedWf.blockSlots[b]) as PromptBlock[])
    : []

  return (
    <div className="quick-generate">
      {/* 工作流选择 + 底模选择（同一行） */}
      <div className="generate-top-row">
        <div className="form-row">
          <label>工作流模板</label>
          <select
            value={selectedWfId}
            onChange={e => setSelectedWfId(e.target.value)}
          >
            <option value="">-- 选择工作流模板 --</option>
            {workflows.map(wf => (
              <option key={wf.id} value={wf.id}>{wf.name}</option>
            ))}
          </select>
        </div>

        {selectedWf?.checkpointSlot && (
          <div className="form-row">
            <label>底模 (Checkpoint)</label>
            {loadingModels ? (
              <span className="loading-hint">加载模型列表...</span>
            ) : checkpointOptions.length > 0 ? (
              <select
                value={checkpointName}
                onChange={e => updateCheckpoint(e.target.value)}
              >
                {!checkpointOptions.includes(checkpointName) && checkpointName && (
                  <option value={checkpointName}>{checkpointName} (未找到)</option>
                )}
                {checkpointOptions.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={checkpointName}
                onChange={e => updateCheckpoint(e.target.value)}
                placeholder="模型文件名（如xxx.safetensors）"
              />
            )}
          </div>
        )}
      </div>

      {workflows.length === 0 && (
        <p className="lora-empty">请先在"工作流"子面板导入一个ComfyUI工作流模板。</p>
      )}

      {selectedWf && (
        <>
          {/* Prompt区块 */}
          <div className="generate-section">
            <div className="section-header">
              <h4>Prompt 各区块</h4>
              <button
                className="btn btn-secondary btn-small"
                onClick={importFromCart}
                title={`从当前Cart「${cart.name}」导入`}
              >
                从Cart导入（{cart.name}）
              </button>
            </div>
            {mappedBlocks.map(block => (
              <div key={block} className="prompt-block-row">
                <label>{BLOCK_LABELS[block]}</label>
                <textarea
                  value={blockPrompts[block] || ''}
                  onChange={e => updateBlockPrompts(prev => ({ ...prev, [block]: e.target.value }))}
                  rows={2}
                  placeholder={`${BLOCK_LABELS[block]}的prompt`}
                />
              </div>
            ))}
          </div>

          {/* 负面词 */}
          {selectedWf.negativeSlot && (
            <div className="generate-section">
              <h4>负面词 (Negative)</h4>
              <textarea
                className="negative-prompt-area"
                value={negativePrompt}
                onChange={e => updateNegative(e.target.value)}
                rows={3}
                placeholder="负面prompt（低质量、多余肢体等）"
              />
            </div>
          )}

          {/* LoRA选择 */}
          {selectedWf.loraSlots.length > 0 && (
            <div className="generate-section">
              <h4>LoRA 选择</h4>
              {selectedWf.loraSlots.map((_, slotIdx) => {
                const slotState = loraSlotStates[slotIdx]
                if (!slotState) return null
                const selectedLora = loras.find(l => l.id === slotState.loraId)
                return (
                  <div key={slotIdx} className="lora-slot-row">
                    <span className="slot-label">Slot #{slotIdx + 1}</span>
                    <select
                      value={slotState.loraId}
                      onChange={e => {
                        const newLoraId = e.target.value
                        const newLora = loras.find(l => l.id === newLoraId)
                        updateLoraSlots(prev => {
                          const next = [...prev]
                          next[slotIdx] = {
                            ...next[slotIdx],
                            loraId: newLoraId,
                            variantIndex: 0,
                            weight: newLora ? newLora.defaultWeight : 1.0,
                          }
                          return next
                        })
                      }}
                    >
                      <option value="">（不使用）</option>
                      {loras.map(l => (
                        <option key={l.id} value={l.id}>{l.name || l.filename}</option>
                      ))}
                    </select>

                    {selectedLora && selectedLora.triggerVariants.length > 1 && (
                      <select
                        value={slotState.variantIndex}
                        onChange={e => updateLoraSlots(prev => {
                          const next = [...prev]
                          next[slotIdx] = { ...next[slotIdx], variantIndex: parseInt(e.target.value) }
                          return next
                        })}
                      >
                        {selectedLora.triggerVariants.map((v, vi) => (
                          <option key={vi} value={vi}>{v.name || `变体${vi + 1}`}</option>
                        ))}
                      </select>
                    )}

                    <div className="weight-control">
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={slotState.weight}
                        onChange={e => updateLoraSlots(prev => {
                          const next = [...prev]
                          next[slotIdx] = { ...next[slotIdx], weight: parseFloat(e.target.value) }
                          return next
                        })}
                      />
                      <span className="weight-value">{slotState.weight.toFixed(2)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* 参数 */}
          {selectedWf.otherParams.length > 0 && (
            <div className="generate-section">
              <h4>参数</h4>
              <div className="params-grid">
                {selectedWf.otherParams.map(p => (
                  <div key={p.name} className="param-row">
                    <label>{p.name}</label>
                    <input
                      type={p.type === 'number' ? 'number' : 'text'}
                      value={paramValues[p.name] ?? p.default}
                      onChange={e => updateParams(prev => ({
                        ...prev,
                        [p.name]: p.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value,
                      }))}
                    />
                    {p.name === 'Seed' && (
                      <button className="btn-small btn-secondary" onClick={randomSeed}>随机</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 生成按钮 */}
          <div className="generate-actions">
            <button
              className="btn btn-generate"
              onClick={handleGenerate}
              disabled={!comfyUI.conn.connected || jobQueue.currentJob?.status === 'running'}
            >
              {jobQueue.currentJob?.status === 'running' ? '生成中...' : '生成!'}
            </button>
            {!comfyUI.conn.connected && (
              <span className="generate-warn">ComfyUI未连接</span>
            )}
          </div>

          {/* 执行状态 */}
          <JobStatus job={jobQueue.currentJob} onClear={jobQueue.clear} />
        </>
      )}
    </div>
  )
}

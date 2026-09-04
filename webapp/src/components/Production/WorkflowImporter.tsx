import { useState, useRef, useCallback } from 'react'
import type { WorkflowTemplate, AnalyzedNode, LoraSlot, ParamMapping } from '../../types/production'
import { BLOCK_LABELS, type PromptBlock } from '../../types'
import { analyzeWorkflow, guessBlockFromTitle, extractSamplerParams } from '../../utils/workflowAnalyzer'
import { detectWorkflowFormat, convertUIToAPI, extractWorkflowFromPNG } from '../../utils/workflowConverter'

interface WorkflowImporterProps {
  workflows: WorkflowTemplate[]
  onWorkflowsChange: (wfs: WorkflowTemplate[]) => void
}

type WizardStep = 'list' | 'import' | 'mapping' | 'confirm'

export default function WorkflowImporter({ workflows, onWorkflowsChange }: WorkflowImporterProps) {
  const [step, setStep] = useState<WizardStep>('list')
  const [rawJson, setRawJson] = useState<Record<string, unknown> | null>(null)
  const [analyzedNodes, setAnalyzedNodes] = useState<AnalyzedNode[]>([])
  const [blockMapping, setBlockMapping] = useState<Partial<Record<PromptBlock, string>>>({})
  const [loraSlots, setLoraSlots] = useState<LoraSlot[]>([])
  const [otherParams, setOtherParams] = useState<ParamMapping[]>([])
  const [templateName, setTemplateName] = useState('')
  const [templateDesc, setTemplateDesc] = useState('')
  const [parseError, setParseError] = useState('')
  const [formatInfo, setFormatInfo] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pasteRef = useRef<HTMLTextAreaElement>(null)

  const resetWizard = () => {
    setStep('list')
    setRawJson(null)
    setAnalyzedNodes([])
    setBlockMapping({})
    setLoraSlots([])
    setOtherParams([])
    setTemplateName('')
    setTemplateDesc('')
    setParseError('')
    setFormatInfo('')
  }

  /** 核心解析：接受API格式JSON对象，执行分析并进入映射步骤 */
  const processAPIWorkflow = useCallback((apiJson: Record<string, unknown>, info?: string) => {
    setParseError('')
    const keys = Object.keys(apiJson)
    if (keys.length === 0) {
      setParseError('工作流为空')
      return
    }

    setRawJson(apiJson)
    if (info) setFormatInfo(info)
    const nodes = analyzeWorkflow(apiJson)
    setAnalyzedNodes(nodes)

    // 自动映射block
    const autoMapping: Partial<Record<PromptBlock, string>> = {}
    const clipNodes = nodes.filter(n => n.category === 'clip_text')
    for (const node of clipNodes) {
      const guess = guessBlockFromTitle(node.title)
      if (guess && !autoMapping[guess]) {
        autoMapping[guess] = node.id
      }
    }
    setBlockMapping(autoMapping)

    // 自动识别LoRA slots
    const loraNodes = nodes.filter(n => n.category === 'lora')
    setLoraSlots(loraNodes.map(n => ({
      nodeId: n.id,
      filenameField: 'inputs.lora_name',
      weightField: 'inputs.strength_model',
    })))

    // 自动提取sampler参数
    const samplerNode = nodes.find(n => n.category === 'sampler')
    if (samplerNode) {
      const params = extractSamplerParams(samplerNode)
      setOtherParams(params.map(p => ({
        ...p,
        nodeId: samplerNode.id,
      })))
    }

    setStep('mapping')
  }, [])

  /** 解析JSON字符串，自动检测UI/API格式 */
  const handleParseJson = useCallback((jsonStr: string) => {
    setParseError('')
    try {
      const parsed = JSON.parse(jsonStr)
      const format = detectWorkflowFormat(parsed)

      if (format === 'api') {
        processAPIWorkflow(parsed, 'API格式，直接导入')
      } else if (format === 'ui') {
        const apiJson = convertUIToAPI(parsed)
        processAPIWorkflow(apiJson, `UI格式，已自动转换（${parsed.nodes?.length || 0}个节点）`)
      } else {
        setParseError('无法识别的JSON格式。支持ComfyUI的UI格式和API格式。')
      }
    } catch {
      setParseError('JSON解析失败，请检查格式')
    }
  }, [processAPIWorkflow])

  /** 处理文件（JSON或PNG） */
  const handleFile = useCallback((file: File) => {
    setParseError('')
    const name = file.name.toLowerCase()

    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp')) {
      // 图片文件：尝试从PNG metadata提取工作流
      if (!name.endsWith('.png')) {
        setParseError('只有PNG图片包含ComfyUI工作流metadata。JPG/WebP不支持。')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const result = extractWorkflowFromPNG(reader.result as ArrayBuffer)
        if (!result) {
          setParseError('PNG中未找到ComfyUI工作流信息。确认图片是ComfyUI生成的？')
          return
        }
        // 优先使用prompt（API格式），其次workflow（UI格式）
        if (result.prompt) {
          try {
            const parsed = JSON.parse(result.prompt)
            processAPIWorkflow(parsed, '从PNG metadata提取（API格式）')
          } catch {
            setParseError('PNG中的prompt数据格式错误')
          }
        } else if (result.workflow) {
          handleParseJson(result.workflow)
          setFormatInfo('从PNG metadata提取（UI格式，已转换）')
        }
      }
      reader.readAsArrayBuffer(file)
    } else {
      // JSON文件
      const reader = new FileReader()
      reader.onload = () => handleParseJson(reader.result as string)
      reader.readAsText(file)
    }
  }, [handleParseJson, processAPIWorkflow])

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  /** 拖拽事件 */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)

    const file = e.dataTransfer.files?.[0]
    if (file) {
      handleFile(file)
      return
    }

    // 也尝试从拖拽的文本中解析
    const text = e.dataTransfer.getData('text/plain')
    if (text?.trim()) {
      handleParseJson(text.trim())
    }
  }, [handleFile, handleParseJson])

  const handleSaveTemplate = async () => {
    if (!rawJson || !templateName) return
    const template: WorkflowTemplate = {
      id: `wf-${Date.now()}`,
      name: templateName,
      description: templateDesc,
      rawWorkflow: rawJson,
      blockSlots: blockMapping,
      loraSlots,
      otherParams,
      created: new Date().toISOString().slice(0, 10),
    }

    try {
      await fetch('/api/save-workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: template }),
      })
      onWorkflowsChange([...workflows, template])
      resetWizard()
    } catch (err) {
      console.error('保存工作流失败:', err)
    }
  }

  const deleteWorkflow = async (id: string) => {
    if (!confirm('确定删除这个工作流模板？')) return
    try {
      await fetch('/api/delete-workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      onWorkflowsChange(workflows.filter(w => w.id !== id))
    } catch (err) {
      console.error('删除工作流失败:', err)
    }
  }

  const clipNodes = analyzedNodes.filter(n => n.category === 'clip_text')
  const loraNodes = analyzedNodes.filter(n => n.category === 'lora')
  const samplerNodes = analyzedNodes.filter(n => n.category === 'sampler')

  // === 列表视图 ===
  if (step === 'list') {
    return (
      <div className="workflow-importer">
        <div className="lora-toolbar">
          <button className="btn btn-primary" onClick={() => setStep('import')}>
            + 导入工作流
          </button>
        </div>

        {workflows.length === 0 && (
          <p className="lora-empty">还没有导入的工作流模板。点击"导入工作流"开始。</p>
        )}

        {workflows.length > 0 && (
          <table className="lora-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>描述</th>
                <th>Block映射</th>
                <th>LoRA Slots</th>
                <th>创建日期</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map(wf => (
                <tr key={wf.id}>
                  <td className="lora-name">{wf.name}</td>
                  <td>{wf.description || '-'}</td>
                  <td>{Object.keys(wf.blockSlots).length}个区块</td>
                  <td>{wf.loraSlots.length}个</td>
                  <td>{wf.created}</td>
                  <td className="lora-actions">
                    <button className="btn-small btn-delete" onClick={() => deleteWorkflow(wf.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  // === 导入步骤 ===
  if (step === 'import') {
    return (
      <div className="workflow-importer">
        <div className="wizard-header">
          <h3>导入工作流 — 第1步：导入</h3>
          <button className="btn btn-secondary" onClick={resetWizard}>取消</button>
        </div>

        <div
          className={`drop-zone ${dragging ? 'drop-zone-active' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="drop-zone-content">
            <span className="drop-zone-icon">{dragging ? '↓' : '+'}</span>
            <p className="drop-zone-main">
              {dragging ? '松开导入' : '拖拽文件到这里，或点击选择文件'}
            </p>
            <p className="drop-zone-hint">
              支持：JSON文件（UI格式/API格式均可）、PNG图片（从图片meta提取工作流）
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.png"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
          />
        </div>

        <div className="import-paste">
          <p className="import-paste-label">或直接粘贴JSON：</p>
          <textarea
            ref={pasteRef}
            className="json-paste"
            rows={6}
            placeholder="粘贴ComfyUI工作流JSON（UI格式或API格式均可）..."
          />
          <button
            className="btn btn-secondary"
            onClick={() => {
              const text = pasteRef.current?.value?.trim()
              if (text) handleParseJson(text)
              else setParseError('请先粘贴JSON内容')
            }}
          >
            解析
          </button>
        </div>

        {parseError && <p className="error-text">{parseError}</p>}
      </div>
    )
  }

  // === 映射步骤 ===
  if (step === 'mapping') {
    return (
      <div className="workflow-importer">
        <div className="wizard-header">
          <h3>导入工作流 — 第2步：映射区块</h3>
          <button className="btn btn-secondary" onClick={resetWizard}>取消</button>
        </div>

        {formatInfo && <p className="format-info">{formatInfo}</p>}

        <div className="analysis-summary">
          发现 <strong>{clipNodes.length}</strong> 个CLIP Text Encode,{' '}
          <strong>{loraNodes.length}</strong> 个LoRA Loader,{' '}
          <strong>{samplerNodes.length}</strong> 个Sampler
        </div>

        <div className="mapping-section">
          <h4>Block → CLIP节点映射</h4>
          <p className="mapping-hint">将你的prompt区块（画风、角色等）绑定到工作流中的CLIP节点</p>
          {(Object.entries(BLOCK_LABELS) as [PromptBlock, string][]).map(([block, label]) => {
            const currentNodeId = blockMapping[block] || ''
            const isAutoDetected = currentNodeId && clipNodes.find(n => n.id === currentNodeId && guessBlockFromTitle(n.title) === block)
            return (
              <div key={block} className="mapping-row">
                <span className="mapping-label">{label} [{block}]</span>
                <select
                  value={currentNodeId}
                  onChange={e => setBlockMapping(prev => {
                    const next = { ...prev }
                    if (e.target.value) next[block] = e.target.value
                    else delete next[block]
                    return next
                  })}
                >
                  <option value="">（不映射）</option>
                  {clipNodes.map(n => {
                    // 显示节点的prompt预览（截断）
                    const textPreview = n.inputs.text
                      ? ` — "${String(n.inputs.text).slice(0, 40)}${String(n.inputs.text).length > 40 ? '...' : ''}"`
                      : ''
                    return (
                      <option key={n.id} value={n.id}>
                        节点{n.id}{n.title ? ` "${n.title}"` : ''}{textPreview}
                      </option>
                    )
                  })}
                </select>
                {isAutoDetected && <span className="auto-badge">自动识别</span>}
              </div>
            )
          })}
        </div>

        {loraNodes.length > 0 && (
          <div className="mapping-section">
            <h4>LoRA Slot（{loraNodes.length}个）</h4>
            {loraNodes.map((n, i) => (
              <div key={n.id} className="mapping-row">
                <span className="mapping-label">
                  LoRA #{i + 1} — 节点{n.id}{n.title ? ` "${n.title}"` : ''}
                </span>
                <span className="mapping-info">
                  文件: {(n.inputs.lora_name as string) || '(空)'}
                  , 权重: {String(n.inputs.strength_model ?? '?')}
                </span>
              </div>
            ))}
          </div>
        )}

        {otherParams.length > 0 && (
          <div className="mapping-section">
            <h4>可调参数</h4>
            {otherParams.map((p, i) => (
              <div key={i} className="mapping-row">
                <span className="mapping-label">{p.name}</span>
                <span className="mapping-info">默认值: {String(p.default)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="wizard-actions">
          <button className="btn btn-primary" onClick={() => setStep('confirm')}>
            下一步
          </button>
        </div>
      </div>
    )
  }

  // === 确认保存步骤 ===
  return (
    <div className="workflow-importer">
      <div className="wizard-header">
        <h3>导入工作流 — 第3步：确认保存</h3>
        <button className="btn btn-secondary" onClick={() => setStep('mapping')}>返回</button>
      </div>

      <div className="form-row">
        <label>模板名称</label>
        <input
          type="text"
          value={templateName}
          onChange={e => setTemplateName(e.target.value)}
          placeholder="如：基本带lora、7block标准txt2img"
        />
      </div>

      <div className="form-row">
        <label>描述（可选）</label>
        <textarea
          value={templateDesc}
          onChange={e => setTemplateDesc(e.target.value)}
          rows={2}
          placeholder="如：2个CLIP+4个LoRA位"
        />
      </div>

      <div className="confirm-summary">
        <p>映射 {Object.keys(blockMapping).length} 个区块, {loraSlots.length} 个LoRA Slot, {otherParams.length} 个参数</p>
      </div>

      <div className="wizard-actions">
        <button
          className="btn btn-primary"
          onClick={handleSaveTemplate}
          disabled={!templateName}
        >
          保存模板
        </button>
      </div>
    </div>
  )
}

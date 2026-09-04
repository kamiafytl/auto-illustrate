import type { WorkflowTemplate, LoraEntry, TriggerVariant } from '../types/production'
import type { PromptBlock } from '../types'

export interface LoraSelection {
  entry: LoraEntry
  variant: TriggerVariant
  weight: number
}

interface ResolveInput {
  template: WorkflowTemplate
  blockPrompts: Partial<Record<PromptBlock, string>>
  negativePrompt?: string
  checkpointName?: string
  /** 与template.loraSlots等长的数组，null表示该slot不使用 */
  loras: (LoraSelection | null)[]
  params: Record<string, number | string>
}

function setNestedField(obj: Record<string, unknown>, dotPath: string, value: unknown) {
  const parts = dotPath.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {}
    }
    current = current[parts[i]] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

/**
 * 绕过未使用的LoRA节点：将引用该节点输出的连接重定向到该节点的输入源，然后删除该节点。
 * 效果：LoRA链 A→B→C 中删除B后变成 A→C
 */
function bypassLoraNode(workflow: Record<string, unknown>, nodeId: string) {
  const node = workflow[nodeId] as { inputs?: Record<string, unknown> } | undefined
  if (!node?.inputs) return

  const modelSource = node.inputs.model   // [prevNodeId, outputIndex]
  const clipSource = node.inputs.clip     // [prevNodeId, outputIndex]

  // 找到所有引用此节点输出的连接，重定向到此节点的输入源
  for (const [otherId, otherData] of Object.entries(workflow)) {
    if (otherId === nodeId) continue
    const other = otherData as { inputs?: Record<string, unknown> }
    if (!other.inputs) continue

    for (const [inputName, inputValue] of Object.entries(other.inputs)) {
      if (!Array.isArray(inputValue) || String(inputValue[0]) !== nodeId) continue
      if (inputValue[1] === 0 && modelSource) {
        other.inputs[inputName] = modelSource  // MODEL output → 上游MODEL
      } else if (inputValue[1] === 1 && clipSource) {
        other.inputs[inputName] = clipSource   // CLIP output → 上游CLIP
      }
    }
  }

  delete workflow[nodeId]
}

/** 组装最终可提交到ComfyUI的workflow JSON */
export function resolveWorkflow(input: ResolveInput): Record<string, unknown> {
  const workflow = JSON.parse(JSON.stringify(input.template.rawWorkflow)) as Record<string, unknown>

  // 0. 填充负面prompt
  if (input.template.negativeSlot && input.negativePrompt !== undefined) {
    setNestedField(workflow, `${input.template.negativeSlot}.inputs.text`, input.negativePrompt)
  }

  // 0b. 填充Checkpoint
  if (input.template.checkpointSlot && input.checkpointName) {
    setNestedField(workflow, `${input.template.checkpointSlot.nodeId}.${input.template.checkpointSlot.field}`, input.checkpointName)
  }

  // 1. 填充block prompt到对应CLIP Text Encode节点
  for (const [block, nodeId] of Object.entries(input.template.blockSlots)) {
    if (!nodeId) continue
    const prompt = input.blockPrompts[block as PromptBlock] || ''

    // 收集该block对应的LoRA trigger tags
    const loraTriggersForBlock = input.loras
      .filter((l): l is LoraSelection => l !== null && l.entry.block === block)
      .map(l => l.variant.tags)
      .filter(Boolean)

    const fullPrompt = [prompt, ...loraTriggersForBlock].filter(Boolean).join(', ')
    setNestedField(workflow, `${nodeId}.inputs.text`, fullPrompt)
  }

  // 2. 处理LoRA节点：填充已选的，bypass未选的
  const loraSlots = input.template.loraSlots
  for (let i = 0; i < loraSlots.length; i++) {
    const slot = loraSlots[i]
    const lora = i < input.loras.length ? input.loras[i] : null

    if (lora) {
      setNestedField(workflow, `${slot.nodeId}.${slot.filenameField}`, lora.entry.filename)
      setNestedField(workflow, `${slot.nodeId}.${slot.weightField}`, lora.weight)
    } else {
      bypassLoraNode(workflow, slot.nodeId)
    }
  }

  // 3. 填充其他参数（seed/steps/cfg等）
  for (const mapping of input.template.otherParams) {
    const value = input.params[mapping.name] ?? mapping.default
    setNestedField(workflow, `${mapping.nodeId}.${mapping.field}`, value)
  }

  return workflow
}

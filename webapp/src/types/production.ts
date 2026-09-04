import type { PromptBlock } from './index'

// === LoRA注册表 ===

export interface TriggerVariant {
  name: string       // 变体名（如"标准"、"女仆版"）
  tags: string       // trigger word文本
}

export interface LoraEntry {
  id: string
  filename: string   // LoRA文件名（含扩展名，如 "xxx.safetensors"）
  name: string       // 显示名
  block: PromptBlock // 影响哪个prompt区块
  defaultWeight: number
  triggerVariants: TriggerVariant[]
  note: string
}

// === 工作流模板 ===

export interface LoraSlot {
  nodeId: string
  filenameField: string  // 节点中filename字段路径（如 "inputs.lora_name"）
  weightField: string    // 节点中weight字段路径（如 "inputs.strength_model"）
}

export interface ParamMapping {
  name: string           // 显示名（如 "Seed"）
  nodeId: string
  field: string          // 节点中字段路径（如 "inputs.seed"）
  type: 'number' | 'string'
  default: number | string
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  rawWorkflow: Record<string, unknown>
  blockSlots: Partial<Record<PromptBlock, string>>  // block → CLIP Text Encode節点ID
  negativeSlot?: string                              // 负面prompt的CLIP節点ID
  checkpointSlot?: { nodeId: string; field: string } // Checkpoint選択欄
  loraSlots: LoraSlot[]
  otherParams: ParamMapping[]
  created: string
}

// === 节点分析（导入映射用）===

export interface AnalyzedNode {
  id: string
  classType: string
  title?: string
  category: 'clip_text' | 'lora' | 'sampler' | 'other'
  inputs: Record<string, unknown>
}

// === Job执行 ===

export type JobStatus = 'pending' | 'running' | 'success' | 'error'

export interface JobResult {
  promptId: string
  status: JobStatus
  images?: string[]   // 输出图片URL列表
  error?: string
  startedAt?: string
  completedAt?: string
}

// AssemblyJob已废弃（方案C: CC直连ComfyUI，不再通过前端执行job）

// === ComfyUI连接 ===

export interface ComfyUIConnectionState {
  connected: boolean
  testing: boolean
  env: 'local' | 'autodl'
  url: string
  error?: string
  systemInfo?: {
    comfyuiVersion: string
    gpuName: string
    vramTotal: number
    vramFree: number
  }
}

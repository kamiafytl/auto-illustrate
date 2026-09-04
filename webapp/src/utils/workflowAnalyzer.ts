import type { AnalyzedNode } from '../types/production'
import type { PromptBlock } from '../types'

// 已知的CLIP Text Encode类节点
const CLIP_TEXT_EXACT = new Set([
  'CLIPTextEncode',
  'CLIPTextEncodeSDXL',
  'BNK_CLIPTextEncodeAdvanced',
  'CLIPTextEncodeFlux',
])

// 已知的LoRA Loader类节点
const LORA_EXACT = new Set([
  'LoraLoader',
  'LoraLoaderModelOnly',
  'Power Lora Loader (rgthree)',
])

// 已知的Sampler类节点
const SAMPLER_EXACT = new Set([
  'KSampler',
  'KSamplerAdvanced',
  'SamplerCustom',
  'SamplerCustomAdvanced',
])

function classifyNode(classType: string): AnalyzedNode['category'] {
  // Level 1: 精确匹配
  if (CLIP_TEXT_EXACT.has(classType)) return 'clip_text'
  if (LORA_EXACT.has(classType)) return 'lora'
  if (SAMPLER_EXACT.has(classType)) return 'sampler'

  // Level 2: 模糊匹配
  const lower = classType.toLowerCase()
  if (lower.includes('cliptextencode')) return 'clip_text'
  if (lower.includes('lora') && lower.includes('load')) return 'lora'
  if (lower.includes('sampler') && !lower.includes('scheduler')) return 'sampler'

  return 'other'
}

/** 分析ComfyUI API格式的workflow JSON，识别节点类型 */
export function analyzeWorkflow(raw: Record<string, unknown>): AnalyzedNode[] {
  const nodes: AnalyzedNode[] = []

  for (const [id, nodeData] of Object.entries(raw)) {
    const node = nodeData as Record<string, unknown>
    const classType = node.class_type as string
    if (!classType) continue

    const meta = node._meta as Record<string, string> | undefined
    const inputs = (node.inputs || {}) as Record<string, unknown>

    nodes.push({
      id,
      classType,
      title: meta?.title,
      category: classifyNode(classType),
      inputs,
    })
  }

  return nodes
}

// block标题关键词映射（中英文）
const BLOCK_HINTS: Record<string, PromptBlock> = {
  'style': 'style', '画風': 'style', '画风': 'style', 'quality': 'style',
  'character': 'character', '角色': 'character', 'chara': 'character',
  'clothing': 'clothing', '衣服': 'clothing', 'outfit': 'clothing', 'cloth': 'clothing',
  'action': 'action', '動作': 'action', '动作': 'action', 'pose': 'action',
  'expression': 'expression', '表情': 'expression', 'emotion': 'expression',
  'scene': 'scene', '場景': 'scene', '场景': 'scene', 'background': 'scene',
  'camera': 'camera', '鏡頭': 'camera', '镜头': 'camera', 'pov': 'camera',
  'lighting': 'camera', 'light': 'camera', '光影': 'camera', 'atmosphere': 'camera', '氛围': 'camera', 'composition': 'camera', '构图': 'camera',
}

/** 从节点标题猜测对应的PromptBlock */
export function guessBlockFromTitle(title?: string): PromptBlock | null {
  if (!title) return null
  const lower = title.toLowerCase()
  for (const [hint, block] of Object.entries(BLOCK_HINTS)) {
    if (lower.includes(hint)) return block
  }
  return null
}

/** 从Sampler节点提取可调参数 */
export function extractSamplerParams(node: AnalyzedNode): {
  name: string; field: string; type: 'number' | 'string'; default: number | string
}[] {
  const params: { name: string; field: string; type: 'number' | 'string'; default: number | string }[] = []
  const inputs = node.inputs

  if ('seed' in inputs) params.push({ name: 'Seed', field: 'inputs.seed', type: 'number', default: inputs.seed as number })
  if ('steps' in inputs) params.push({ name: 'Steps', field: 'inputs.steps', type: 'number', default: inputs.steps as number })
  if ('cfg' in inputs) params.push({ name: 'CFG', field: 'inputs.cfg', type: 'number', default: inputs.cfg as number })
  if ('sampler_name' in inputs) params.push({ name: 'Sampler', field: 'inputs.sampler_name', type: 'string', default: inputs.sampler_name as string })
  if ('scheduler' in inputs) params.push({ name: 'Scheduler', field: 'inputs.scheduler', type: 'string', default: inputs.scheduler as string })
  if ('denoise' in inputs) params.push({ name: 'Denoise', field: 'inputs.denoise', type: 'number', default: inputs.denoise as number })

  return params
}

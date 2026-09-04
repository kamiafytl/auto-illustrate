/**
 * ComfyUI UI格式 → API格式 转换器
 *
 * UI格式: { nodes: [...], links: [...], ... }
 * API格式: { "nodeId": { class_type, inputs: {...}, _meta: {...} }, ... }
 *
 * 主要难点：widgets_values 到 input name 的映射
 * - widget inputs 在 node.inputs 中有 widget 属性
 * - widgets_values 按顺序包含所有widget值（含隐藏widget）
 * - 已知隐藏widget：seed/noise_seed 后跟 control_after_generate
 */

interface UINode {
  id: number
  type: string
  title?: string
  mode?: number
  inputs?: UIInput[]
  outputs?: UIOutput[]
  widgets_values?: unknown[]
  properties?: Record<string, unknown>
}

interface UIInput {
  name: string
  type: string
  link: number | null
  widget?: { name: string }
}

interface UIOutput {
  name: string
  type: string
  links: number[] | null
  slot_index?: number
}

// links: [link_id, from_node_id, from_output_index, to_node_id, to_input_index, type_name]
type UILink = [number, number, number, number, number, string]

interface UIWorkflow {
  nodes: UINode[]
  links: UILink[]
  last_node_id?: number
  last_link_id?: number
  [key: string]: unknown
}

// 这些widget后面会跟一个隐藏的control widget
const SEED_WIDGET_NAMES = new Set(['seed', 'noise_seed'])

/** 检测JSON是否为UI格式（有nodes数组）还是API格式（有class_type） */
export function detectWorkflowFormat(json: Record<string, unknown>): 'ui' | 'api' | 'unknown' {
  if (Array.isArray(json.nodes) && Array.isArray(json.links)) {
    return 'ui'
  }
  const keys = Object.keys(json)
  if (keys.length > 0) {
    const first = json[keys[0]] as Record<string, unknown> | undefined
    if (first?.class_type) return 'api'
  }
  return 'unknown'
}

/** 将UI格式工作流转换为API格式 */
export function convertUIToAPI(ui: UIWorkflow): Record<string, unknown> {
  const api: Record<string, unknown> = {}

  // 建立link查找表：link_id → [from_node_id, from_output_index]
  const linkMap = new Map<number, [number, number]>()
  for (const link of ui.links) {
    linkMap.set(link[0], [link[1], link[2]])
  }

  for (const node of ui.nodes) {
    // 跳过被禁用的节点（mode 2 = bypassed, mode 4 = muted）
    if (node.mode === 2 || node.mode === 4) continue

    const nodeId = String(node.id)
    const inputs: Record<string, unknown> = {}

    // 收集widget inputs（按出现顺序）
    const widgetInputs: UIInput[] = []
    if (node.inputs) {
      for (const inp of node.inputs) {
        // 有link的连接型输入：解析为 [nodeId, outputIndex]
        if (inp.link != null) {
          const source = linkMap.get(inp.link)
          if (source) {
            inputs[inp.name] = [String(source[0]), source[1]]
          }
        } else if (inp.widget) {
          // widget输入（无连接）：稍后从widgets_values分配
          widgetInputs.push(inp)
        }
        // 没有link也没有widget的输入（如可选连接输入），跳过
      }
    }

    // 从widgets_values分配值到widget inputs
    if (node.widgets_values && widgetInputs.length > 0) {
      let valIndex = 0
      let widgetIndex = 0

      while (widgetIndex < widgetInputs.length && valIndex < node.widgets_values.length) {
        const wi = widgetInputs[widgetIndex]
        const val = node.widgets_values[valIndex]

        // 跳过数组值（通常是extension添加的隐藏widget，如UE的[false,true]）
        if (Array.isArray(val)) {
          valIndex++
          continue
        }

        inputs[wi.name] = val
        valIndex++
        widgetIndex++

        // seed类widget后面有隐藏的control_after_generate，跳过
        if (SEED_WIDGET_NAMES.has(wi.name)) {
          valIndex++ // skip "randomize"/"fixed"/etc.
        }
      }
    }

    // 处理没有inputs定义但有widgets_values的节点（某些简单节点）
    // 这种情况下无法可靠映射，只保留class_type

    api[nodeId] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title || node.type },
    }
  }

  return api
}

/** 从PNG文件的ArrayBuffer中提取ComfyUI工作流metadata */
export function extractWorkflowFromPNG(buffer: ArrayBuffer): { workflow?: string; prompt?: string } | null {
  const view = new DataView(buffer)

  // 验证PNG签名
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) {
    if (view.getUint8(i) !== PNG_SIGNATURE[i]) return null
  }

  const result: { workflow?: string; prompt?: string } = {}
  let offset = 8

  while (offset < buffer.byteLength) {
    const chunkLength = view.getUint32(offset)
    const chunkType = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    )

    if (chunkType === 'tEXt' || chunkType === 'iTXt') {
      // 读取key-value对
      const dataStart = offset + 8
      const bytes = new Uint8Array(buffer, dataStart, chunkLength)

      // 找到null分隔符
      let nullPos = 0
      while (nullPos < bytes.length && bytes[nullPos] !== 0) nullPos++

      const key = new TextDecoder().decode(bytes.slice(0, nullPos))

      if (key === 'workflow' || key === 'prompt') {
        let valueStart = nullPos + 1
        // iTXt有额外的压缩标志和语言字段，跳过
        if (chunkType === 'iTXt') {
          // 跳过 compression_flag(1) + compression_method(1) + language_tag(null-terminated) + translated_keyword(null-terminated)
          valueStart++ // compression flag
          valueStart++ // compression method
          while (valueStart < bytes.length && bytes[valueStart] !== 0) valueStart++ // language
          valueStart++
          while (valueStart < bytes.length && bytes[valueStart] !== 0) valueStart++ // translated keyword
          valueStart++
        }
        const value = new TextDecoder().decode(bytes.slice(valueStart))
        if (key === 'workflow') result.workflow = value
        if (key === 'prompt') result.prompt = value
      }
    }

    if (chunkType === 'IEND') break

    // 移到下一个chunk: length(4) + type(4) + data(chunkLength) + crc(4)
    offset += 12 + chunkLength
  }

  return (result.workflow || result.prompt) ? result : null
}

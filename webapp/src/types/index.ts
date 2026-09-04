// === 数据类型定义 ===

/** Prompt区块 */
export type PromptBlock = 'style' | 'sub_style' | 'character' | 'clothing' | 'action' | 'expression' | 'scene' | 'camera' | 'effect'

export const BLOCK_LABELS: Record<PromptBlock, string> = {
  style: '画风质量',       // checkpoint/画风/质量tag
  sub_style: '次画风',     // 默认隐私block
  character: '角色特征',   // 身体属性/发型/瞳色等
  clothing: '衣服',        // 衣装/配饰
  action: '动作',          // 体位/姿势
  expression: '表情',      // 表情/情绪
  scene: '场景',           // 纯空间地点（不含光影）
  camera: '镜头机位',      // POV/构图/画面裁切/光影/氛围
  effect: '特殊效果',      // 可叠加效果层（漫画感等），与画风质量分离、独立开关
}

/** Prompt配方 */
export interface Recipe {
  id: string
  name: string
  block: string
  category: string
  group: string
  tags: string
  note: string
  image: string | null
  source: 'legacy' | 'xlsx' | 'manual'
  /** 负面词：出图时并入负向 prompt（NAI 走 char-level negative）。不占用正向 prompt 预算。
   *  典型用途：抑制该衣服易出的错误形态（如帽衫 hood up）。详见 internal-docs「negative_text」节 */
  negative_text?: string
  // 衣服套装专用：10 视角×构图变体（block=clothing && category=套装 时启用）
  // tags 字段 = 基线 = front_full（全身正面）。其余为其他视角×构图组合
  // 与 Character/Outfit 的 ViewVariantTexts 命名对齐
  tags_front_cowboy?: string
  tags_front_upper?: string
  tags_front_mid?: string     // 中身：腰部以下，不含鞋（头出框）
  tags_front_lower?: string   // 下半身：含鞋完整下半身
  tags_back_full?: string
  tags_back_cowboy?: string
  tags_back_upper?: string
  tags_back_mid?: string
  tags_back_lower?: string
  /** @deprecated 旧 4 变体 schema，运行时自动 fallback 到 tags_front_cowboy */
  tags_cowboy?: string
  /** @deprecated 旧 4 变体 schema，运行时自动 fallback 到 tags_front_upper */
  tags_upper?: string
  /** @deprecated 旧 4 变体 schema，运行时自动 fallback 到 tags_back_full */
  tags_back?: string
}

/** 取 Recipe 的某个视角×构图变体文本，带 fallback 链
 *  lower 缺 → 同视角 mid → 同视角 full → 跨视角；back_X 缺 → back_full → front_X → front_full */
export function getRecipeVariant(r: Recipe, perspective: Perspective, composition: Composition): string {
  const key = `${perspective}_${composition}` as ViewKey
  const lookup: Record<ViewKey, string | undefined> = {
    front_full:   r.tags,
    front_cowboy: r.tags_front_cowboy ?? r.tags_cowboy,
    front_upper:  r.tags_front_upper  ?? r.tags_upper,
    front_mid:    r.tags_front_mid,
    front_lower:  r.tags_front_lower,
    back_full:    r.tags_back_full    ?? r.tags_back,
    back_cowboy:  r.tags_back_cowboy,
    back_upper:   r.tags_back_upper,
    back_mid:     r.tags_back_mid,
    back_lower:   r.tags_back_lower,
  }
  if (lookup[key]) return lookup[key] as string
  // lower 缺 → 同视角 mid（鞋差异不影响 mid 渲染，相反 mid 数据可凑合 lower）
  if (composition === 'lower') {
    const midKey = `${perspective}_mid` as ViewKey
    if (lookup[midKey]) return lookup[midKey] as string
  }
  // mid 缺 → 同视角 lower（包含完整下半身数据，多出的鞋 tag 在 mid camera 下被裁出框，无害）
  if (composition === 'mid') {
    const lowerKey = `${perspective}_lower` as ViewKey
    if (lookup[lowerKey]) return lookup[lowerKey] as string
  }
  if (perspective === 'back' && lookup.back_full) return lookup.back_full as string
  const frontKey = `front_${composition}` as ViewKey
  if (lookup[frontKey]) return lookup[frontKey] as string
  return r.tags || ''
}

/** Tag词典条目 */
export interface TagEntry {
  tag: string
  name_zh: string
  block: string
  category: string
  note: string
  image: string | null
}

/** 灵感条目 */
export interface Inspiration {
  id: string
  text: string
  type: '长故事' | '短故事' | '视觉' | 'h视觉'
  image: string | null
  note: string
  created: string
}

/** 研究课题 */
export interface Research {
  id: string
  text: string
  category: string
  status: 'pending' | 'done'
  created: string
}

/** Tab类型 */
export type TabId = 'recipes' | 'tags' | 'inspirations' | 'production' | 'nai-queue' | 'characters' | 'rating' | 'lazydog' | 'next'

/** 视角（独立维度1）：正面 / 背面 */
export type Perspective = 'front' | 'back'

/** 构图（独立维度2）：全身 / 牛仔 / 上半身 / 中身 / 下半身 */
export type Composition = 'full' | 'cowboy' | 'upper' | 'mid' | 'lower'

/** 视角×构图 的组合 key */
export type ViewKey = `${Perspective}_${Composition}`

export const PERSPECTIVES: { id: Perspective; label: string; hint: string }[] = [
  { id: 'front', label: '正面', hint: '面向镜头' },
  { id: 'back', label: '背面', hint: '从背后看（看不到脸）' },
]

export const COMPOSITIONS: { id: Composition; label: string; hint: string }[] = [
  { id: 'full', label: '全身', hint: '完整身体（含鞋）' },
  { id: 'cowboy', label: '牛仔', hint: '大腿以上（不含鞋）' },
  { id: 'upper', label: '上半身', hint: '腰部以上' },
  { id: 'mid', label: '中身', hint: '腰部以下，不含鞋（头出框）' },
  { id: 'lower', label: '下半身', hint: '腰部以下，含鞋（完整下半身）' },
]

/** 10 个组合的完整 key 列表（迭代用） */
export const VIEW_KEYS: ViewKey[] = [
  'front_full', 'front_cowboy', 'front_upper', 'front_mid', 'front_lower',
  'back_full',  'back_cowboy',  'back_upper',  'back_mid',  'back_lower',
]

/** 视角变体的文本集合：10 个组合 */
export interface ViewVariantTexts {
  front_full: string         // 必填基线
  front_cowboy?: string
  front_upper?: string
  front_mid?: string
  front_lower?: string
  back_full?: string
  back_cowboy?: string
  back_upper?: string
  back_mid?: string
  back_lower?: string
}

/**
 * 取指定视角×构图的文本，带 fallback 链：
 *   lower 缺 → 同视角 mid；mid 缺 → 同视角 lower；
 *   back_X 缺 → back_full → front_X → front_full
 */
export function getViewText(
  v: ViewVariantTexts | undefined,
  perspective: Perspective,
  composition: Composition,
): string {
  if (!v) return ''
  const key = `${perspective}_${composition}` as ViewKey
  if (v[key]) return v[key] as string
  // lower/mid 互为兜底
  if (composition === 'lower') {
    const midKey = `${perspective}_mid` as ViewKey
    if (v[midKey]) return v[midKey] as string
  }
  if (composition === 'mid') {
    const lowerKey = `${perspective}_lower` as ViewKey
    if (v[lowerKey]) return v[lowerKey] as string
  }
  if (perspective === 'back' && v.back_full) return v.back_full
  const frontKey = `front_${composition}` as ViewKey
  if (v[frontKey]) return v[frontKey] as string
  return v.front_full || ''
}

/**
 * 旧数据迁移：兼容多代 schema。
 * - 最早期 { full, cowboy?, upper?, back? }：full/cowboy/upper → front_*，back → back_full
 * - 8 变体期（front_lower/back_lower 语义="无鞋下半身"）：自动迁移到 *_mid，腾出 *_lower 给新含鞋语义
 *   迁移逻辑：若同时有 front_lower 且没有 front_mid，则把 front_lower 视为 mid 数据
 *   注意：JSON 数据已离线迁移，此处仅作运行时双保险
 */
export function migrateViewTexts(
  v: { full?: string; cowboy?: string; upper?: string; back?: string } | ViewVariantTexts | undefined,
): ViewVariantTexts {
  if (!v) return { front_full: '' }
  // 已经是新结构（带 front_full 字段）
  if ('front_full' in v && typeof (v as ViewVariantTexts).front_full === 'string') {
    return v as ViewVariantTexts
  }
  const old = v as { full?: string; cowboy?: string; upper?: string; back?: string }
  return {
    front_full: old.full || '',
    front_cowboy: old.cowboy,
    front_upper: old.upper,
    back_full: old.back,
  }
}

// ── 向后兼容（CharacterManager 旧代码可能还在用 ViewVariant 名字）──
// 注意：这个仅用于现有 UI 重构期间的兼容，后续应该全部用 Perspective + Composition
export type ViewVariant = 'full' | 'cowboy' | 'upper' | 'back'
export const VIEW_VARIANTS: { id: ViewVariant; label: string; hint: string }[] = [
  { id: 'full', label: '全身', hint: '完整身体' },
  { id: 'cowboy', label: '牛仔', hint: '大腿以上' },
  { id: 'upper', label: '上半身', hint: '腰部以上' },
  { id: 'back', label: '背面', hint: '背面（已弃用，请用 Perspective+Composition）' },
]

/** 衣服 */
export interface Outfit {
  id: string
  name: string
  preview_image: string | null
  tags: ViewVariantTexts
  note?: string
  /** 衣服级负面词：出图时并入该角色的 char-level negative（与角色级负面词叠加）。
   *  非视角相关（一套词适用全部 10 组合）。典型：帽衫 → hood up。详见 internal-docs */
  negative_text?: string
}

/** 角色 */
export interface Character {
  id: string
  name: string
  preview_image: string | null
  traits: ViewVariantTexts        // 角色特征（含发型、瞳色、脸型、身材等）的视角变体
  outfits: Outfit[]               // 该角色的衣服库
  default_outfit?: string         // 默认衣服 id
  /** 角色级负面词：出图时并入该角色 char-level negative，叠加到该角色所有出图。
   *  典型：默认状态强化（如唯纱 long hair/hair down 默认 → 负面 short hair 等）。
   *  ⚠ 角色级会作用于该角色全部衣服，勿放与自身 cosplay 正向冲突的词（如 twintails）。详见 internal-docs */
  negative_text?: string
  note?: string
  createdAt?: string
  updatedAt?: string
}

/** 批量跑：单个变体（同一区块下的多个 prompt 选项之一） */
export interface NaiBlockVariant {
  id: string
  label: string        // 用户可编辑的标签，默认 "1"/"2"/"3"，用于文件名和 UI 显示
  text: string         // 该变体的 prompt 内容
  enabled: boolean     // 启用开关（可单独禁用某个变体而不删除）
  /** @deprecated 旧字段：每变体跑几张。新模型下总量由 cap 决定，按 round-robin 平摊，本字段忽略 */
  count?: number
}

/** 基础提示词的单个区块（任务内部可自由增删改） */
export interface NaiPromptBlock {
  id: string
  name: string         // 用户可改名（如"画师"、"内容"）
  text: string
  enabled: boolean     // 启用开关（独立于条目级 enabled）
  isPrivate?: boolean  // 跟 Owner 隐私 block 兼容（仅 UI 标识）

  // ── 批量跑（同任务下，本区块换不同内容多次跑）──
  // batchMode=true 时：忽略 text，按 variants 顺序展开，每变体跑 count 张
  // 同一任务内只允许一个区块开启 batchMode（UI 强制约束，避免笛卡尔积爆炸）
  batchMode?: boolean
  variants?: NaiBlockVariant[]
}

/** NAI 角色提示词（对应 V4 的 char_captions） */
export interface NaiCharacterPrompt {
  id: string
  name: string         // 命名，如"女主"
  text: string
  enabled: boolean
  position?: { x: number; y: number } | null  // V4 角色位置，可选
  negative_text?: string                       // V4 char-level 反向提示词，可选
  view?: ViewKey                               // 该槽视角（front_full…）：角色加装层按此选 persona 变体；选角色库/懒狗桥接时固化
}

/** NAI 生成参数（每条任务可选择覆盖全局默认） */
export interface NaiParams {
  model: string
  width: number
  height: number
  steps: number
  scale: number              // Prompt Guidance / CFG scale
  cfg_rescale: number        // Prompt Guidance Rescale
  sampler: string
  noise_schedule: string
  variety_plus: boolean
  auto_position: boolean
  legacy: boolean
  legacy_uc: boolean
  uncond_scale: number
  controlnet_strength: number
  dynamic_thresholding: boolean
  add_original_image: boolean
  qualityToggle: boolean
  ucPreset: number
  negative_prompt: string
  use_random_seed: boolean   // UI 层字段：true=每次随机；false=固定 seed
  seed: number | null
}

/** Precise Reference（角色参考，仅 V4.5）。
 *
 * 与 Vibe Transfer 互斥；每次生成消耗 ~5 Anlas（按参考图数量叠加），无可复用编码。
 * image_b64 = 已在浏览器端 letterbox 到允许画布尺寸的 PNG base64（不含 data: 前缀）。
 * 联动：与 vite.config.ts buildParameters 的 director_reference_* 注入、
 *      tools/submit_nai.py build_char_reference 保持一致（见 internal-docs）。
 */
/** Director Reference 的三种参考模式（官网 Reference Type），直接写 NAI base_caption 值。 */
export type CharRefMode = 'character&style' | 'character' | 'style'
export const CHAR_REF_MODES: Array<{ value: CharRefMode; label: string }> = [
  { value: 'character&style', label: '角色 + 画风（Character & Style）' },
  { value: 'character', label: '仅角色身份（Character）' },
  { value: 'style', label: '仅画风（Style）' },
]

export interface CharReference {
  image_b64: string          // 已 letterbox 的 PNG base64
  strength: number           // 0-1，模仿参考图视觉特征的强度
  fidelity: number           // 0-1，越高越严格还原（API 写入 1-fidelity）
  base_caption: CharRefMode  // 三选一：character&style / character / style
  fileName?: string          // 仅 UI 显示用
}

/** 兼容旧持久化数据（曾用布尔 style_aware）→ 归一化出 base_caption。 */
export function charRefMode(cr: { base_caption?: CharRefMode; style_aware?: boolean } | null | undefined): CharRefMode {
  if (cr?.base_caption) return cr.base_caption
  return cr?.style_aware ? 'character&style' : 'character'
}

/** 加装内容单元的【归属/门控标签】—— 决定该内容在哪种 cast(本图出场女主) 下激活。
 *  main=主要：无条件 always 装（=旧行为，向后兼容：老预设/新增框默认 main）。
 *  f1=女1、f2=女2：仅当该女出现在本图 cast 里才装；出场女主按 f1<f2 顺序【紧凑落槽·永远排最前】(单女2→第1槽)。
 *  other=其他：女3+ 手写标签(roleLabel，如 "女3")，默认不装，除非用户点名。
 *  ⚠【本期只存不消费】submit_nai.py 运行时仍全量套用，按 cast 过滤属于「跑图接口」形状、留接单阶段实现。
 *  详见 internal-docs「加装预设」节的 cast 接口形状。 */
export type AugRole = 'main' | 'f1' | 'f2' | 'other'

/** 提示词加装的【额外框】—— 每个正/负框都能「+加一条」派生同类额外框，各带独立归属。
 *  用途：一套加装层同时要「主要」内容 + 「女2/特殊」专属内容时，靠额外框给特殊留空间。
 *  与既有 base_positive/base_negative 单框【并存】：base_* 是主框(不动)，extra_blocks 是追加框。
 *  隐私：isPrivate 时 text 移入 nai_augment_private.json 的 blob.extra[id]（镜像 chars 的成熟安全模式），公开侧置空。
 *  联动登记见 internal-docs「加装预设」节。 */
export interface AugExtraBlock {
  id: string
  kind: 'positive' | 'negative'          // 拼到正面还是负面
  text: string
  role: AugRole; roleLabel?: string
  position: 'prefix' | 'suffix'
  isPrivate: boolean
  enabled: boolean
}

/** 替换规则（加装预设 / 角色加装层共用）。注入加装内容之后的最后一道全文替换。 */
export interface ReplRule { id: string; from: string; to: string; enabled: boolean; wholeWord: boolean; isPrivate: boolean; role?: AugRole; roleLabel?: string }

/** 角色加装层（Character Augmentation Layer）—— 可复用的【单角色】私设单元（如 "adult woman A"）。
 *
 *  与 augmentation_presets 独立并存：preset 是「整套图一个 bundle」，角色加装层是「单角色、可指派到任意角色槽」。
 *  AI 只认 name/id、读不到 persona 内容（隐私存 data/nai_character_layers_private.json，submit 脚本提交时合并）。
 *  ⚠ 参考图为整图级——NAI 多图合法但为【整图 blend·非逐槽绑定】（docs precisereference），提交时多层现只取第一张 enabled 生效（多张聚合=可选未来项）。
 *  联动：data/nai_config.json character_layers / server/plugins/nai.ts / tools/submit_nai.py / NaiBatchPanel，见 internal-docs。 */
export interface CharLayerPersona {
  text: ViewVariantTexts          // 角色身份 persona 的 10 视角变体（front_full 基线·其余回落，对标 Character.traits）
  negative: string                // 负面词单条（角色库 negative_text 亦单条；背面负向钉死由出图组装阶段管）
  position: 'prefix' | 'suffix'   // persona 拼在被指派角色槽 prompt 的前/后
  isPrivate: boolean
}
export interface CharLayer {
  id: string
  name: string                    // AI 只认这个，如 "adult woman A"
  enabled: boolean
  persona: CharLayerPersona
  char_reference: CharReference & { enabled: boolean; isPrivate: boolean }
  replacements: { enabled: boolean; rules: ReplRule[] }
}

/** NAI 任务（= 预设档）。
 *
 * 重要：任务列表是预设库（每个任务存一套 prompt+角色+参数配置），
 * 不是执行队列。点 ▶ 跑的只是当前 active 的那个任务，跑 cap (number_of_requests) 张。
 * 用户切换 tab 切换 active 预设；多任务串行执行的概念已废弃。
 */
export interface NaiBatchItem {
  id: string
  comment: string

  baseBlocks: NaiPromptBlock[]            // 自由的基础提示词区块列表
  characters: NaiCharacterPrompt[]        // 角色提示词列表

  paramsOverride: Partial<NaiParams>      // 仅存用户覆盖的字段，其余取全局默认
  charReference?: CharReference | null    // Precise Reference 角色参考（可选，仅 V4.5）
  augment?: boolean                       // 过固定加装层(activeId)：提交走 submit_nai.py --augment（换AW 的 persona 靠它补）。默认 false=不套
  charLayerAssign?: Record<number, string> // 角色加装层指派：角色槽 index(0-based) → CharLayer.id；提交走 submit_nai.py --char-layers。map 不绑死顺序=第二期 N 角色不堵死

  // 运行时状态（仅记录上次跑图的结果，用于 UI 显示）
  status?: 'pending' | 'running' | 'done' | 'error'
  generatedImages?: string[]
  generatedCount?: number
  errorMessage?: string
}

/** NAI 执行队列中的单个作业（= 某个预设跑 N 张到一个独立子文件夹）。
 *
 * 与 NaiBatchItem（预设档）的关系：作业通过 itemId 指向预设，prompt 在每张图提交前
 * 实时从 plan.items 读取（支持运行中编辑预设立即生效）。同一预设可被多次入队
 * （= "再加一批"）。运行中可继续入队，当前作业跑完自动接下一个。
 */
export interface NaiQueueJob {
  id: string
  itemId: string              // 指向 plan.items 的预设 id
  comment: string             // 入队时快照的预设名（用于显示，预设改名/删除不影响）
  target: number              // 本作业目标张数
  produced: number            // 已生成张数
  subfolder: string | null    // 作业首次开始时分配（时间戳），同作业同子文件夹
  images: string[]            // 本作业已生成的图片路径
  status: 'queued' | 'running' | 'paused' | 'done' | 'error'
  errorMessage?: string
}

/** NAI批量计划（一个保存的队列） */
export interface NaiBatchPlan {
  id: string
  name: string
  items: NaiBatchItem[]
  createdAt: string
  updatedAt: string
}

/** Block输出排序 */
export const BLOCK_ORDER: PromptBlock[] = ['style', 'sub_style', 'character', 'clothing', 'action', 'expression', 'scene', 'camera', 'effect']

/** Block内配方关系类型 */
export type BlockRelationType = 'and' | 'or' | 'blend' | 'schedule'

/** Block内配方关系 */
export interface BlockRelation {
  type: BlockRelationType
  weights: number[]  // 每个recipe一个权重，blend/schedule用，and/or忽略
}

/** Cart条目 */
export interface CartItem {
  type: 'recipe' | 'tag' | 'component'
  tag: string        // prompt文本（输出用）
  name_zh: string    // 中文名（仅UI显示，不输出）
  sourceId: string   // 去重标识
}

/** 小车（Prompt组装台） */
export interface Cart {
  id: string
  name: string
  blocks: Record<string, CartItem[]>
  blockRelations: Record<string, BlockRelation>  // block内配方关系
  created: string
}

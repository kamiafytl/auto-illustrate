import { useState, useCallback, useEffect, useRef } from 'react'
import {
  BLOCK_ORDER, BLOCK_LABELS,
  type NaiBatchItem, type NaiBatchPlan, type NaiPromptBlock, type NaiBlockVariant,
  type NaiCharacterPrompt, type PromptBlock,
} from '../types'

const DRAFT_KEY = 'owner-nai-batch:draft'

// 默认基础提示词模板（数组结构，可含任意 name 的 block，如"画师串"）
export interface DefaultBaseBlock {
  name: string
  text: string
  enabled?: boolean
  isPrivate?: boolean
}

function genId(prefix = ''): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 把 nai_config 的 default_base_blocks（可能是旧 Record 或新数组）规整为数组
function normalizeDefaults(defaults?: DefaultBaseBlock[] | Record<string, string>): DefaultBaseBlock[] {
  if (Array.isArray(defaults)) return defaults
  if (defaults && typeof defaults === 'object') {
    // 旧 Record 兼容：按 BLOCK_ORDER 顺序展开
    return BLOCK_ORDER.map(b => ({
      name: BLOCK_LABELS[b],
      text: defaults[b] || '',
      enabled: !!(defaults[b] || '').trim(),
      isPrivate: b === 'sub_style' ? true : undefined,
    }))
  }
  return []
}

// 构造默认的基础区块列表。defaults 为空时返回空数组（让 UI 强制用户配置）。
export function makeDefaultBaseBlocks(defaults?: DefaultBaseBlock[] | Record<string, string>): NaiPromptBlock[] {
  const arr = normalizeDefaults(defaults)
  if (arr.length === 0) {
    // 兜底：至少有 8 个 Owner 标准 block 留作展开
    return BLOCK_ORDER.map(b => ({
      id: genId(`b_${b}_`),
      name: BLOCK_LABELS[b],
      text: '',
      enabled: false,
      isPrivate: b === 'sub_style' ? true : undefined,
    }))
  }
  return arr.map(d => ({
    id: genId(`b_${d.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 12)}_`),
    name: d.name,
    text: d.text || '',
    enabled: d.enabled ?? !!d.text?.trim(),
    isPrivate: d.isPrivate,
  }))
}

// 从组装棚的 blocks 状态生成 baseBlocks（启用状态根据是否有内容决定）
export function snapshotAssemblyToBaseBlocks(
  src: Record<PromptBlock, { text: string; isPrivate: boolean }>
): NaiPromptBlock[] {
  return BLOCK_ORDER.map(b => {
    const data = src[b]
    const text = data?.text?.trim() || ''
    return {
      id: genId(`b_${b}_`),
      name: BLOCK_LABELS[b],
      text: data?.text || '',
      enabled: !!text,
      isPrivate: data?.isPrivate,
    }
  })
}

function emptyItem(defaults?: DefaultBaseBlock[] | Record<string, string>): NaiBatchItem {
  return {
    id: genId('item_'),
    comment: '新任务',
    baseBlocks: makeDefaultBaseBlocks(defaults),
    characters: [],
    paramsOverride: {},
    status: 'pending',
    generatedCount: 0,
    generatedImages: [],
  }
}

function emptyDraft(): NaiBatchPlan {
  return {
    id: 'draft',
    name: '草稿',
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

// 旧草稿迁移（兼容删除 enabled/count 之前的格式）
type LegacyItem = {
  id: string; comment: string
  count?: number; enabled?: boolean  // 已废弃字段（迁移时丢弃）
  blocks?: Record<string, { text: string; isPrivate: boolean }>
  baseBlocks?: NaiPromptBlock[]
  characters?: NaiCharacterPrompt[]
  paramsOverride?: Record<string, unknown>
  status?: NaiBatchItem['status']
  generatedImages?: string[]; generatedCount?: number; errorMessage?: string
}

function migrateItem(it: NaiBatchItem | LegacyItem): NaiBatchItem {
  const anyIt = it as Record<string, unknown>
  if (Array.isArray(anyIt.baseBlocks)) {
    // 已是 baseBlocks 结构，丢弃 enabled/count 旧字段
    const ll = it as LegacyItem
    return {
      id: ll.id,
      comment: ll.comment,
      baseBlocks: ll.baseBlocks!,
      characters: ll.characters || [],
      paramsOverride: (ll.paramsOverride || {}) as NaiBatchItem['paramsOverride'],
      status: ll.status,
      generatedCount: ll.generatedCount,
      generatedImages: ll.generatedImages,
      errorMessage: ll.errorMessage,
    }
  }
  // 更老的结构: blocks: Record<PromptBlock, {text, isPrivate}>
  const oldBlocks = (it as LegacyItem).blocks || {}
  const baseBlocks: NaiPromptBlock[] = BLOCK_ORDER.map(b => {
    const data = oldBlocks[b]
    const text = data?.text || ''
    return {
      id: genId(`b_${b}_`),
      name: BLOCK_LABELS[b],
      text,
      enabled: !!text.trim(),
      isPrivate: data?.isPrivate,
    }
  })
  return {
    id: it.id,
    comment: it.comment,
    baseBlocks,
    characters: [],
    paramsOverride: (it.paramsOverride || {}) as NaiBatchItem['paramsOverride'],
    status: it.status,
    generatedCount: it.generatedCount,
    generatedImages: it.generatedImages,
    errorMessage: it.errorMessage,
  }
}

function loadDraft(): NaiBatchPlan {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return emptyDraft()
    const parsed = JSON.parse(raw) as NaiBatchPlan
    if (!Array.isArray(parsed.items)) return emptyDraft()
    return { ...parsed, items: parsed.items.map(migrateItem) }
  } catch {
    return emptyDraft()
  }
}

/**
 * NAI 批量队列状态管理。
 *
 * - 当前编辑的 plan（草稿）存 localStorage
 * - 命名保存 → POST 到 data/batch_plans/{id}.json
 */
export function useNaiBatch() {
  const [plan, setPlan] = useState<NaiBatchPlan>(() => loadDraft())
  const [savedPlans, setSavedPlans] = useState<{ id: string; name: string; updatedAt: string; itemCount: number }[]>([])
  // 默认基础提示词模板（由外部 NaiBatchPanel 通过 setDefaultBaseBlocks 注入）
  const defaultBaseBlocksRef = useRef<DefaultBaseBlock[]>([])
  const setDefaultBaseBlocks = useCallback((defaults: DefaultBaseBlock[] | Record<string, string>) => {
    defaultBaseBlocksRef.current = normalizeDefaults(defaults)
  }, [])
  const planRef = useRef(plan)
  planRef.current = plan

  // 自动保存草稿
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(plan)) } catch { /* ignore */ }
  }, [plan])

  const refreshSavedList = useCallback(async () => {
    try {
      const resp = await fetch('/api/batch-plans')
      const data = await resp.json()
      if (Array.isArray(data)) setSavedPlans(data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { refreshSavedList() }, [refreshSavedList])

  // ── 条目级操作 ──

  const addItem = useCallback((opts?: Partial<NaiBatchItem>) => {
    const item: NaiBatchItem = { ...emptyItem(defaultBaseBlocksRef.current), ...opts }
    setPlan(p => ({ ...p, items: [...p.items, item], updatedAt: new Date().toISOString() }))
    return item.id
  }, [])

  const addItemFromAssembly = useCallback((assemblyBlocks: Record<PromptBlock, { text: string; isPrivate: boolean }>, opts?: { comment?: string }) => {
    // 从组装棚导入时：以 defaults 为骨架，name 匹配到 Owner BLOCK_LABELS 的 block 用组装棚的内容覆盖（如果非空）
    const defaults = defaultBaseBlocksRef.current
    const labelToBlockKey = new Map<string, PromptBlock>()
    BLOCK_ORDER.forEach(b => labelToBlockKey.set(BLOCK_LABELS[b], b))

    const blocks: NaiPromptBlock[] = makeDefaultBaseBlocks(defaults).map(b => {
      const blockKey = labelToBlockKey.get(b.name)
      if (!blockKey) return b  // 非 Owner block（如"画师串"）保留 default
      const asm = assemblyBlocks[blockKey]
      if (asm?.text?.trim()) {
        return { ...b, text: asm.text, enabled: true, isPrivate: asm.isPrivate ?? b.isPrivate }
      }
      return b
    })

    const item: NaiBatchItem = {
      ...emptyItem(defaults),
      comment: opts?.comment || `任务 ${planRef.current.items.length + 1}`,
      baseBlocks: blocks,
    }
    setPlan(p => ({ ...p, items: [...p.items, item], updatedAt: new Date().toISOString() }))
    return item.id
  }, [])

  const updateItem = useCallback((id: string, patch: Partial<NaiBatchItem>) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it => it.id === id ? { ...it, ...patch } : it),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const removeItem = useCallback((id: string) => {
    setPlan(p => ({
      ...p,
      items: p.items.filter(it => it.id !== id),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const moveItem = useCallback((id: string, direction: 'up' | 'down') => {
    setPlan(p => {
      const idx = p.items.findIndex(it => it.id === id)
      if (idx < 0) return p
      const target = direction === 'up' ? idx - 1 : idx + 1
      if (target < 0 || target >= p.items.length) return p
      const items = [...p.items]
      ;[items[idx], items[target]] = [items[target], items[idx]]
      return { ...p, items, updatedAt: new Date().toISOString() }
    })
  }, [])

  const duplicateItem = useCallback((id: string) => {
    setPlan(p => {
      const src = p.items.find(it => it.id === id)
      if (!src) return p
      const copy: NaiBatchItem = {
        ...src,
        id: genId('item_'),
        comment: `${src.comment} (副本)`,
        status: 'pending',
        generatedCount: 0,
        generatedImages: [],
        errorMessage: undefined,
        baseBlocks: src.baseBlocks.map(b => ({ ...b, id: genId('b_') })),
        characters: src.characters.map(c => ({ ...c, id: genId('c_') })),
      }
      const idx = p.items.findIndex(it => it.id === id)
      const items = [...p.items.slice(0, idx + 1), copy, ...p.items.slice(idx + 1)]
      return { ...p, items, updatedAt: new Date().toISOString() }
    })
  }, [])

  const clearAll = useCallback(() => {
    if (!confirm('清空当前队列？已生成的图片不会被删除。')) return
    setPlan(emptyDraft())
  }, [])

  // ── 区块级操作 ──

  const addBlock = useCallback((itemId: string, opts?: Partial<NaiPromptBlock>) => {
    const block: NaiPromptBlock = {
      id: genId('b_'),
      name: opts?.name || '新区块',
      text: opts?.text || '',
      enabled: opts?.enabled ?? true,
    }
    setPlan(p => ({
      ...p,
      items: p.items.map(it =>
        it.id === itemId ? { ...it, baseBlocks: [...it.baseBlocks, block] } : it
      ),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const updateBlock = useCallback((itemId: string, blockId: string, patch: Partial<NaiPromptBlock>) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it =>
        it.id === itemId
          ? { ...it, baseBlocks: it.baseBlocks.map(b => b.id === blockId ? { ...b, ...patch } : b) }
          : it
      ),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const removeBlock = useCallback((itemId: string, blockId: string) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it =>
        it.id === itemId ? { ...it, baseBlocks: it.baseBlocks.filter(b => b.id !== blockId) } : it
      ),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const moveBlock = useCallback((itemId: string, blockId: string, direction: 'up' | 'down') => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it => {
        if (it.id !== itemId) return it
        const idx = it.baseBlocks.findIndex(b => b.id === blockId)
        if (idx < 0) return it
        const target = direction === 'up' ? idx - 1 : idx + 1
        if (target < 0 || target >= it.baseBlocks.length) return it
        const bs = [...it.baseBlocks]
        ;[bs[idx], bs[target]] = [bs[target], bs[idx]]
        return { ...it, baseBlocks: bs }
      }),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  // ── 批量跑变体操作 ──
  // 约束：同一任务内只允许一个区块开启 batchMode
  // 开启某个 block 的 batchMode 时，会自动关闭同任务内其他 block 的 batchMode

  const setBlockBatchMode = useCallback((itemId: string, blockId: string, enabled: boolean) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it => {
        if (it.id !== itemId) return it
        return {
          ...it,
          baseBlocks: it.baseBlocks.map(b => {
            if (b.id === blockId) {
              // 启用时：若无 variants 则从 text 创建第一个
              const variants = b.variants && b.variants.length > 0
                ? b.variants
                : (enabled
                    ? [{ id: genId('v_'), label: '1', text: b.text || '', enabled: true }]
                    : b.variants)
              return { ...b, batchMode: enabled, variants }
            }
            // 启用某 block 时，关闭其他 block 的 batchMode（单区块约束）
            if (enabled && b.batchMode) return { ...b, batchMode: false }
            return b
          }),
        }
      }),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const addVariant = useCallback((itemId: string, blockId: string) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it => {
        if (it.id !== itemId) return it
        return {
          ...it,
          baseBlocks: it.baseBlocks.map(b => {
            if (b.id !== blockId) return b
            const list = b.variants || []
            const nextLabel = String(list.length + 1)
            const v: NaiBlockVariant = {
              id: genId('v_'), label: nextLabel, text: '', enabled: true,
            }
            return { ...b, variants: [...list, v] }
          }),
        }
      }),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const updateVariant = useCallback((itemId: string, blockId: string, variantId: string, patch: Partial<NaiBlockVariant>) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it => {
        if (it.id !== itemId) return it
        return {
          ...it,
          baseBlocks: it.baseBlocks.map(b => {
            if (b.id !== blockId) return b
            return {
              ...b,
              variants: (b.variants || []).map(v => v.id === variantId ? { ...v, ...patch } : v),
            }
          }),
        }
      }),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const removeVariant = useCallback((itemId: string, blockId: string, variantId: string) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it => {
        if (it.id !== itemId) return it
        return {
          ...it,
          baseBlocks: it.baseBlocks.map(b => {
            if (b.id !== blockId) return b
            return {
              ...b,
              variants: (b.variants || []).filter(v => v.id !== variantId),
            }
          }),
        }
      }),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const moveVariant = useCallback((itemId: string, blockId: string, variantId: string, direction: 'up' | 'down') => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it => {
        if (it.id !== itemId) return it
        return {
          ...it,
          baseBlocks: it.baseBlocks.map(b => {
            if (b.id !== blockId) return b
            const list = b.variants || []
            const idx = list.findIndex(v => v.id === variantId)
            if (idx < 0) return b
            const target = direction === 'up' ? idx - 1 : idx + 1
            if (target < 0 || target >= list.length) return b
            const next = [...list]
            ;[next[idx], next[target]] = [next[target], next[idx]]
            return { ...b, variants: next }
          }),
        }
      }),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  // ── 角色操作 ──

  const addCharacter = useCallback((itemId: string, opts?: Partial<NaiCharacterPrompt>) => {
    const c: NaiCharacterPrompt = {
      id: genId('c_'),
      name: opts?.name || `角色 ${(planRef.current.items.find(i => i.id === itemId)?.characters.length ?? 0) + 1}`,
      text: opts?.text || '',
      enabled: opts?.enabled ?? true,
      position: opts?.position,
    }
    setPlan(p => ({
      ...p,
      items: p.items.map(it =>
        it.id === itemId ? { ...it, characters: [...it.characters, c] } : it
      ),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const updateCharacter = useCallback((itemId: string, charId: string, patch: Partial<NaiCharacterPrompt>) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it =>
        it.id === itemId
          ? { ...it, characters: it.characters.map(c => c.id === charId ? { ...c, ...patch } : c) }
          : it
      ),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  const removeCharacter = useCallback((itemId: string, charId: string) => {
    setPlan(p => ({
      ...p,
      items: p.items.map(it =>
        it.id === itemId ? { ...it, characters: it.characters.filter(c => c.id !== charId) } : it
      ),
      updatedAt: new Date().toISOString(),
    }))
  }, [])

  // ── 计划级别 ──

  const savePlanAs = useCallback(async (name: string): Promise<boolean> => {
    if (!name.trim()) return false
    const id = `plan_${Date.now()}_${name.replace(/[^a-zA-Z0-9_一-龥]/g, '_').slice(0, 30)}`
    const toSave: NaiBatchPlan = {
      ...planRef.current,
      id,
      name: name.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: planRef.current.items.map(it => ({
        ...it,
        status: 'pending',
        generatedCount: 0,
        generatedImages: [],
        errorMessage: undefined,
      })),
    }
    try {
      const resp = await fetch('/api/batch-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSave),
      })
      if (!resp.ok) return false
      await refreshSavedList()
      return true
    } catch { return false }
  }, [refreshSavedList])

  const loadPlan = useCallback(async (id: string) => {
    try {
      const resp = await fetch(`/api/batch-plans/${id}`)
      if (!resp.ok) return false
      const data: NaiBatchPlan = await resp.json()
      const migrated = { ...data, items: data.items.map(migrateItem) }
      setPlan({ ...migrated, id: 'draft', name: data.name + '（编辑中）' })
      return true
    } catch { return false }
  }, [])

  const deletePlan = useCallback(async (id: string) => {
    if (!confirm('删除这个保存的计划？')) return
    try {
      await fetch(`/api/batch-plans/${id}`, { method: 'DELETE' })
      await refreshSavedList()
    } catch { /* ignore */ }
  }, [refreshSavedList])

  // 注意：plan.items 是预设档库，不是执行队列。
  // 实际跑图张数 = nai_config.batch.number_of_requests (cap)，批量模式下按 round-robin 平摊给变体。

  return {
    plan,
    setPlan,
    savedPlans,
    setDefaultBaseBlocks,

    // 条目
    addItem,
    addItemFromAssembly,
    updateItem,
    removeItem,
    moveItem,
    duplicateItem,
    clearAll,

    // 区块
    addBlock,
    updateBlock,
    removeBlock,
    moveBlock,

    // 变体（批量跑）
    setBlockBatchMode,
    addVariant,
    updateVariant,
    removeVariant,
    moveVariant,

    // 角色
    addCharacter,
    updateCharacter,
    removeCharacter,

    // 计划
    savePlanAs,
    loadPlan,
    deletePlan,
    refreshSavedList,

    // 派生
    itemCount: plan.items.length,
  }
}

// 把基础区块拼成完整 prompt（启用 + 非空，用 BREAK 分隔）
export function buildBasePrompt(blocks: NaiPromptBlock[]): string {
  return blocks
    .filter(b => b.enabled && b.text.trim())
    .map(b => b.text.replace(/,\s*$/, '').trim() + ',')
    .join('\n\nBREAK\n\n')
}

// 把 blocks 拼成 prompt，但其中某个 block（targetId）的内容用 overrideText 替换
function buildBasePromptWithOverride(blocks: NaiPromptBlock[], targetId: string, overrideText: string): string {
  return blocks
    .filter(b => {
      if (b.id === targetId) return !!overrideText.trim()
      return b.enabled && b.text.trim()
    })
    .map(b => {
      const text = b.id === targetId ? overrideText : b.text
      return text.replace(/,\s*$/, '').trim() + ','
    })
    .join('\n\nBREAK\n\n')
}

/**
 * 把一个任务展开成长度 = target 的运行序列（每张图一项），变体按 round-robin 平摊。
 *
 * - 无 batchMode 区块 / 无 enabled 变体：所有项指向 base prompt，variantLabel = null
 * - 有 batchMode 区块：
 *   - 5 张 + 3 变体：v1, v2, v3, v1, v2（i % N 选变体，交错而非分块）
 *   - 这样早期就能看到每个变体效果，便于及早发现某变体异常
 *
 * 注意：单任务最多一个 batchMode 区块（在 setBlockBatchMode 强制）
 */
export interface ExpandedRun {
  positive: string
  variantLabel: string | null  // null = 该任务无变体；否则为变体 label
}

export function expandItemSequence(item: NaiBatchItem, target: number): ExpandedRun[] {
  if (target <= 0) return []
  const batchBlock = item.baseBlocks.find(b => b.batchMode && b.enabled)
  const variants = batchBlock?.variants?.filter(v => v.enabled && v.text.trim()) || []

  if (!batchBlock || variants.length === 0) {
    const positive = buildBasePrompt(item.baseBlocks)
    return Array.from({ length: target }, () => ({ positive, variantLabel: null }))
  }

  // 预计算每个变体的 prompt，避免循环里重复 build
  const variantPrompts = variants.map(v => ({
    label: v.label,
    positive: buildBasePromptWithOverride(item.baseBlocks, batchBlock.id, v.text),
  }))
  return Array.from({ length: target }, (_, i) => {
    const vp = variantPrompts[i % variantPrompts.length]
    return { positive: vp.positive, variantLabel: vp.label }
  })
}

/**
 * 取 round-robin 序列中第 i 张图的 prompt（实时读 item 当前 state）。
 *
 * 与 expandItemSequence 的区别：后者在 runQueue 开跑时一次性展开整个序列，
 * 一旦展开就锁死 prompt；本函数每次只算一张，让 runQueue 每张图都能拿到
 * 用户最新编辑的 prompt 内容（实现"提交那一刻的 prompt 为准"）。
 *
 * 注意：变体列表中途变化时，i % variants.length 按当前列表长度走，
 * 也就是用户中途增删变体后，round-robin 在新列表上继续，符合"用户编辑即生效"语义。
 */
export function getVariantAtIndex(item: NaiBatchItem, i: number): ExpandedRun {
  const batchBlock = item.baseBlocks.find(b => b.batchMode && b.enabled)
  const variants = batchBlock?.variants?.filter(v => v.enabled && v.text.trim()) || []
  if (!batchBlock || variants.length === 0) {
    return { positive: buildBasePrompt(item.baseBlocks), variantLabel: null }
  }
  const v = variants[i % variants.length]
  return {
    positive: buildBasePromptWithOverride(item.baseBlocks, batchBlock.id, v.text),
    variantLabel: v.label,
  }
}

// 任务是否处于批量模式（有 enabled 的 batchMode 区块且至少一个 enabled 变体）
export function isItemInBatchMode(item: NaiBatchItem): boolean {
  const b = item.baseBlocks.find(b => b.batchMode && b.enabled)
  if (!b || !b.variants) return false
  return b.variants.some(v => v.enabled && v.text.trim())
}

// 当前 active 任务在 cap 下的变体分配（用于 UI 显示，如 "v1:2, v2:2, v3:1"）
export function batchVariantDistribution(item: NaiBatchItem, target: number): { label: string; count: number }[] {
  const b = item.baseBlocks.find(b => b.batchMode && b.enabled)
  if (!b || !b.variants) return []
  const enabled = b.variants.filter(v => v.enabled && v.text.trim())
  if (enabled.length === 0 || target <= 0) return []
  const base = Math.floor(target / enabled.length)
  const extra = target % enabled.length
  return enabled.map((v, i) => ({ label: v.label, count: i < extra ? base + 1 : base }))
}

// 把角色数组转成 submit_nai.py JSON stdin 的 characters 字段
export function buildCharactersPayload(chars: NaiCharacterPrompt[]) {
  return chars
    .filter(c => c.enabled && c.text.trim())
    .map(c => ({
      text: c.text,
      x: c.position?.x ?? 0.5,
      y: c.position?.y ?? 0.5,
      negative: (c.negative_text || '').trim(),
    }))
}

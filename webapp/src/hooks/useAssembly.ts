import { useState, useCallback, useRef, useEffect } from 'react'
import { BLOCK_ORDER } from '../types'
import type { Cart } from '../types'

// === 类型 ===

export interface AssemblyBlock {
  text: string
  isPrivate: boolean
}

export interface AssemblyState {
  blocks: Record<string, AssemblyBlock>
}

interface FileMeta {
  updatedAt: string
  updatedBy: 'browser' | 'cc'
}

interface AssemblyFile {
  blocks: Record<string, string>
  _meta: FileMeta
}

// === 常量 ===

const STORAGE_KEY = 'owner-assembly'
const POLL_INTERVAL = 3000
const DEBOUNCE_MS = 500

// sub_style 默认隐私，其他默认公开
const DEFAULT_PRIVATE_BLOCKS = new Set<string>(['sub_style'])

function createDefaultState(): AssemblyState {
  const blocks: Record<string, AssemblyBlock> = {}
  for (const b of BLOCK_ORDER) {
    blocks[b] = { text: '', isPrivate: DEFAULT_PRIVATE_BLOCKS.has(b) }
  }
  return { blocks }
}

function loadFromStorage(): AssemblyState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AssemblyState
      // 补充缺失的block（升级兼容）
      const state = createDefaultState()
      for (const b of BLOCK_ORDER) {
        if (parsed.blocks[b]) {
          state.blocks[b] = parsed.blocks[b]
        }
      }
      return state
    }
  } catch { /* ignore */ }
  return createDefaultState()
}

function saveToStorage(state: AssemblyState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

// === Hook ===

export function useAssembly() {
  const [state, setState] = useState<AssemblyState>(loadFromStorage)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'cc-edited'>('idle')
  const [pollingActive, setPollingActive] = useState(false)
  const lastKnownMeta = useRef<string>('')  // 上次已知的 updatedAt
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 持久化到localStorage
  const persist = useCallback((newState: AssemblyState) => {
    saveToStorage(newState)
  }, [])

  // 更新block文本
  const updateBlock = useCallback((block: string, text: string) => {
    setState(prev => {
      const next = {
        ...prev,
        blocks: { ...prev.blocks, [block]: { ...prev.blocks[block], text } }
      }
      persist(next)
      return next
    })
  }, [persist])

  // 切换隐私
  const togglePrivacy = useCallback((block: string) => {
    setState(prev => {
      const cur = prev.blocks[block]
      if (!cur) return prev
      const next = {
        ...prev,
        blocks: { ...prev.blocks, [block]: { ...cur, isPrivate: !cur.isPrivate } }
      }
      persist(next)
      return next
    })
  }, [persist])

  // 从Cart导入
  const importFromCart = useCallback((cart: Cart) => {
    setState(prev => {
      const next = { ...prev, blocks: { ...prev.blocks } }
      for (const block of BLOCK_ORDER) {
        const items = cart.blocks[block as string]
        if (!items || items.length === 0) continue
        const text = items
          .map(item => item.tag.replace(/,\s*$/, '').trim())
          .filter(Boolean)
          .join(', ')
        if (text) {
          next.blocks[block] = { ...next.blocks[block], text }
        }
      }
      persist(next)
      return next
    })
  }, [persist])

  // 清空全部
  const clearAll = useCallback(() => {
    const fresh = createDefaultState()
    setState(fresh)
    persist(fresh)
  }, [persist])

  // 写公开block + 隐私block到文件（方案C: 隐私block也写文件供submit脚本读取）
  const syncToFile = useCallback(async () => {
    setSyncStatus('syncing')
    try {
      const publicBlocks: Record<string, string> = {}
      const privateBlocks: Record<string, string> = {}
      const currentState = state  // capture
      for (const b of BLOCK_ORDER) {
        const block = currentState.blocks[b]
        if (!block || !block.text.trim()) continue
        if (block.isPrivate) {
          privateBlocks[b] = block.text
        } else {
          publicBlocks[b] = block.text
        }
      }
      const payload: AssemblyFile = {
        blocks: publicBlocks,
        _meta: {
          updatedAt: new Date().toISOString(),
          updatedBy: 'browser',
        }
      }
      // 同步公开block
      await fetch('/api/assembly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      // 同步隐私block到文件（方案C: 供submit脚本读取）
      await fetch('/api/assembly/private', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(privateBlocks),
      })
      lastKnownMeta.current = payload._meta.updatedAt
      setSyncStatus('idle')
    } catch (err) {
      console.error('Assembly sync to file failed:', err)
      setSyncStatus('idle')
    }
  }, [state])

  // 从文件读取公开block（检测CC编辑）
  const syncFromFile = useCallback(async () => {
    try {
      const res = await fetch('/api/assembly')
      if (!res.ok) return
      const data: AssemblyFile = await res.json()
      if (!data._meta) return

      // 检测是否有CC编辑
      if (data._meta.updatedBy === 'cc' && data._meta.updatedAt !== lastKnownMeta.current) {
        // CC编辑了文件，更新公开block
        setState(prev => {
          const next = { ...prev, blocks: { ...prev.blocks } }
          for (const [block, text] of Object.entries(data.blocks)) {
            if (next.blocks[block] && !next.blocks[block].isPrivate) {
              next.blocks[block] = { ...next.blocks[block], text }
            }
          }
          persist(next)
          return next
        })
        lastKnownMeta.current = data._meta.updatedAt
        setSyncStatus('idle')
      } else if (data._meta.updatedAt !== lastKnownMeta.current) {
        // 时间戳变了但不是CC编辑（可能是之前的browser写入），同步时间戳
        lastKnownMeta.current = data._meta.updatedAt
      }
    } catch {
      // 文件不存在或网络错误，静默忽略
    }
  }, [persist])

  // debounce写文件
  useEffect(() => {
    if (!pollingActive) return
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      syncToFile()
    }, DEBOUNCE_MS)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [state, pollingActive, syncToFile])

  // 轮询检测CC编辑
  useEffect(() => {
    if (!pollingActive) return
    const timer = setInterval(syncFromFile, POLL_INTERVAL)
    // 首次立即同步
    syncFromFile()
    return () => clearInterval(timer)
  }, [pollingActive, syncFromFile])

  // 生成合并后的prompt文本（含隐私block，用于预览和复制）
  const exportFullText = useCallback((): string => {
    const lines: string[] = []
    for (const block of BLOCK_ORDER) {
      const b = state.blocks[block]
      if (!b || !b.text.trim()) continue
      const text = b.text.replace(/,\s*$/, '').trim()
      lines.push(text + ',')
    }
    return lines.join('\n\nBREAK\n\n')
  }, [state])

  // 启动/停止轮询
  const startPolling = useCallback(() => setPollingActive(true), [])
  const stopPolling = useCallback(() => setPollingActive(false), [])

  return {
    blocks: state.blocks,
    updateBlock,
    togglePrivacy,
    importFromCart,
    clearAll,
    syncToFile,
    syncFromFile,
    exportFullText,
    syncStatus,
    startPolling,
    stopPolling,
  }
}

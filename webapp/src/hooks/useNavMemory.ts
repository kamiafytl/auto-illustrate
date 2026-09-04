import { useState, useCallback } from 'react'

const STORAGE_PREFIX = 'owner-nav:'

interface NavState {
  block: string
  category: string
  group?: string
}

/** 导航位置记忆hook — localStorage持久化 */
export function useNavMemory(tabId: string, defaults: NavState) {
  const key = STORAGE_PREFIX + tabId

  const [state, setState] = useState<NavState>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored) return JSON.parse(stored)
    } catch { /* ignore */ }
    return defaults
  })

  const update = useCallback((patch: Partial<NavState>) => {
    setState(prev => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [key])

  return [state, update] as const
}

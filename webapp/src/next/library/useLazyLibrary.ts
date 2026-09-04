// 懒狗库数据（E2 只读浏览用）：端点与 LazyBrowser 同源（/api/rating/*，服务端零改动）。
// 管理手势（拖拽/分类/垃圾桶）留在旧「散图库」tab 到 E5，本 hook 只取展示数据。
import { useEffect, useRef, useState } from 'react'
import type { LazyShot, ResolvedComp } from '../../types/lazydog'

export interface LazySet {
  id: string
  title: string
  work: string
  cover: string
  coverId: string
  count: number
  frames: LazyShot[]
  tags: string[]
  order?: number
  trashed: boolean
  trashedAt?: string
}

export type LazyLibraryState = {
  loading: boolean
  error: string | null
  shots: LazyShot[]
  sets: LazySet[]
  comps: ResolvedComp[]
}

export function useLazyLibrary(enabled: boolean): LazyLibraryState {
  const [state, setState] = useState<LazyLibraryState>({ loading: true, error: null, shots: [], sets: [], comps: [] })
  // 用 ref 防重复拉取；cleanup 里必须连 cancelled 一起重置——StrictMode 开发态 effect 双跑，
  // 否则首跑被 cleanup 取消、二跑被 startedRef 挡住 → loading 永挂（自审实测踩过）
  const startedRef = useRef(false)

  useEffect(() => {
    if (!enabled || startedRef.current) return
    startedRef.current = true
    let cancelled = false
    ;(async () => {
      try {
        const [shotsRes, setsRes, compsRes] = await Promise.all([
          fetch('/api/rating/shots-all').then((response) => response.json()),
          fetch('/api/rating/sets').then((response) => response.json()),
          fetch('/api/rating/compositions').then((response) => response.json()),
        ])
        if (cancelled) return
        setState({
          loading: false,
          error: null,
          shots: (shotsRes.shots ?? []) as LazyShot[],
          sets: (setsRes.sets ?? []) as LazySet[],
          comps: (compsRes.compositions ?? []) as ResolvedComp[],
        })
      } catch (error) {
        if (!cancelled) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }))
      }
    })()
    return () => {
      cancelled = true
      startedRef.current = false
    }
  }, [enabled])

  return state
}

import { useState, useCallback, useEffect } from 'react'
import { migrateViewTexts, type Character, type Outfit, type ViewVariantTexts } from '../types'

function genId(prefix: string): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function emptyVariants(): ViewVariantTexts {
  return { front_full: '' }
}

// 自动迁移：把可能存在的旧结构 traits/tags 升级为新 8 字段
function migrateCharacter(c: Character): Character {
  return {
    ...c,
    traits: migrateViewTexts(c.traits as unknown as Parameters<typeof migrateViewTexts>[0]),
    outfits: (c.outfits || []).map(o => ({
      ...o,
      tags: migrateViewTexts(o.tags as unknown as Parameters<typeof migrateViewTexts>[0]),
    })),
  }
}

export function emptyCharacter(): Character {
  return {
    id: genId('char-'),
    name: '新角色',
    preview_image: null,
    traits: emptyVariants(),
    outfits: [],
    note: '',
  }
}

export function emptyOutfit(): Outfit {
  return {
    id: genId('outfit-'),
    name: '新衣服',
    preview_image: null,
    tags: emptyVariants(),
  }
}

// ── 模块级共享 store ──
// 让多个 useCharacters() 实例（App.tsx / CharacterManager / NaiBatchPanel 等）
// 共享同一份数据，编辑一处所有地方自动同步。
let sharedCharacters: Character[] = []
let sharedLoaded = false
const listeners = new Set<(c: Character[]) => void>()

function setShared(c: Character[]) {
  sharedCharacters = c
  listeners.forEach(l => l(c))
}

async function loadFromServer(): Promise<void> {
  try {
    const resp = await fetch('/api/characters')
    const data = await resp.json()
    if (Array.isArray(data)) {
      setShared(data.map(migrateCharacter))
      sharedLoaded = true
    }
  } catch { /* ignore */ }
}

/**
 * 角色管理 hook：加载、新增、更新、删除。
 * 数据存 data/characters.json，通过 /api/characters CRUD。
 * 多实例共享同一份 state。
 */
export function useCharacters() {
  const [characters, setCharacters] = useState<Character[]>(sharedCharacters)
  const [loading, setLoading] = useState(!sharedLoaded)

  useEffect(() => {
    listeners.add(setCharacters)
    return () => { listeners.delete(setCharacters) }
  }, [])

  useEffect(() => {
    if (!sharedLoaded) {
      setLoading(true)
      loadFromServer().finally(() => setLoading(false))
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    await loadFromServer()
    setLoading(false)
  }, [])

  const saveCharacter = useCallback(async (c: Character) => {
    const body = { ...c, updatedAt: new Date().toISOString() }
    try {
      const resp = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) return false
      const idx = sharedCharacters.findIndex(x => x.id === c.id)
      let next: Character[]
      if (idx >= 0) {
        next = [...sharedCharacters]
        next[idx] = body
      } else {
        next = [...sharedCharacters, body]
      }
      setShared(next)
      return true
    } catch { return false }
  }, [])

  const deleteCharacter = useCallback(async (id: string) => {
    try {
      await fetch(`/api/characters/${id}`, { method: 'DELETE' })
      setShared(sharedCharacters.filter(c => c.id !== id))
      return true
    } catch { return false }
  }, [])

  // 工具：在 character 内部增/改/删 outfit（返回新 character，不直接持久化）
  const addOutfit = useCallback((c: Character, outfit?: Partial<Outfit>): Character => {
    return { ...c, outfits: [...c.outfits, { ...emptyOutfit(), ...outfit }] }
  }, [])

  const updateOutfit = useCallback((c: Character, outfitId: string, patch: Partial<Outfit>): Character => {
    return { ...c, outfits: c.outfits.map(o => o.id === outfitId ? { ...o, ...patch } : o) }
  }, [])

  const removeOutfit = useCallback((c: Character, outfitId: string): Character => {
    return {
      ...c,
      outfits: c.outfits.filter(o => o.id !== outfitId),
      default_outfit: c.default_outfit === outfitId ? undefined : c.default_outfit,
    }
  }, [])

  return {
    characters,
    loading,
    reload,
    saveCharacter,
    deleteCharacter,
    addOutfit,
    updateOutfit,
    removeOutfit,
  }
}

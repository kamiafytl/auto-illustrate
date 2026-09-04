import type { Recipe, TagEntry, Inspiration } from '../types'
import type { LoraEntry, WorkflowTemplate } from '../types/production'
import { BLOCK_ORDER } from '../types'

const DATA_BASE = import.meta.env.BASE_URL + 'data'

async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`)
  return res.json()
}

/** 加载所有配方（合并所有区块文件，缺失的block文件自动跳过） */
export async function loadAllRecipes(): Promise<Recipe[]> {
  const results = await Promise.allSettled(
    BLOCK_ORDER.map(b => loadJson<Recipe[]>(`${DATA_BASE}/recipes/${b}.json`))
  )
  return results
    .filter((r): r is PromiseFulfilledResult<Recipe[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
}

/** 加载所有Tag词典（合并所有区块文件） */
export async function loadAllTags(): Promise<TagEntry[]> {
  const results = await Promise.allSettled(
    BLOCK_ORDER.map(b => loadJson<TagEntry[]>(`${DATA_BASE}/tags/${b}.json`))
  )
  return results
    .filter((r): r is PromiseFulfilledResult<TagEntry[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)
}

/** 加载灵感库 */
export async function loadInspirations(): Promise<Inspiration[]> {
  return loadJson<Inspiration[]>(`${DATA_BASE}/inspirations.json`)
}

/** 加载LoRA注册表 */
export async function loadLoras(): Promise<LoraEntry[]> {
  try {
    return await loadJson<LoraEntry[]>(`${DATA_BASE}/loras.json`)
  } catch {
    return []
  }
}

/** 加载工作流模板（每模板独立文件，通过_index.json索引） */
export async function loadWorkflows(): Promise<WorkflowTemplate[]> {
  try {
    const index = await loadJson<string[]>(`${DATA_BASE}/workflows/_index.json`)
    const results = await Promise.allSettled(
      index.map(id => loadJson<WorkflowTemplate>(`${DATA_BASE}/workflows/${id}.json`))
    )
    return results
      .filter((r): r is PromiseFulfilledResult<WorkflowTemplate> => r.status === 'fulfilled')
      .map(r => r.value)
  } catch {
    return []
  }
}

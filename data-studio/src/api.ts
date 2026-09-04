import type { ApiError, DataRecord, ManifestItem, TableKey } from './types'

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Partial<ApiError>
  if (!response.ok) {
    throw new Error(body.error || `请求失败：${response.status}`)
  }
  return body as T
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readJson<T>(response)
}

export async function fetchManifest(): Promise<ManifestItem[]> {
  const response = await fetch('/api/db/manifest')
  return readJson<ManifestItem[]>(response)
}

export async function fetchTable(tableKey: TableKey): Promise<DataRecord[]> {
  const response = await fetch(`/api/db/table?key=${encodeURIComponent(tableKey)}`)
  const data = await readJson<{ key: TableKey; records: DataRecord[] }>(response)
  return data.records
}

export async function createRecord(tableKey: TableKey, record: DataRecord): Promise<DataRecord> {
  const data = await postJson<{ ok: boolean; record: DataRecord }>('/api/db/create', { tableKey, record })
  return data.record
}

export async function updateRecord(
  tableKey: TableKey,
  file: string,
  id: string,
  patch: DataRecord,
): Promise<{ record: DataRecord; moved?: boolean }> {
  const data = await postJson<{ ok: boolean; record: DataRecord; moved?: boolean }>('/api/db/update', {
    tableKey,
    file,
    id,
    patch,
  })
  return { record: data.record, moved: data.moved }
}

export async function deleteRecord(tableKey: TableKey, file: string, id: string): Promise<void> {
  await postJson<{ ok: boolean }>('/api/db/delete', { tableKey, file, id })
}

export function imageUrl(path: unknown): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null
  return `/api/db/image?path=${encodeURIComponent(path)}`
}

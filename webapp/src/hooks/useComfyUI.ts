import { useState, useCallback } from 'react'
import type { ComfyUIConnectionState, JobResult } from '../types/production'

export function useComfyUI() {
  const [conn, setConn] = useState<ComfyUIConnectionState>({
    connected: false,
    testing: false,
    env: 'local',
    url: '',
  })

  const testConnection = useCallback(async () => {
    setConn(prev => ({ ...prev, testing: true, error: undefined }))
    try {
      const res = await fetch('/api/comfyui/test', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        const sys = data.system?.system || {}
        const gpu = data.system?.devices?.[0] || {}
        setConn({
          connected: true,
          testing: false,
          env: data.env || 'local',
          url: data.url || '',
          systemInfo: {
            comfyuiVersion: sys.comfyui_version || 'unknown',
            gpuName: gpu.name || 'unknown',
            vramTotal: gpu.vram_total || 0,
            vramFree: gpu.vram_free || 0,
          },
        })
      } else {
        setConn(prev => ({
          ...prev,
          connected: false,
          testing: false,
          error: data.error || '连接失败',
        }))
      }
    } catch (err) {
      setConn(prev => ({
        ...prev,
        connected: false,
        testing: false,
        error: err instanceof Error ? err.message : '网络错误',
      }))
    }
  }, [])

  const submitPrompt = useCallback(async (workflow: Record<string, unknown>): Promise<string> => {
    const res = await fetch('/api/comfyui/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
    })
    const data = await res.json()
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
    return data.prompt_id
  }, [])

  const pollHistory = useCallback(async (promptId: string): Promise<JobResult> => {
    const res = await fetch('/api/comfyui/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptId }),
    })
    const data = await res.json()

    const entry = data[promptId]
    if (!entry) return { promptId, status: 'running' }

    if (entry.status?.completed) {
      const images: string[] = []
      for (const nodeOutput of Object.values(entry.outputs || {})) {
        for (const img of (nodeOutput as { images?: { filename: string; subfolder?: string; type?: string }[] }).images || []) {
          images.push(img.filename)
        }
      }
      return { promptId, status: 'success', images }
    }

    if (entry.status?.status_str === 'error') {
      return { promptId, status: 'error', error: entry.status.messages?.join('; ') || '执行出错' }
    }

    return { promptId, status: 'running' }
  }, [])

  const fetchModels = useCallback(async (type: string): Promise<string[]> => {
    try {
      const res = await fetch('/api/comfyui/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      })
      const data = await res.json()
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }, [])

  return { conn, testConnection, submitPrompt, pollHistory, fetchModels }
}

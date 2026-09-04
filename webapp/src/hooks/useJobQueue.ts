import { useState, useCallback, useRef, useEffect } from 'react'
import type { JobResult } from '../types/production'

const POLL_INTERVAL = 2000
const POLL_TIMEOUT = 5 * 60 * 1000

export function useJobQueue(
  submitPrompt: (workflow: Record<string, unknown>) => Promise<string>,
  pollHistory: (promptId: string) => Promise<JobResult>
) {
  const [currentJob, setCurrentJob] = useState<JobResult | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number>(0)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  // cleanup on unmount
  useEffect(() => stopPolling, [stopPolling])

  const submit = useCallback(async (workflow: Record<string, unknown>) => {
    stopPolling()
    setCurrentJob({ promptId: '', status: 'pending' })

    try {
      const promptId = await submitPrompt(workflow)
      const now = new Date().toISOString()
      setCurrentJob({ promptId, status: 'running', startedAt: now })
      startTimeRef.current = Date.now()

      pollingRef.current = setInterval(async () => {
        // 超时保护
        if (Date.now() - startTimeRef.current > POLL_TIMEOUT) {
          stopPolling()
          setCurrentJob(prev => prev ? {
            ...prev,
            status: 'error',
            error: '等待超时（5分钟），请检查ComfyUI状态',
          } : null)
          return
        }

        try {
          const result = await pollHistory(promptId)
          if (result.status === 'success' || result.status === 'error') {
            stopPolling()
            setCurrentJob({ ...result, completedAt: new Date().toISOString() })
          }
        } catch {
          // 轮询失败静默忽略，继续等
        }
      }, POLL_INTERVAL)
    } catch (err) {
      setCurrentJob({
        promptId: '',
        status: 'error',
        error: err instanceof Error ? err.message : '提交失败',
      })
    }
  }, [submitPrompt, pollHistory, stopPolling])

  const clear = useCallback(() => {
    stopPolling()
    setCurrentJob(null)
  }, [stopPolling])

  return { currentJob, submit, clear }
}

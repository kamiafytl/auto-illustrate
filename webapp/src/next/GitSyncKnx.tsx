import { useState, useEffect, useCallback } from 'react'

type SyncState = 'idle' | 'syncing' | 'success' | 'error'

/** 旧 GitSyncButton 的 knx 版（照抄逻辑与视觉，类名换 knx- 前缀；E5 拆旧后成为唯一 Sync）。 */
export default function GitSyncKnx() {
  const [needsSync, setNeedsSync] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const checkGitStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/git-status')
      const data = await resp.json()
      if (data.ok) {
        setNeedsSync(data.hasChanges)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    checkGitStatus()
    const timer = setInterval(checkGitStatus, 60000)
    return () => clearInterval(timer)
  }, [checkGitStatus])

  const handleSync = async () => {
    setSyncState('syncing')
    setErrorMsg('')
    try {
      const resp = await fetch('/api/git-sync', { method: 'POST' })
      const data = await resp.json()
      if (data.ok) {
        setSyncState('success')
        setNeedsSync(false)
        const now = new Date()
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        localStorage.setItem('owner-git-lastSync', todayStr)
        setTimeout(() => setSyncState('idle'), 3000)
      } else {
        setSyncState('error')
        setErrorMsg(data.error || '同步失败')
        setTimeout(() => setSyncState('idle'), 5000)
      }
    } catch (err) {
      setSyncState('error')
      setErrorMsg(err instanceof Error ? err.message : '网络错误')
      setTimeout(() => setSyncState('idle'), 5000)
    }
  }

  const label = syncState === 'syncing' ? '同步中...'
    : syncState === 'success' ? 'Synced'
    : syncState === 'error' ? '失败'
    : 'Sync'

  return (
    <div className="knx-sync-wrapper">
      <button
        className={`knx-sync-btn knx-sync-${syncState}${needsSync ? ' has-changes' : ''}`}
        onClick={handleSync}
        disabled={syncState === 'syncing'}
        title={errorMsg || (needsSync ? '有未提交的变更' : '代码已同步')}
      >
        {label}
      </button>
    </div>
  )
}

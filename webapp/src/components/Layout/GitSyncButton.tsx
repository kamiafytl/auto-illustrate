import { useState, useEffect, useCallback } from 'react'

type SyncState = 'idle' | 'syncing' | 'success' | 'error'

export default function GitSyncButton() {
  const [needsSync, setNeedsSync] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [showReminder, setShowReminder] = useState(false)

  // 检查是否该显示同步提醒（23点后 + 今天还没同步）
  const checkReminder = useCallback(() => {
    const now = new Date()
    const hour = now.getHours()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    const lastSync = localStorage.getItem('owner-git-lastSync') || ''
    setShowReminder(hour >= 23 && lastSync !== todayStr)
  }, [])

  // 查询git状态
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
    checkReminder()
    checkGitStatus()
    // 每分钟检查一次时间（跨过23点时自动显示提醒）
    const timer = setInterval(() => {
      checkReminder()
      checkGitStatus()
    }, 60000)
    return () => clearInterval(timer)
  }, [checkReminder, checkGitStatus])

  const handleSync = async () => {
    setSyncState('syncing')
    setErrorMsg('')
    try {
      const resp = await fetch('/api/git-sync', { method: 'POST' })
      const data = await resp.json()
      if (data.ok) {
        setSyncState('success')
        setNeedsSync(false)
        // 记录今天已同步
        const now = new Date()
        const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
        localStorage.setItem('owner-git-lastSync', todayStr)
        setShowReminder(false)
        // 3秒后恢复idle
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
    <div className="git-sync-wrapper">
      {showReminder && syncState === 'idle' && (
        <span className="git-sync-reminder">今日未备份</span>
      )}
      <button
        className={`git-sync-btn git-sync-${syncState}${needsSync ? ' has-changes' : ''}`}
        onClick={handleSync}
        disabled={syncState === 'syncing'}
        title={errorMsg || (needsSync ? '有未提交的变更' : '代码已同步')}
      >
        {label}
      </button>
    </div>
  )
}

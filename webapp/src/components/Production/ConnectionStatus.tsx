import { useEffect } from 'react'
import type { ComfyUIConnectionState } from '../../types/production'

interface ConnectionStatusProps {
  conn: ComfyUIConnectionState
  onTest: () => void
}

function formatVram(bytes: number): string {
  if (!bytes) return '?'
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}

export default function ConnectionStatus({ conn, onTest }: ConnectionStatusProps) {
  // 首次渲染时自动测试连接
  useEffect(() => {
    if (!conn.connected && !conn.testing && !conn.error) {
      onTest()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const dotClass = conn.testing ? 'dot-yellow' : conn.connected ? 'dot-green' : 'dot-red'

  return (
    <div className="connection-status">
      <span className={`connection-dot ${dotClass}`} />
      {conn.testing && <span className="connection-text">测试连接中...</span>}
      {!conn.testing && conn.connected && (
        <span className="connection-text">
          已连接 ({conn.env})
          {conn.systemInfo && (
            <span className="connection-info">
              {' '}| {conn.systemInfo.gpuName} | VRAM {formatVram(conn.systemInfo.vramFree)}/{formatVram(conn.systemInfo.vramTotal)}
            </span>
          )}
        </span>
      )}
      {!conn.testing && !conn.connected && (
        <>
          <span className="connection-text connection-error">
            {conn.error || '未连接'}
          </span>
          <button className="connection-retry" onClick={onTest}>重试</button>
        </>
      )}
      {!conn.testing && conn.connected && (
        <button className="connection-retry" onClick={onTest}>刷新</button>
      )}
    </div>
  )
}

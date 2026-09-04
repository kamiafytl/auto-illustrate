import { useState, useEffect } from 'react'
import type { JobResult } from '../../types/production'

interface JobStatusProps {
  job: JobResult | null
  onClear: () => void
}

export default function JobStatus({ job, onClear }: JobStatusProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!job || job.status !== 'running') {
      setElapsed(0)
      return
    }
    const start = job.startedAt ? new Date(job.startedAt).getTime() : Date.now()
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [job?.status, job?.startedAt])

  if (!job) return null

  return (
    <div className="job-status">
      {job.status === 'pending' && (
        <div className="job-pending">
          <span className="job-spinner" /> 准备提交...
        </div>
      )}

      {job.status === 'running' && (
        <div className="job-running">
          <span className="job-spinner" /> 生成中... ({elapsed}秒)
        </div>
      )}

      {job.status === 'success' && (
        <div className="job-success">
          <div className="job-header-row">
            <span>生成完成!</span>
            <button className="btn-small btn-secondary" onClick={onClear}>清除</button>
          </div>
          {job.images && job.images.length > 0 && (
            <div className="job-images">
              {job.images.map((filename, i) => (
                <ImagePreview key={i} filename={filename} />
              ))}
            </div>
          )}
        </div>
      )}

      {job.status === 'error' && (
        <div className="job-error">
          <div className="job-header-row">
            <span>生成失败: {job.error}</span>
            <button className="btn-small btn-secondary" onClick={onClear}>清除</button>
          </div>
        </div>
      )}

      <p className="job-hint">
        提示: 生成期间请保持此页面打开。关闭页面会中断进度轮询（不影响ComfyUI已提交的任务）。
      </p>
    </div>
  )
}

function ImagePreview({ filename }: { filename: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/comfyui/view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename }),
        })
        if (!res.ok) throw new Error('load failed')
        const blob = await res.blob()
        if (!cancelled) setSrc(URL.createObjectURL(blob))
      } catch {
        if (!cancelled) setError(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [filename])

  if (error) return <div className="job-image-error">图片加载失败</div>
  if (!src) return <div className="job-image-loading">加载中...</div>
  return <img className="job-image" src={src} alt={filename} />
}

import { useState, useEffect, useCallback } from 'react'

const MAX_SIZE = 1200

function sanitizeKey(key: string): string {
  return key.replace(/:/g, '--')
}

function resizeImage(blob: Blob, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/webp', 0.8))
    }
    img.onerror = reject
    img.src = url
  })
}

/** 服务端文件存储hook — 粘贴图片保存到服务器，重启浏览器不丢失 */
export function useImageStore() {
  const [images, setImages] = useState<Record<string, string>>({})

  // 启动时从服务器加载已有图片列表
  useEffect(() => {
    fetch('/api/list-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
      .then(r => r.json())
      .then((data: { keys: string[] }) => {
        const m: Record<string, string> = {}
        for (const key of data.keys) {
          m[key] = `/data/images/${sanitizeKey(key)}_full.webp`
        }
        setImages(m)
      })
      .catch(console.error)
  }, [])

  const saveImage = useCallback(async (key: string, blob: Blob) => {
    const image = await resizeImage(blob, MAX_SIZE)
    await fetch('/api/save-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, image })
    })
    const s = sanitizeKey(key)
    const ts = Date.now()
    setImages(prev => ({ ...prev, [key]: `/data/images/${s}_full.webp?t=${ts}` }))
  }, [])

  const deleteImage = useCallback(async (key: string) => {
    await fetch('/api/delete-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    })
    setImages(prev => { const n = { ...prev }; delete n[key]; return n })
  }, [])

  const handlePaste = useCallback(async (key: string, e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return false
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (blob) await saveImage(key, blob)
        return true
      }
    }
    return false
  }, [saveImage])

  return { images, saveImage, deleteImage, handlePaste }
}

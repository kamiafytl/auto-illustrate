// Precise Reference（角色参考）图片预处理：在浏览器端把任意尺寸参考图 letterbox 到
// NAI 允许的画布尺寸之一，输出 PNG base64。后端只负责把它塞进 director_reference_images。
//
// 联动（internal-docs）：ACCEPTED_CR_SIZES 与 tools/submit_nai.py 的同名常量保持一致。

export const ACCEPTED_CR_SIZES: Array<[number, number]> = [
  [1024, 1536], // 竖
  [1536, 1024], // 横
  [1472, 1472], // 方
]

/** 按长宽比就近选画布 */
export function selectCanvas(w: number, h: number): [number, number] {
  const ar = w / h
  return ACCEPTED_CR_SIZES.reduce((best, s) =>
    Math.abs(s[0] / s[1] - ar) < Math.abs(best[0] / best[1] - ar) ? s : best
  )
}

/**
 * 读取 File → letterbox（保持长宽比 + 黑边）到就近画布 → 返回 PNG base64（不含 data: 前缀）。
 */
export function encodeCharReferenceImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      try {
        const [cw, ch] = selectCanvas(img.naturalWidth, img.naturalHeight)
        const canvas = document.createElement('canvas')
        canvas.width = cw
        canvas.height = ch
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('无法创建 canvas 上下文'))
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, cw, ch)
        const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight)
        const nw = Math.round(img.naturalWidth * scale)
        const nh = Math.round(img.naturalHeight * scale)
        ctx.drawImage(img, Math.round((cw - nw) / 2), Math.round((ch - nh) / 2), nw, nh)
        const dataUrl = canvas.toDataURL('image/png')
        resolve(dataUrl.split(',')[1] || '')
      } catch (e) {
        reject(e)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片加载失败'))
    }
    img.src = url
  })
}

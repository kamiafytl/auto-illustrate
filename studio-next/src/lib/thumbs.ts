import type { TagThumbIndex } from './dataClient'

export type ThumbSourceKind = 'tag' | 'recipe' | 'character' | 'outfit'

export type ThumbSource = {
  id: string
  kind: ThumbSourceKind
  title: string
  text: string
  image?: string | null
}

export function normalizedImagePath(path: string | null | undefined): string | null {
  if (!path) return null
  const cleaned = path.replace(/^\/+/, '').replace(/^data\/+/, '')
  return cleaned.startsWith('images/') ? cleaned : null
}

export function dataImageUrl(path: string): string {
  return `/api/data/image?path=${encodeURIComponent(path)}`
}

export function tagThumbUrl(fileName: string): string {
  return `/api/data/tag-thumb?file=${encodeURIComponent(fileName)}`
}

export function cleanTagThumbKey(text: string): string | null {
  const firstSegment = text.split(',')[0] ?? ''
  const cleaned = firstSegment
    .trim()
    .replace(/^\d+(?:\.\d+)?::/, '')
    .replaceAll('::', '')
    .replace(/^[()[\]{}\s]+|[()[\]{}\s]+$/g, '')

  if (!cleaned || /[\u3400-\u9fff]/.test(cleaned)) return null
  return cleaned.replace(/\s+/g, '_').toLocaleLowerCase()
}

export function thumbnailFor(item: ThumbSource, imagePaths: string[], tagThumbs: TagThumbIndex): string | null {
  if (item.kind === 'tag') {
    const key = cleanTagThumbKey(item.text)
    const fileName = key ? tagThumbs[key] : null
    if (fileName) return tagThumbUrl(fileName)
  }

  // 只用"正确关联图"（recipe/角色/衣服自己存的图）；不再用哈希随机分配本地图胡乱填充(2.5)
  const normalized = normalizedImagePath(item.image)
  if (normalized && imagePaths.includes(normalized)) return dataImageUrl(normalized)
  return null
}

// 角色/衣服缩略图：preview_image 多为空 → 沿用旧 webapp 的命名约定 images/char--<id>_full.webp、
// images/outfit--<id>_full.webp（存在才返回，避免破图）。这就是“把旧的引用直接拿过来”。
export function entityThumbUrl(
  kind: 'char' | 'outfit',
  id: string | null | undefined,
  preview: string | null | undefined,
  imagePaths: string[],
): string | null {
  const direct = normalizedImagePath(preview)
  if (direct && imagePaths.includes(direct)) return dataImageUrl(direct)
  if (id) {
    const conv = `images/${kind}--${id}_full.webp`
    if (imagePaths.includes(conv)) return dataImageUrl(conv)
  }
  return null
}

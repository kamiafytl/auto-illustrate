import fs from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// danbooru 接网查询（E2 配方库 tag 词典 · 差异点6）：
// GET /api/danbooru/tag-info?tag=xxx → { tag, postCount, preview }（preview=本站代理 URL 或 null）
// GET /api/danbooru/preview?tag=xxx  → 缓存的预览图二进制
// 缓存落 data/cache/danbooru/（meta json + 图片，gitignore）；失败一律静默降级（200 + null 字段），
// 前端纯本地照常可用。⚠ 新增 /api/danbooru 前缀已在 dataApi.ts early-next 登记（webapp 路由铁律）。

type TagMeta = {
  fetchedAt: number
  postCount: number | null
  previewSrcUrl: string | null
  previewFile: string | null // 缓存图片文件名（相对 cacheDir），null=无/未取
}

const META_TTL_MS = 30 * 24 * 3600 * 1000 // 30 天后重新联网刷新 post 数
const FETCH_TIMEOUT_MS = 8000
const UA = 'owner-auto-illustrate/1.0'

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function safeName(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9._()-]/g, '_').slice(0, 120)
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchTagMeta(tag: string): Promise<{ postCount: number | null; previewSrcUrl: string | null }> {
  const enc = encodeURIComponent(tag)
  let postCount: number | null = null
  let previewSrcUrl: string | null = null
  try {
    const r = await fetchWithTimeout(`https://danbooru.donmai.us/tags.json?search[name_matches]=${enc}&limit=1`)
    if (r.ok) {
      const arr = (await r.json()) as Array<{ name?: string; post_count?: number }>
      if (Array.isArray(arr) && arr[0] && typeof arr[0].post_count === 'number') postCount = arr[0].post_count
    }
  } catch { /* 静默降级 */ }
  try {
    const r = await fetchWithTimeout(`https://danbooru.donmai.us/posts.json?tags=${enc}+order%3Ascore&limit=1`)
    if (r.ok) {
      const arr = (await r.json()) as Array<{ preview_file_url?: string }>
      if (Array.isArray(arr) && arr[0]?.preview_file_url) previewSrcUrl = arr[0].preview_file_url
    }
  } catch { /* 静默降级 */ }
  return { postCount, previewSrcUrl }
}

export function danbooruPlugin(rootDir: string): Plugin {
  const cacheDir = path.resolve(rootDir, '../data/cache/danbooru')
  const metaPath = (tag: string) => path.join(cacheDir, `${safeName(tag)}.json`)
  // 同 tag 并发请求合流，避免重复打 danbooru
  const inflight = new Map<string, Promise<TagMeta>>()

  function readMeta(tag: string): TagMeta | null {
    try {
      return JSON.parse(fs.readFileSync(metaPath(tag), 'utf-8')) as TagMeta
    } catch {
      return null
    }
  }

  function writeMeta(tag: string, meta: TagMeta): void {
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(metaPath(tag), JSON.stringify(meta), 'utf-8')
    } catch { /* 缓存写失败不阻塞 */ }
  }

  async function ensureMeta(tag: string): Promise<TagMeta> {
    const cached = readMeta(tag)
    if (cached && Date.now() - cached.fetchedAt < META_TTL_MS) return cached
    const running = inflight.get(tag)
    if (running) return running
    const task = (async () => {
      const fetched = await fetchTagMeta(tag)
      if (fetched.postCount === null && fetched.previewSrcUrl === null && cached) return cached // 联网失败留旧缓存
      const meta: TagMeta = {
        fetchedAt: Date.now(),
        postCount: fetched.postCount,
        previewSrcUrl: fetched.previewSrcUrl,
        previewFile: cached?.previewFile ?? null,
      }
      if (fetched.postCount !== null || fetched.previewSrcUrl !== null) writeMeta(tag, meta)
      return meta
    })()
    inflight.set(tag, task)
    try {
      return await task
    } finally {
      inflight.delete(tag)
    }
  }

  async function ensurePreviewFile(tag: string, meta: TagMeta): Promise<string | null> {
    if (meta.previewFile) {
      const p = path.join(cacheDir, meta.previewFile)
      if (fs.existsSync(p)) return p
    }
    if (!meta.previewSrcUrl) return null
    try {
      const r = await fetchWithTimeout(meta.previewSrcUrl)
      if (!r.ok) return null
      const buf = Buffer.from(await r.arrayBuffer())
      const ext = (meta.previewSrcUrl.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i)?.[1] ?? 'jpg').toLowerCase()
      const file = `${safeName(tag)}.${ext}`
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(path.join(cacheDir, file), buf)
      writeMeta(tag, { ...meta, previewFile: file })
      return path.join(cacheDir, file)
    } catch {
      return null
    }
  }

  return {
    name: 'owner-danbooru',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/danbooru/')) return next()
        const u = new URL(url, 'http://localhost')
        const tag = (u.searchParams.get('tag') ?? '').trim()
        if (!tag) return sendJson(res, { error: 'tag required' }, 400)

        if (u.pathname === '/api/danbooru/tag-info') {
          const meta = await ensureMeta(tag)
          const hasPreview = Boolean(meta.previewFile || meta.previewSrcUrl)
          return sendJson(res, {
            tag,
            postCount: meta.postCount,
            preview: hasPreview ? `/api/danbooru/preview?tag=${encodeURIComponent(tag)}` : null,
          })
        }

        if (u.pathname === '/api/danbooru/preview') {
          const meta = await ensureMeta(tag)
          const file = await ensurePreviewFile(tag, meta)
          if (!file) {
            res.statusCode = 404
            return res.end('no preview')
          }
          const ext = path.extname(file).slice(1)
          res.setHeader('Content-Type', ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg')
          res.setHeader('Cache-Control', 'public, max-age=86400')
          return fs.createReadStream(file).pipe(res)
        }

        return next()
      })
    },
  }
}

import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type TagThumbIndex = Record<string, string | null>
interface RawTagEntry {
  tag?: unknown
  name_zh?: unknown
  block?: unknown
  category?: unknown
  note?: unknown
}

async function readJsonFile<T = JsonValue>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content) as T
}

async function readJsonArrayFromDir<T>(dirPath: string): Promise<T[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dirPath, entry.name))
    .sort()

  const chunks = await Promise.all(files.map((file) => readJsonFile<T[]>(file)))
  return chunks.flat()
}

function publicTagFields(entry: RawTagEntry): RawTagEntry {
  return {
    tag: entry.tag,
    name_zh: entry.name_zh,
    block: entry.block,
    category: entry.category,
    note: entry.note,
  }
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function sendMethodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405
  res.setHeader('Allow', 'GET')
  res.end()
}

function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? 'localhost'
  return new URL(req.url ?? '/', `http://${host}`)
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

// 在某个图库根下安全解析 images/ 路径（防穿越），存在则返回绝对路径
async function resolveImageInRoot(rootImagesDir: string, normalizedInput: string): Promise<string | null> {
  // normalizedInput 形如 images/xxx；相对图库根去掉前导 images/
  const relative = normalizedInput.replace(/^images\/+/, '')
  const resolvedPath = path.resolve(rootImagesDir, relative)
  const relativeToRoot = path.relative(rootImagesDir, resolvedPath)
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null
  try {
    await fs.access(resolvedPath)
    return resolvedPath
  } catch {
    return null
  }
}

async function sendDataImage(res: ServerResponse, imageRoots: string[], rawPath: string | null): Promise<void> {
  if (!rawPath || rawPath.includes('\0')) {
    sendJson(res, 400, { error: 'Invalid image path' })
    return
  }

  const normalizedInput = rawPath.replace(/^\/+/, '').replace(/^data\/+/, '')
  if (!normalizedInput.startsWith('images/')) {
    sendJson(res, 403, { error: 'Image path must be under images/' })
    return
  }

  // 依次尝试各图库根：data/images（新树自有扁平图）→ webapp/public/images（原始图库, 只读回退, #6）
  for (const root of imageRoots) {
    const resolvedPath = await resolveImageInRoot(root, normalizedInput)
    if (resolvedPath) {
      const content = await fs.readFile(resolvedPath)
      res.statusCode = 200
      res.setHeader('Content-Type', contentTypeFor(resolvedPath))
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.end(content)
      return
    }
  }
  sendJson(res, 404, { error: 'Image not found' })
}

async function readTagThumbIndex(dataDir: string): Promise<TagThumbIndex> {
  try {
    return await readJsonFile<TagThumbIndex>(path.join(dataDir, 'cache', 'tag_thumbs', '_index.json'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
}

async function sendTagThumb(res: ServerResponse, dataDir: string, fileName: string | null): Promise<void> {
  if (!fileName || !/^[A-Za-z0-9_.-]+\.jpg$/.test(fileName)) {
    sendJson(res, 403, { error: 'Invalid tag thumbnail file' })
    return
  }

  const thumbsDir = path.resolve(dataDir, 'cache', 'tag_thumbs')
  const resolvedPath = path.resolve(thumbsDir, fileName)
  const relativeToThumbs = path.relative(thumbsDir, resolvedPath)

  if (relativeToThumbs.startsWith('..') || path.isAbsolute(relativeToThumbs)) {
    sendJson(res, 403, { error: 'Tag thumbnail path is outside data/cache/tag_thumbs' })
    return
  }

  const content = await fs.readFile(resolvedPath)
  res.statusCode = 200
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.end(content)
}

// 递归列出图库根下所有图片，返回 images/... 相对路径
async function walkImageRoot(rootImagesDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)) {
        out.push(`images/${path.relative(rootImagesDir, full).split(path.sep).join('/')}`)
      }
    }
  }
  await walk(rootImagesDir)
  return out
}

async function listDataImages(imageRoots: string[]): Promise<string[]> {
  const all = await Promise.all(imageRoots.map((root) => walkImageRoot(root)))
  return Array.from(new Set(all.flat())).sort()
}

export function dataReadPlugin(): Plugin {
  return {
    name: 'webapp-next-data-read',
    configureServer(server) {
      const dataDir = path.resolve(server.config.root, '..', 'data')
      // 图库根：data/images（自有扁平图）优先，webapp/public/images（原始图库）只读回退(#6)
      const imageRoots = [path.resolve(dataDir, 'images'), path.resolve(server.config.root, '..', 'webapp', 'public', 'images')]

      server.middlewares.use(async (req, res, next) => {
        const url = requestUrl(req)
        const pathname = url.pathname
        if (!pathname.startsWith('/api/data/')) {
          next()
          return
        }

        if (req.method !== 'GET') {
          sendMethodNotAllowed(res)
          return
        }

        try {
          if (pathname === '/api/data/tags') {
            const tags = await readJsonArrayFromDir<RawTagEntry>(path.join(dataDir, 'tags'))
            sendJson(res, 200, tags.map(publicTagFields))
            return
          }

          if (pathname === '/api/data/recipes') {
            const recipes = await readJsonArrayFromDir<JsonValue>(path.join(dataDir, 'recipes'))
            sendJson(res, 200, recipes)
            return
          }

          if (pathname === '/api/data/characters') {
            const characters = await readJsonFile<JsonValue>(path.join(dataDir, 'characters.json'))
            sendJson(res, 200, characters)
            return
          }

          if (pathname === '/api/data/inspirations') {
            const inspirations = await readJsonFile<JsonValue>(path.join(dataDir, 'inspirations.json'))
            sendJson(res, 200, inspirations)
            return
          }

          if (pathname === '/api/data/nai-config') {
            const config = await readJsonFile<Record<string, JsonValue>>(path.join(dataDir, 'nai_config.json'))
            sendJson(res, 200, {
              default_base_blocks: config.default_base_blocks,
              size_presets: config.size_presets,
              default_params: config.default_params,
              batch: config.batch,
            })
            return
          }

          if (pathname === '/api/data/image') {
            await sendDataImage(res, imageRoots, url.searchParams.get('path'))
            return
          }

          if (pathname === '/api/data/tag-thumbs') {
            sendJson(res, 200, await readTagThumbIndex(dataDir))
            return
          }

          if (pathname === '/api/data/tag-thumb') {
            await sendTagThumb(res, dataDir, url.searchParams.get('file'))
            return
          }

          if (pathname === '/api/data/images') {
            sendJson(res, 200, await listDataImages(imageRoots))
            return
          }

          sendJson(res, 404, { error: 'Not found' })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown server error'
          sendJson(res, 500, { error: message })
        }
      })
    },
  }
}

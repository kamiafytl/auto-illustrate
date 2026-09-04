import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

/**
 * data-studio 数据库读写插件（红线核心，CC 亲自把关）。
 *
 * 安全不变量（改任何一条前都要重新审红线）：
 *  1. 可写文件 = WRITABLE 显式白名单。名单外（尤其 private_blocks.json / nai_config.json /
 *     scenarios / loras / 测试池等管线耦合或隐私件）一律拒写。隐私红线：CC 不碰 private_blocks 内容。
 *  2. 路径硬校验：禁 '..'、禁绝对路径、禁 '\0'，最终落点必须仍在 dataDir 内。
 *  3. 原子写：先写 *.tmp 再 rename，绝不在原文件上半截覆盖（防"覆盖唯一原文件"红线）。
 *  4. 每次写前自动备份到 data/.backups/（已 gitignore），可回滚。
 *  5. 字段保留式 merge：update 只浅合并传入字段，绝不丢 UI 不认识的旧字段（配方有 tags_front_* 等变体）。
 *  6. 写入内容必须是数组、单条必须是对象，类型不符即拒，避免把文件写坏。
 */

type JsonRecord = Record<string, unknown>

interface TableDef {
  key: string
  label: string
  // 'dir' = 一张逻辑表跨多个按 block 切分的文件（recipes / tags）；'file' = 单文件扁平数组
  kind: 'dir' | 'file'
  files: string[] // 相对 dataDir 的 relpath 列表，全部在白名单内
  idField: string // 记录主键字段名
  blockField?: string // dir 表：决定记录落到哪个文件的字段（值 = 文件名去扩展名）
  editable: boolean
}

// —— 表定义（也是写白名单的唯一来源）——
const TABLES: TableDef[] = [
  {
    key: 'recipes',
    label: '配方库',
    kind: 'dir',
    files: ['style', 'sub_style', 'character', 'clothing', 'action', 'expression', 'scene', 'effect'].map(
      (b) => `recipes/${b}.json`,
    ),
    idField: 'id',
    blockField: 'block',
    editable: true,
  },
  {
    key: 'tags',
    label: 'Tag 词典',
    kind: 'dir',
    files: ['action', 'camera', 'character', 'clothing', 'expression', 'scene', 'sub_style'].map(
      (b) => `tags/${b}.json`,
    ),
    idField: 'tag',
    blockField: 'block',
    editable: true,
  },
  { key: 'characters', label: '角色库', kind: 'file', files: ['characters.json'], idField: 'id', editable: true },
  { key: 'inspirations', label: '灵感库', kind: 'file', files: ['inspirations.json'], idField: 'id', editable: true },
  { key: 'research', label: '研究课题', kind: 'file', files: ['research.json'], idField: 'id', editable: true },
]

// 显式写白名单：只有这些 relpath 允许写。private_blocks/nai_config/scenarios/loras 等永不在内。
const WRITABLE = new Set<string>(TABLES.flatMap((t) => t.files))
// 兜底黑名单（即便将来误把它们加进白名单也拦下）。
const NEVER_WRITE = new Set(['private_blocks.json', 'nai_config.json', 'nai_config.example.json', 'translation_config.json'])

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? 'localhost'
  return new URL(req.url ?? '/', `http://${host}`)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

// relpath 安全解析：必须在白名单、无穿越、basename 不在黑名单，落点仍在 dataDir 内。返回绝对路径或 null。
function resolveWritable(dataDir: string, relpath: unknown): string | null {
  if (typeof relpath !== 'string' || !relpath || relpath.includes('\0') || relpath.includes('..')) return null
  if (path.isAbsolute(relpath)) return null
  if (!WRITABLE.has(relpath)) return null
  if (NEVER_WRITE.has(path.basename(relpath))) return null
  const abs = path.resolve(dataDir, relpath)
  const rel = path.relative(dataDir, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

async function readArrayFile(absFile: string): Promise<JsonRecord[]> {
  const content = await fs.readFile(absFile, 'utf8')
  const parsed = JSON.parse(content)
  if (!Array.isArray(parsed)) throw new Error(`${path.basename(absFile)} 不是数组，拒绝处理`)
  return parsed as JsonRecord[]
}

// 原子写 + 备份。relpath 用于备份文件命名（'/' 折成 '_' 避免 recipes/character 与 tags/character 撞名）。
async function writeArrayAtomic(dataDir: string, absFile: string, relpath: string, data: JsonRecord[]): Promise<void> {
  const backupDir = path.resolve(dataDir, '.backups')
  await fs.mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupName = `${relpath.replace(/[\\/]/g, '_')}.${stamp}.bak`
  try {
    await fs.copyFile(absFile, path.join(backupDir, backupName))
  } catch {
    // 原文件不存在（新文件）时跳过备份
  }
  const tmp = `${absFile}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, absFile)
}

function tableByKey(key: string | null): TableDef | undefined {
  return TABLES.find((t) => t.key === key)
}

// —— 读：把一张逻辑表读成记录数组，每条标注来源 relpath（前端写回时按此路由）——
async function loadTable(dataDir: string, table: TableDef): Promise<JsonRecord[]> {
  const out: JsonRecord[] = []
  for (const relpath of table.files) {
    const abs = path.resolve(dataDir, relpath)
    let records: JsonRecord[]
    try {
      records = await readArrayFile(abs)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'ENOENT') continue
      throw error
    }
    for (const rec of records) out.push({ ...rec, __file: relpath })
  }
  return out
}

// dir 表按 blockField 决定落点文件；file 表固定单文件。
function fileForRecord(table: TableDef, record: JsonRecord): string | null {
  if (table.kind === 'file') return table.files[0]
  const block = table.blockField ? record[table.blockField] : undefined
  if (typeof block !== 'string') return null
  const relpath = `${table.files[0].split('/')[0]}/${block}.json`
  return WRITABLE.has(relpath) ? relpath : null
}

function genId(table: TableDef): string {
  const prefixMap: Record<string, string> = {
    recipes: 'recipe',
    characters: 'char',
    inspirations: 'insp',
    research: 'res',
  }
  const prefix = prefixMap[table.key] ?? table.key
  return `${prefix}-${Date.now()}`
}

// —— 图片服务（防穿越，data/images 优先，webapp/public/images 只读回退）——
function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

async function resolveImageInRoot(rootImagesDir: string, normalizedInput: string): Promise<string | null> {
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

export function dataStorePlugin(): Plugin {
  return {
    name: 'data-studio-data-store',
    configureServer(server) {
      const dataDir = path.resolve(server.config.root, '..', 'data')
      const imageRoots = [
        path.resolve(dataDir, 'images'),
        path.resolve(server.config.root, '..', 'webapp', 'public', 'images'),
      ]

      server.middlewares.use(async (req, res, next) => {
        const url = requestUrl(req)
        const pathname = url.pathname
        if (!pathname.startsWith('/api/db/')) {
          next()
          return
        }

        try {
          // ——— 读 ———
          if (req.method === 'GET' && pathname === '/api/db/manifest') {
            sendJson(
              res,
              200,
              TABLES.map((t) => ({
                key: t.key,
                label: t.label,
                kind: t.kind,
                files: t.files,
                idField: t.idField,
                blockField: t.blockField ?? null,
                editable: t.editable,
              })),
            )
            return
          }

          if (req.method === 'GET' && pathname === '/api/db/table') {
            const table = tableByKey(url.searchParams.get('key'))
            if (!table) {
              sendJson(res, 404, { error: 'Unknown table' })
              return
            }
            sendJson(res, 200, { key: table.key, records: await loadTable(dataDir, table) })
            return
          }

          if (req.method === 'GET' && pathname === '/api/db/image') {
            await sendDataImage(res, imageRoots, url.searchParams.get('path'))
            return
          }

          // ——— 写（全部 POST，白名单 + 原子 + 备份 + 字段保留）———
          if (req.method === 'POST' && (pathname === '/api/db/create' || pathname === '/api/db/update' || pathname === '/api/db/delete')) {
            const body = (await readBody(req)) as JsonRecord
            const table = tableByKey(typeof body.tableKey === 'string' ? body.tableKey : null)
            if (!table || !table.editable) {
              sendJson(res, 403, { error: '未知或不可编辑的表' })
              return
            }

            if (pathname === '/api/db/create') {
              const record = body.record as JsonRecord | undefined
              if (!record || typeof record !== 'object' || Array.isArray(record)) {
                sendJson(res, 400, { error: 'record 必须是对象' })
                return
              }
              const clean: JsonRecord = { ...record }
              delete clean.__file
              if (table.idField === 'id' && !clean.id) clean.id = genId(table)
              const relpath = fileForRecord(table, clean)
              const abs = relpath ? resolveWritable(dataDir, relpath) : null
              if (!abs || !relpath) {
                sendJson(res, 400, { error: '无法确定写入文件（dir 表缺少有效 block）' })
                return
              }
              const arr = await readArrayFile(abs)
              arr.push(clean)
              await writeArrayAtomic(dataDir, abs, relpath, arr)
              sendJson(res, 200, { ok: true, record: { ...clean, __file: relpath } })
              return
            }

            // update / delete 都靠 (file, idField, id) 定位
            const relpath = typeof body.file === 'string' ? body.file : null
            const abs = resolveWritable(dataDir, relpath)
            if (!abs || !relpath) {
              sendJson(res, 403, { error: '目标文件不在可写白名单' })
              return
            }
            const id = body.id
            const arr = await readArrayFile(abs)
            const idx = arr.findIndex((r) => r[table.idField] === id)
            if (idx < 0) {
              sendJson(res, 404, { error: '未找到记录' })
              return
            }

            if (pathname === '/api/db/update') {
              const patch = body.patch as JsonRecord | undefined
              if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                sendJson(res, 400, { error: 'patch 必须是对象' })
                return
              }
              const cleanPatch: JsonRecord = { ...patch }
              delete cleanPatch.__file
              // 字段保留式浅合并：只覆盖传入字段，其余原样保留
              const merged = { ...arr[idx], ...cleanPatch }
              // dir 表若改了 block，记录要迁到另一文件
              const targetRel = fileForRecord(table, merged)
              if (table.kind === 'dir' && targetRel && targetRel !== relpath) {
                const targetAbs = resolveWritable(dataDir, targetRel)
                if (!targetAbs) {
                  sendJson(res, 400, { error: '改后的 block 无对应文件' })
                  return
                }
                arr.splice(idx, 1)
                await writeArrayAtomic(dataDir, abs, relpath, arr)
                const targetArr = await readArrayFile(targetAbs)
                targetArr.push(merged)
                await writeArrayAtomic(dataDir, targetAbs, targetRel, targetArr)
                sendJson(res, 200, { ok: true, record: { ...merged, __file: targetRel }, moved: true })
                return
              }
              arr[idx] = merged
              await writeArrayAtomic(dataDir, abs, relpath, arr)
              sendJson(res, 200, { ok: true, record: { ...merged, __file: relpath } })
              return
            }

            // delete
            arr.splice(idx, 1)
            await writeArrayAtomic(dataDir, abs, relpath, arr)
            sendJson(res, 200, { ok: true })
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

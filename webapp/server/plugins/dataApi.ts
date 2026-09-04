import { type Plugin } from 'vite'
import path from 'path'
import fs from 'fs'

export function dataApiPlugin(rootDir: string): Plugin {
  const publicData = path.resolve(rootDir, 'public/data')
  const rootData = path.resolve(rootDir, '../data')
  const assemblyFile = path.resolve(rootDir, '../output/assembly_public.json')
  const ALL_BLOCKS = ['action', 'clothing', 'expression', 'style', 'sub_style', 'character', 'scene', 'camera']

  function readBody(req: { on: (e: string, cb: (d: Buffer | undefined) => void) => void }): Promise<string> {
    return new Promise(resolve => {
      let body = ''
      req.on('data', (chunk: Buffer | undefined) => { if (chunk) body += chunk.toString() })
      req.on('end', () => resolve(body))
    })
  }

  function readJson(filePath: string): Record<string, unknown>[] {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) }
    catch { return [] }
  }

  function writeJson(pub: string, root: string, data: unknown[]) {
    const json = JSON.stringify(data, null, 2)
    fs.mkdirSync(path.dirname(pub), { recursive: true })
    fs.writeFileSync(pub, json, 'utf-8')
    fs.mkdirSync(path.dirname(root), { recursive: true })
    fs.writeFileSync(root, json, 'utf-8')
  }

  const recipePaths = (block: string) => ({
    pub: path.join(publicData, 'recipes', `${block}.json`),
    root: path.join(rootData, 'recipes', `${block}.json`),
  })

  const tagPaths = (block: string) => ({
    pub: path.join(publicData, 'tags', `${block}.json`),
    root: path.join(rootData, 'tags', `${block}.json`),
  })

  const inspPaths = () => ({
    pub: path.join(publicData, 'inspirations.json'),
    root: path.join(rootData, 'inspirations.json'),
  })

  const loraPaths = () => ({
    pub: path.join(publicData, 'loras.json'),
    root: path.join(rootData, 'loras.json'),
  })

  const workflowDir = (sub: 'pub' | 'root') =>
    sub === 'pub'
      ? path.join(publicData, 'workflows')
      : path.join(rootData, 'workflows')

  function writeWorkflowIndex(ids: string[]) {
    const json = JSON.stringify(ids, null, 2)
    for (const dir of [workflowDir('pub'), workflowDir('root')]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '_index.json'), json, 'utf-8')
    }
  }

  function readWorkflowIndex(): string[] {
    try {
      return JSON.parse(fs.readFileSync(path.join(workflowDir('pub'), '_index.json'), 'utf-8'))
    } catch { return [] }
  }

  return {
    name: 'data-api',
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url as string | undefined
        if (!url?.startsWith('/api/')) return next()
        if (url.startsWith('/api/comfyui/')) return next()
        if (url.startsWith('/api/data/')) return next()
        if (url.startsWith('/api/git-')) return next()
        if (url.startsWith('/api/nai/')) return next()
        if (url.startsWith('/api/translate')) return next()
        if (url.startsWith('/api/batch-plans')) return next()
        if (url.startsWith('/api/characters')) return next()
        if (url.startsWith('/api/rating')) return next()  // 评分 API 由 ratingPlugin 处理，别在这消费 body
        if (url.startsWith('/api/danbooru')) return next()  // danbooru 查询由 danbooruPlugin 处理（E2 tag词典接网）

        const send = (data: unknown, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        }

        // Private blocks API — 前端保存隐私block到文件（方案C）
        if (url === '/api/assembly/private') {
          const privateBlocksFile = path.resolve(rootDir, '../data/private_blocks.json')
          try {
            if (req.method === 'GET') {
              if (fs.existsSync(privateBlocksFile)) {
                return send(JSON.parse(fs.readFileSync(privateBlocksFile, 'utf-8')))
              }
              return send({})
            }
            if (req.method === 'POST') {
              const body = JSON.parse(await readBody(req))
              // ★合并写(不再整体覆盖):body 只含组装棚隐私 block,但本文件还存着【加装层 persona】
              // (`nai_augpreset:*` key,由 nai.ts 端点独立管理)。旧的整体覆盖会把 persona 连根抹掉
              // ——Owner 加装层一个月频繁丢失的根因。这里只更新组装棚 block,保留所有 nai_augpreset:* key。
              let existing: Record<string, unknown> = {}
              try { if (fs.existsSync(privateBlocksFile)) existing = JSON.parse(fs.readFileSync(privateBlocksFile, 'utf-8')) } catch { /* 读失败按空处理 */ }
              const merged: Record<string, unknown> = { ...body }
              for (const k of Object.keys(existing)) {
                if (k.startsWith('nai_augpreset:')) merged[k] = existing[k]
              }
              fs.mkdirSync(path.dirname(privateBlocksFile), { recursive: true })
              fs.writeFileSync(privateBlocksFile, JSON.stringify(merged, null, 2), 'utf-8')
              return send({ ok: true })
            }
          } catch (err: unknown) {
            return send({ error: err instanceof Error ? err.message : 'unknown error' }, 500)
          }
        }

        // Assembly API — 支持GET和POST
        if (url === '/api/assembly') {
          try {
            if (req.method === 'GET') {
              if (fs.existsSync(assemblyFile)) {
                const content = fs.readFileSync(assemblyFile, 'utf-8')
                return send(JSON.parse(content))
              }
              return send({ blocks: {}, _meta: { updatedAt: '', updatedBy: 'browser' } })
            }
            if (req.method === 'POST') {
              const body = JSON.parse(await readBody(req))
              fs.mkdirSync(path.dirname(assemblyFile), { recursive: true })
              fs.writeFileSync(assemblyFile, JSON.stringify(body, null, 2), 'utf-8')
              return send({ ok: true })
            }
          } catch (err: unknown) {
            return send({ error: err instanceof Error ? err.message : 'unknown error' }, 500)
          }
        }

        if (req.method !== 'POST') return next()

        try {
          const body = JSON.parse(await readBody(req))

          if (url === '/api/save') {
            const { type, data, old: oldData } = body

            if (type === 'recipes') {
              // 删除旧条目（处理block变更）
              const searchId = oldData?.id || data.id
              for (const b of ALL_BLOCKS) {
                const p = recipePaths(b)
                if (!fs.existsSync(p.pub)) continue
                const arr = readJson(p.pub)
                const idx = arr.findIndex(r => r.id === searchId)
                if (idx >= 0) {
                  arr.splice(idx, 1)
                  writeJson(p.pub, p.root, arr)
                  break
                }
              }
              // 写入目标block文件
              const p = recipePaths(data.block)
              const arr = readJson(p.pub)
              arr.push(data)
              writeJson(p.pub, p.root, arr)
              return send({ ok: true })
            }

            if (type === 'tags') {
              // 如果tag/block改变，从旧文件删除
              if (oldData?.tag && oldData?.block) {
                const oldP = tagPaths(oldData.block)
                if (fs.existsSync(oldP.pub)) {
                  const arr = readJson(oldP.pub)
                  const filtered = arr.filter(t => !(t.tag === oldData.tag && t.block === oldData.block))
                  if (filtered.length !== arr.length) writeJson(oldP.pub, oldP.root, filtered)
                }
              }
              // 写入目标block文件
              const p = tagPaths(data.block)
              const arr = readJson(p.pub)
              const idx = arr.findIndex(t => t.tag === data.tag && t.block === data.block)
              if (idx >= 0) arr[idx] = data
              else arr.push(data)
              writeJson(p.pub, p.root, arr)
              return send({ ok: true })
            }

            if (type === 'inspirations') {
              const p = inspPaths()
              const arr = readJson(p.pub)
              const idx = arr.findIndex(i => i.id === data.id)
              if (idx >= 0) arr[idx] = data
              else arr.push(data)
              writeJson(p.pub, p.root, arr)
              return send({ ok: true })
            }

            if (type === 'loras') {
              const p = loraPaths()
              const arr = readJson(p.pub)
              const idx = arr.findIndex((l) => (l as Record<string, unknown>).id === data.id)
              if (idx >= 0) arr[idx] = data
              else arr.push(data)
              writeJson(p.pub, p.root, arr)
              return send({ ok: true })
            }

            return send({ error: 'unknown type' }, 400)
          }

          if (url === '/api/reorder-tags') {
            const { block, tags: newTags } = body
            if (!block || !Array.isArray(newTags)) return send({ error: 'block and tags required' }, 400)
            const p = tagPaths(block)
            writeJson(p.pub, p.root, newTags)
            return send({ ok: true })
          }

          if (url === '/api/rename-category') {
            const { block, oldCategory, newCategory } = body
            if (!block || !oldCategory || !newCategory) return send({ error: 'block, oldCategory, newCategory required' }, 400)
            const p = tagPaths(block)
            if (!fs.existsSync(p.pub)) return send({ error: 'block file not found' }, 404)
            const arr = readJson(p.pub)
            for (const t of arr) {
              if ((t as Record<string, unknown>).category === oldCategory) {
                (t as Record<string, unknown>).category = newCategory
              }
            }
            writeJson(p.pub, p.root, arr)
            return send({ ok: true })
          }

          /* ── 图片文件持久化 API（单图，不再区分 thumb/full） ── */
          if (url === '/api/save-image') {
            const { key, image } = body
            const sanitized = (key as string).replace(/:/g, '--')
            const pubImgDir = path.join(publicData, 'images')
            const rootImgDir = path.join(rootData, 'images')
            fs.mkdirSync(pubImgDir, { recursive: true })
            fs.mkdirSync(rootImgDir, { recursive: true })
            const buf = Buffer.from((image as string).split(',')[1], 'base64')
            for (const dir of [pubImgDir, rootImgDir]) {
              fs.writeFileSync(path.join(dir, `${sanitized}_full.webp`), buf)
              // 清理旧版 thumb 文件（如果存在）
              const oldThumb = path.join(dir, `${sanitized}_thumb.webp`)
              if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb)
            }
            return send({ ok: true })
          }

          if (url === '/api/delete-image') {
            const { key } = body
            const sanitized = (key as string).replace(/:/g, '--')
            for (const dir of [path.join(publicData, 'images'), path.join(rootData, 'images')]) {
              for (const suffix of ['_full.webp', '_thumb.webp']) {
                const f = path.join(dir, sanitized + suffix)
                if (fs.existsSync(f)) fs.unlinkSync(f)
              }
            }
            return send({ ok: true })
          }

          if (url === '/api/list-images') {
            const imgDir = path.join(publicData, 'images')
            if (!fs.existsSync(imgDir)) return send({ keys: [] })
            const files = fs.readdirSync(imgDir)
            const keys = new Set<string>()
            for (const f of files) {
              const m = f.match(/^(.+)_full\.webp$/)
              if (m) keys.add(m[1].replace(/--/g, ':'))
            }
            return send({ keys: Array.from(keys) })
          }

          if (url === '/api/delete') {
            const { type, id, tag, block } = body

            if (type === 'recipes' && block) {
              const p = recipePaths(block)
              if (fs.existsSync(p.pub)) {
                const arr = readJson(p.pub).filter(r => r.id !== id)
                writeJson(p.pub, p.root, arr)
              }
              return send({ ok: true })
            }

            if (type === 'tags' && block) {
              const p = tagPaths(block)
              if (fs.existsSync(p.pub)) {
                const arr = readJson(p.pub).filter(t => !(t.tag === tag && t.block === block))
                writeJson(p.pub, p.root, arr)
              }
              return send({ ok: true })
            }

            if (type === 'inspirations') {
              const p = inspPaths()
              const arr = readJson(p.pub).filter(i => i.id !== id)
              writeJson(p.pub, p.root, arr)
              return send({ ok: true })
            }

            if (type === 'loras') {
              const p = loraPaths()
              const arr = readJson(p.pub).filter((l) => (l as Record<string, unknown>).id !== id)
              writeJson(p.pub, p.root, arr)
              return send({ ok: true })
            }

            return send({ error: 'unknown type' }, 400)
          }

          /* ── Workflow模板 CRUD ── */
          if (url === '/api/save-workflow') {
            const { data } = body
            const json = JSON.stringify(data, null, 2)
            for (const dir of [workflowDir('pub'), workflowDir('root')]) {
              fs.mkdirSync(dir, { recursive: true })
              fs.writeFileSync(path.join(dir, `${data.id}.json`), json, 'utf-8')
            }
            const ids = readWorkflowIndex()
            if (!ids.includes(data.id)) {
              ids.push(data.id)
              writeWorkflowIndex(ids)
            }
            return send({ ok: true })
          }

          if (url === '/api/delete-workflow') {
            const { id } = body
            for (const dir of [workflowDir('pub'), workflowDir('root')]) {
              const f = path.join(dir, `${id}.json`)
              if (fs.existsSync(f)) fs.unlinkSync(f)
            }
            writeWorkflowIndex(readWorkflowIndex().filter(i => i !== id))
            return send({ ok: true })
          }

          next()
        } catch (err: unknown) {
          send({ error: err instanceof Error ? err.message : 'unknown error' }, 500)
        }
      })
    }
  }
}

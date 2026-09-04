import { type Plugin } from 'vite'
import path from 'path'
import fs from 'fs'

export function charactersPlugin(rootDir: string): Plugin {
  const repoRoot = path.resolve(rootDir, '..')
  const charactersFile = path.join(repoRoot, 'data', 'characters.json')

  function readBody(req: { on: (e: string, cb: (d: Buffer | undefined) => void) => void }): Promise<string> {
    return new Promise(resolve => {
      let body = ''
      req.on('data', (chunk: Buffer | undefined) => { if (chunk) body += chunk.toString() })
      req.on('end', () => resolve(body))
    })
  }

  function loadAll(): unknown[] {
    if (!fs.existsSync(charactersFile)) return []
    try {
      const data = JSON.parse(fs.readFileSync(charactersFile, 'utf-8'))
      return Array.isArray(data) ? data : []
    } catch { return [] }
  }

  function saveAll(items: unknown[]) {
    fs.mkdirSync(path.dirname(charactersFile), { recursive: true })
    fs.writeFileSync(charactersFile, JSON.stringify(items, null, 2), 'utf-8')
  }

  return {
    name: 'characters',
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url as string | undefined
        if (!url?.startsWith('/api/characters')) return next()

        const send = (data: unknown, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        }

        try {
          // GET /api/characters — 全部
          if (url === '/api/characters' && req.method === 'GET') {
            return send(loadAll())
          }

          // POST /api/characters — 新增/更新（按 id upsert）
          if (url === '/api/characters' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as { id?: string }
            if (!body.id) return send({ error: 'id required' }, 400)
            const items = loadAll() as { id?: string }[]
            const idx = items.findIndex(c => c.id === body.id)
            const now = new Date().toISOString()
            const toSave = { ...body, updatedAt: now } as Record<string, unknown>
            if (idx >= 0) {
              items[idx] = { ...(items[idx] as Record<string, unknown>), ...toSave }
            } else {
              if (!toSave.createdAt) toSave.createdAt = now
              items.push(toSave as { id: string })
            }
            saveAll(items)
            return send({ ok: true })
          }

          // DELETE /api/characters/:id
          if (url.startsWith('/api/characters/') && req.method === 'DELETE') {
            const id = url.replace('/api/characters/', '').replace(/\?.*$/, '')
            const items = (loadAll() as { id?: string }[]).filter(c => c.id !== id)
            saveAll(items)
            return send({ ok: true })
          }

          // GET /api/characters/:id — 读单个（罕用，前端通常一次性加载全部）
          if (url.startsWith('/api/characters/') && req.method === 'GET') {
            const id = url.replace('/api/characters/', '').replace(/\?.*$/, '')
            const item = (loadAll() as { id?: string }[]).find(c => c.id === id)
            if (!item) return send({ error: 'not found' }, 404)
            return send(item)
          }

          next()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          send({ error: msg }, 500)
        }
      })
    },
  }
}

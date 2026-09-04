import { type Plugin } from 'vite'
import path from 'path'
import fs from 'fs'
import http from 'node:http'
import https from 'node:https'

export function comfyuiBridgePlugin(rootDir: string): Plugin {
  const envConfigPath = path.resolve(rootDir, '../tools/comfyui_env.json')

  function getComfyUIUrl(): string {
    const config = JSON.parse(fs.readFileSync(envConfigPath, 'utf-8'))
    const env = config.env as string
    let url = config[env].comfyui_url as string
    if (url.includes('{{WINDOWS_HOST_IP}}')) {
      try {
        const resolv = fs.readFileSync('/etc/resolv.conf', 'utf-8')
        const match = resolv.match(/nameserver\s+(\S+)/)
        if (match) url = url.replace('{{WINDOWS_HOST_IP}}', match[1])
      } catch {
        url = url.replace('{{WINDOWS_HOST_IP}}', 'localhost')
      }
    }
    return url.replace(/\/$/, '')
  }

  function getEnvName(): string {
    try {
      return JSON.parse(fs.readFileSync(envConfigPath, 'utf-8')).env as string
    } catch { return 'unknown' }
  }

  // Node.js http/https proxy helper
  function proxyRequest(
    targetUrl: string,
    method: string,
    postBody?: string,
    timeout = 15000
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(targetUrl)
      const mod = parsed.protocol === 'https:' ? https : http
      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        timeout,
        headers: postBody ? { 'Content-Type': 'application/json' } : undefined,
      }
      const req = mod.request(options, (resp) => {
        const chunks: Buffer[] = []
        resp.on('data', (chunk: Buffer) => chunks.push(chunk))
        resp.on('end', () => resolve({
          status: resp.statusCode || 200,
          headers: resp.headers,
          body: Buffer.concat(chunks),
        }))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      if (postBody) req.write(postBody)
      req.end()
    })
  }

  function readBody(req: { on: (e: string, cb: (d: Buffer | undefined) => void) => void }): Promise<string> {
    return new Promise(resolve => {
      let body = ''
      req.on('data', (chunk: Buffer | undefined) => { if (chunk) body += chunk.toString() })
      req.on('end', () => resolve(body))
    })
  }

  return {
    name: 'comfyui-bridge',
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url as string | undefined
        if (!url?.startsWith('/api/comfyui/')) return next()

        const send = (data: unknown, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        }

        const sendBinary = (buffer: Buffer, contentType: string) => {
          res.writeHead(200, { 'Content-Type': contentType })
          res.end(buffer)
        }

        const comfyUrl = getComfyUIUrl()

        try {
          // 测试连通性
          if (url === '/api/comfyui/test') {
            const result = await proxyRequest(`${comfyUrl}/system_stats`, 'GET')
            const data = JSON.parse(result.body.toString())
            return send({
              ok: true,
              env: getEnvName(),
              url: comfyUrl,
              system: data,
            })
          }

          // 获取模型列表
          if (url === '/api/comfyui/models') {
            const body = JSON.parse(await readBody(req))
            const modelType = body.type || 'loras'
            const result = await proxyRequest(`${comfyUrl}/models/${modelType}`, 'GET')
            return send(JSON.parse(result.body.toString()))
          }

          // 提交workflow
          if (url === '/api/comfyui/prompt') {
            const body = JSON.parse(await readBody(req))
            const result = await proxyRequest(
              `${comfyUrl}/prompt`,
              'POST',
              JSON.stringify({ prompt: body.prompt }),
              30000
            )
            return send(JSON.parse(result.body.toString()), result.status)
          }

          // 查询执行结果
          if (url === '/api/comfyui/history') {
            const body = JSON.parse(await readBody(req))
            const promptId = body.promptId || ''
            const target = promptId ? `${comfyUrl}/history/${promptId}` : `${comfyUrl}/history`
            const result = await proxyRequest(target, 'GET')
            return send(JSON.parse(result.body.toString()))
          }

          // 代理获取输出图片
          if (url === '/api/comfyui/view') {
            const body = JSON.parse(await readBody(req))
            const params = new URLSearchParams({ filename: body.filename })
            if (body.subfolder) params.set('subfolder', body.subfolder)
            if (body.type) params.set('type', body.type)
            const result = await proxyRequest(`${comfyUrl}/view?${params}`, 'GET', undefined, 30000)
            return sendBinary(result.body, result.headers['content-type'] || 'image/png')
          }

          next()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          send({
            ok: false,
            error: `ComfyUI不可达: ${msg}`,
            hint: 'ComfyUI已启动且监听了0.0.0.0:8188？',
            url: comfyUrl,
          }, 502)
        }
      })
    }
  }
}

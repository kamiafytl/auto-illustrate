import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// 翻译插件：danbooru/英文 tag → 简体中文。
// 离线优先：调用方先用 name_zh，命中不到才请求这里；本端 = 缓存优先 > DeepSeek API。
// API key 只在服务端读取，绝不下发到浏览器（隐私/安全红线）。

type TransCacheEntry = { translation: string; source: string; ts: number }
type TransCache = Record<string, TransCacheEntry>

type TranslationConfig = {
  api_key?: string
  base_url?: string
  model?: string
  chat_completions_path?: string
}

function cacheKey(text: string): string {
  return text.trim().toLocaleLowerCase()
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

// 只翻"看起来像 tag/短语"的英文文本；整段自然语言、含隐私占位、纯中文都跳过
function translatable(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (t.includes('__PRIVATE')) return false
  if (/[㐀-鿿]/.test(t)) return false // 已含中文
  if (t.length > 80) return false // 整段自然语言不盲喂
  if (!/[a-zA-Z]/.test(t)) return false
  return true
}

async function callDeepSeek(config: TranslationConfig, texts: string[]): Promise<Record<string, string>> {
  const baseUrl = (config.base_url ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const pathPart = config.chat_completions_path ?? '/chat/completions'
  const url = `${baseUrl}${pathPart}`
  const system =
    '你是 danbooru 标签翻译器。把用户给的每个英文 tag/短语翻译成简洁的简体中文（2-8字，名词或短语，不要解释）。' +
    '严格只返回一个 JSON 对象，key=原文，value=中文译文，不要任何额外文字或代码块标记。'
  const user = JSON.stringify(texts)

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: config.model ?? 'deepseek-v4-flash',
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`DeepSeek ${resp.status}: ${detail.slice(0, 200)}`)
  }

  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content ?? ''
  const jsonText = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const parsed = JSON.parse(jsonText) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return out
}

export function translatePlugin(): Plugin {
  return {
    name: 'studio-next-translate',
    configureServer(server) {
      const dataDir = path.resolve(server.config.root, '..', 'data')
      const configPath = path.join(dataDir, 'translation_config.json')
      const cacheDir = path.join(dataDir, 'cache')
      const cachePath = path.join(cacheDir, 'trans_cache.json')
      let writing: Promise<void> = Promise.resolve()

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/translate')) {
          next()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Allow', 'POST')
          res.end()
          return
        }

        try {
          const body = await readBody(req)
          const payload = JSON.parse(body || '{}') as { texts?: unknown }
          const texts = Array.isArray(payload.texts) ? payload.texts.filter((t): t is string => typeof t === 'string') : []
          const cache = await readJsonSafe<TransCache>(cachePath, {})

          const translations: Record<string, string> = {}
          const missing: string[] = []
          for (const text of texts) {
            if (!translatable(text)) continue
            const key = cacheKey(text)
            const hit = cache[key]
            if (hit) {
              translations[text] = hit.translation
            } else {
              missing.push(text)
            }
          }

          const config = await readJsonSafe<TranslationConfig>(configPath, {})
          let apiError: string | null = null
          const uniqueMissing = Array.from(new Set(missing))

          if (uniqueMissing.length > 0 && config.api_key && !config.api_key.includes('待')) {
            try {
              const fresh = await callDeepSeek(config, uniqueMissing)
              const ts = Date.now()
              for (const text of uniqueMissing) {
                const zh = fresh[text]
                if (!zh) continue
                translations[text] = zh
                cache[cacheKey(text)] = { translation: zh, source: `deepseek:${config.model ?? ''}`, ts }
              }
              // 串行写盘，避免并发覆盖
              writing = writing.then(async () => {
                await fs.mkdir(cacheDir, { recursive: true })
                await fs.writeFile(cachePath, JSON.stringify(cache, null, 0), 'utf8')
              })
              await writing
            } catch (error) {
              apiError = error instanceof Error ? error.message : 'translate failed'
            }
          } else if (uniqueMissing.length > 0 && (!config.api_key || config.api_key.includes('待'))) {
            apiError = 'translation_config.json 缺 api_key'
          }

          sendJson(res, 200, { translations, untranslated: uniqueMissing.filter((t) => !translations[t]), error: apiError })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'translate error' })
        }
      })
    },
  }
}

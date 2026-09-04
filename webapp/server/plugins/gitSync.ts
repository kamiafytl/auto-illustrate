import { type Plugin } from 'vite'
import path from 'path'
import { execSync } from 'node:child_process'

export function gitSyncPlugin(rootDir: string): Plugin {
  const repoRoot = path.resolve(rootDir, '..')
  const home = process.env.HOME || '/home/user'
  const sshKey = path.join(home, '.ssh', 'id_ed25519')

  function git(cmd: string): string {
    return execSync(cmd, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 30000,
      env: {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i ${sshKey} -o StrictHostKeyChecking=no`,
      },
    }).trim()
  }

  return {
    name: 'git-sync',
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url as string | undefined

        const send = (data: unknown, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        }

        // GET /api/git-status — 返回是否有未提交变更、上次push时间
        if (url === '/api/git-status' && req.method === 'GET') {
          try {
            const status = git('git status --porcelain')
            const hasChanges = status.length > 0
            let lastPushTime = ''
            try {
              // 获取当前分支最后push到remote的commit时间
              const remote = git('git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo ""')
              if (remote) {
                lastPushTime = git(`git log -1 --format=%aI ${remote}`)
              }
            } catch { /* no upstream */ }
            return send({ ok: true, hasChanges, lastPushTime })
          } catch (err) {
            return send({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
          }
        }

        // POST /api/git-sync — 执行 git add + commit + push
        if (url === '/api/git-sync' && req.method === 'POST') {
          try {
            const status = git('git status --porcelain')
            if (!status) {
              return send({ ok: true, message: '没有需要同步的变更', skipped: true })
            }

            git('git add -A')

            const now = new Date()
            const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
            const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
            const msg = `Daily sync ${dateStr} ${timeStr}`
            git(`git commit -m "${msg}"`)

            const pushResult = git('git push 2>&1')
            return send({ ok: true, message: msg, pushResult })
          } catch (err: unknown) {
            const errObj = err as { message?: string; stderr?: string; stdout?: string }
            const detail = errObj.stderr || errObj.stdout || errObj.message || String(err)
            return send({ ok: false, error: detail }, 500)
          }
        }

        next()
      })
    }
  }
}

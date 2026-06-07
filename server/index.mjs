import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import express from 'express'
import cookie from 'cookie'

const execFileAsync = promisify(execFile)
const app = express()

const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3777),
  publicUrl: process.env.PUBLIC_URL ?? 'http://127.0.0.1:3777',
  org: process.env.GITHUB_ORG ?? 'Palomos-Molones',
  clientId: process.env.GITHUB_CLIENT_ID ?? '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  authBypass: process.env.AUTH_BYPASS === '1' && process.env.NODE_ENV !== 'production',
  bridgeDb: process.env.BRIDGE_DB ?? '/home/clawbot/.local/state/github-agent-bridge/bridge.sqlite3',
  sessionsDir: process.env.OPENCLAW_SESSIONS_DIR ?? '/home/clawbot/.openclaw/agents/main/sessions',
  codexSessionsDir:
    process.env.CODEX_SESSIONS_DIR ??
    '/home/clawbot/.openclaw/agents/main/agent/codex-home/sessions',
}

app.use(express.json())

function isAuthConfigured() {
  return Boolean(config.clientId && config.clientSecret && config.sessionSecret)
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret || 'dev').update(value).digest('base64url')
}

function encodeSession(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${sign(body)}`
}

function decodeSession(header) {
  const cookies = cookie.parse(header ?? '')
  const raw = cookies.claw_session
  if (!raw) return null
  const [body, signature] = raw.split('.')
  if (!body || !signature || sign(body) !== signature) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function requireAuth(req, res, next) {
  if (config.authBypass) {
    req.user = { login: 'dev-bypass', org: config.org }
    return next()
  }
  const session = decodeSession(req.headers.cookie)
  if (!session) {
    return res.status(401).json({ error: 'auth_required', authConfigured: isAuthConfigured() })
  }
  req.user = session
  return next()
}

function redirectToLogin(req, res, next) {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path === '/healthz') return next()
  if (config.authBypass || decodeSession(req.headers.cookie) || !isAuthConfigured()) return next()
  return res.redirect('/auth/login')
}

app.get('/healthz', (_req, res) => res.json({ ok: true }))

app.get('/auth/config', (_req, res) => {
  res.json({ org: config.org, configured: isAuthConfigured(), publicUrl: config.publicUrl })
})

app.get('/auth/login', (req, res) => {
  if (!isAuthConfigured()) return res.status(503).send('GitHub auth is not configured yet.')
  const state = crypto.randomBytes(24).toString('base64url')
  res.setHeader(
    'Set-Cookie',
    cookie.serialize('claw_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicUrl.startsWith('https://'),
      path: '/',
      maxAge: 600,
    }),
  )
  const redirectUri = new URL('/auth/github/callback', config.publicUrl).toString()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  res.redirect(url.toString())
})

app.get('/auth/github/callback', async (req, res) => {
  const cookies = cookie.parse(req.headers.cookie ?? '')
  if (!isAuthConfigured() || req.query.state !== cookies.claw_oauth_state || typeof req.query.code !== 'string') {
    return res.status(400).send('Invalid GitHub OAuth callback.')
  }

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: req.query.code,
      redirect_uri: new URL('/auth/github/callback', config.publicUrl).toString(),
    }),
  })
  const tokenJson = await tokenResponse.json()
  if (!tokenJson.access_token) return res.status(401).send('GitHub did not return an access token.')

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${tokenJson.access_token}`,
    'user-agent': 'claw-dashboard',
    'x-github-api-version': '2022-11-28',
  }
  const [userResponse, membershipResponse] = await Promise.all([
    fetch('https://api.github.com/user', { headers }),
    fetch(`https://api.github.com/user/memberships/orgs/${config.org}`, { headers }),
  ])
  const user = await safeJson(userResponse)
  const membership = await safeJson(membershipResponse)
  if (!user.login || membershipResponse.status !== 200 || membership?.state !== 'active') {
    const details = {
      user: user.login ?? null,
      org: config.org,
      membershipStatus: membershipResponse.status,
      membershipState: membership?.state ?? null,
      githubMessage: membership?.message ?? null,
      acceptedScopes: membershipResponse.headers.get('x-accepted-oauth-scopes') ?? null,
      oauthScopes: membershipResponse.headers.get('x-oauth-scopes') ?? null,
    }
    console.warn('GitHub org membership check failed', details)
    return res
      .status(403)
      .type('text/plain')
      .send(
        [
          'GitHub org membership required.',
          '',
          `User: ${details.user ?? 'unknown'}`,
          `Required org: ${details.org}`,
          `GitHub membership API status: ${details.membershipStatus}`,
          `GitHub membership state: ${details.membershipState ?? 'none'}`,
          `GitHub message: ${details.githubMessage ?? 'none'}`,
          `Accepted scopes: ${details.acceptedScopes ?? 'none'}`,
          `OAuth scopes: ${details.oauthScopes ?? 'none'}`,
        ].join('\n'),
      )
  }

  const session = encodeSession({ login: user.login, avatarUrl: user.avatar_url, org: config.org, iat: Date.now() })
  res.setHeader('Set-Cookie', [
    cookie.serialize('claw_session', session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicUrl.startsWith('https://'),
      path: '/',
      maxAge: 60 * 60 * 8,
    }),
    cookie.serialize('claw_oauth_state', '', { path: '/', maxAge: 0 }),
  ])
  res.redirect('/')
})

app.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', cookie.serialize('claw_session', '', { path: '/', maxAge: 0 }))
  res.json({ ok: true })
})

async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

app.get('/api/status', requireAuth, async (req, res) => {
  const [bridge, services, usage] = await Promise.all([readBridge(), readServices(), readUsage()])
  res.json({
    generatedAt: new Date().toISOString(),
    user: req.user,
    auth: { org: config.org },
    bridge,
    services,
    usage,
  })
})

app.use(redirectToLogin)

if (process.env.NODE_ENV === 'production') {
  app.use(express.static('dist/client'))
  app.get('*splat', (_req, res) => res.sendFile(path.resolve('dist/client/index.html')))
}

async function sqliteJson(sql) {
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', config.bridgeDb, sql], { timeout: 5000 })
    return stdout.trim() ? JSON.parse(stdout) : []
  } catch (error) {
    return { error: String(error.stderr || error.message || error) }
  }
}

async function readBridge() {
  const [counts, recent, worklog] = await Promise.all([
    sqliteJson("select status, count(*) as count from jobs group by status order by status;"),
    sqliteJson(
      "select id, repo, thread, status, action, decision, trigger_actor, subject, attempts, coalesced_count, last_error, created_at, updated_at, started_at, finished_at from jobs order by datetime(updated_at) desc limit 20;",
    ),
    sqliteJson(
      "select id, ts, job_id, phase, summary from worklog order by datetime(ts) desc limit 24;",
    ),
  ])
  const errors = {}
  if (!Array.isArray(counts)) errors.counts = counts.error ?? 'Unable to read queue counts'
  if (!Array.isArray(recent)) errors.recent = recent.error ?? 'Unable to read recent jobs'
  if (!Array.isArray(worklog)) errors.worklog = worklog.error ?? 'Unable to read worklog'
  return {
    counts: Array.isArray(counts) ? counts : [],
    recent: Array.isArray(recent) ? recent : [],
    worklog: Array.isArray(worklog) ? worklog : [],
    errors,
    db: config.bridgeDb,
  }
}

async function readServices() {
  const names = [
    ['bridgeExecutor', ['--user', 'show', 'waylon-github-agent-bridge.service', '--property=ActiveState,SubState,Result,ExecMainPID,NRestarts']],
    ['bridgeReaderTimer', ['--user', 'show', 'waylon-github-agent-bridge-reader.timer', '--property=ActiveState,SubState,Result,NextElapseUSecRealtime']],
    ['nginx', ['show', 'nginx.service', '--property=ActiveState,SubState,Result,ExecMainPID,NRestarts']],
  ]
  const entries = await Promise.all(names.map(async ([name, args]) => [name, await systemctl(args)]))
  return Object.fromEntries(entries)
}

async function systemctl(args) {
  try {
    const { stdout } = await execFileAsync('systemctl', args, { timeout: 5000 })
    return Object.fromEntries(
      stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    )
  } catch (error) {
    return { error: String(error.stderr || error.message || error) }
  }
}

async function readUsage() {
  const [main, codex] = await Promise.all([scanJsonlDir(config.sessionsDir), scanJsonlDir(config.codexSessionsDir)])
  return { main, codex, note: 'Usage is computed from local session JSONL files and may lag live provider quota.' }
}

async function scanJsonlDir(root) {
  const files = await collectJsonl(root, 350)
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let cost = 0
  let events = 0
  const byDay = new Map()

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8').catch(() => '')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const usage = event.usage ?? event.message?.usage ?? event.payload?.usage
      if (!usage) continue
      const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0)
      const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0)
      const cached = Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0)
      const total = Number(usage.total_tokens ?? usage.totalTokens ?? input + output)
      const usageCost = Number(usage.cost ?? usage.total_cost ?? usage.totalCost ?? 0)
      inputTokens += input
      outputTokens += output
      cachedInputTokens += cached
      totalTokens += total
      cost += usageCost
      events += 1
      const ts = event.timestamp ?? event.ts ?? event.created_at
      const day = typeof ts === 'string' ? ts.slice(0, 10) : 'unknown'
      byDay.set(day, (byDay.get(day) ?? 0) + total)
    }
  }

  return {
    root,
    files: files.length,
    events,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    cost,
    byDay: [...byDay.entries()].sort().slice(-14).map(([day, tokens]) => ({ day, tokens })),
  }
}

async function collectJsonl(root, limit) {
  const found = []
  async function walk(dir) {
    if (found.length >= limit) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full)
      if (found.length >= limit) break
    }
  }
  await walk(root)
  return found
}

app.listen(config.port, config.host, () => {
  console.log(`claw-dashboard listening on http://${config.host}:${config.port}`)
})

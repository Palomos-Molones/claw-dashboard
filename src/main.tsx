import * as React from 'react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, AlertTriangle, CheckCircle2, Clock3, Github, LogOut, RefreshCw, Server, Zap } from 'lucide-react'
import './styles.css'

type JobCount = { status: string; count: number }
type Job = {
  id: number
  repo: string | null
  thread: number | null
  status: string
  action: string
  decision: string
  trigger_actor: string | null
  subject: string
  attempts: number
  coalesced_count: number
  last_error: string | null
  updated_at: string
}
type Worklog = { id: number; ts: string; job_id: number | null; phase: string; summary: string }
type UsageBucket = { day: string; tokens: number }
type UsageSource = {
  files: number
  events: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
  cost: number
  byDay: UsageBucket[]
}
type DashboardData = {
  generatedAt: string
  user: { login: string; avatarUrl?: string }
  bridge: { counts: JobCount[]; recent: Job[]; worklog: Worklog[]; errors?: Record<string, string> }
  services: Record<string, Record<string, string>>
  usage: { main: UsageSource; codex: UsageSource; note: string }
}

function App() {
  const { data, loading, error, reload } = useDashboard()

  if (error === 'auth_required') return <Login />
  if (!data) {
    return (
      <main className="shell center">
        <div className="pulse-mark" />
        <p>{loading ? 'Loading dashboard' : 'Dashboard unavailable'}</p>
      </main>
    )
  }

  const bridgeCounts = Array.isArray(data.bridge.counts) ? data.bridge.counts : []
  const recentJobs = Array.isArray(data.bridge.recent) ? data.bridge.recent : []
  const worklog = Array.isArray(data.bridge.worklog) ? data.bridge.worklog : []
  const counts = Object.fromEntries(bridgeCounts.map((item) => [item.status, item.count]))
  const queued = (counts.pending ?? 0) + (counts.waiting_approval ?? 0)
  const errored = (counts.blocked ?? 0) + (counts.denied ?? 0)
  const totalTokens = data.usage.main.totalTokens + data.usage.codex.totalTokens
  const servicesOk = Object.values(data.services).filter((service) => service.ActiveState === 'active').length

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">dashboard.claw.sassu.es</p>
          <h1>Claw control room</h1>
        </div>
        <div className="top-actions">
          <span className="user-pill">
            {data.user.avatarUrl ? <img src={data.user.avatarUrl} alt="" /> : <Github size={18} />}
            {data.user.login}
          </span>
          <button onClick={reload} aria-label="Refresh dashboard" title="Refresh dashboard">
            <RefreshCw size={18} />
          </button>
          <button onClick={logout} aria-label="Log out" title="Log out">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="signal-grid">
        <Metric icon={<Activity />} label="Running" value={counts.running ?? 0} tone="cyan" />
        <Metric icon={<Clock3 />} label="Queued" value={queued} tone="amber" />
        <Metric icon={<CheckCircle2 />} label="Done" value={counts.done ?? 0} tone="green" />
        <Metric icon={<AlertTriangle />} label="Errors / denied" value={errored} tone={errored ? 'red' : 'green'} />
        <Metric icon={<Server />} label="Services active" value={`${servicesOk}/${Object.keys(data.services).length}`} tone="cyan" />
        <Metric icon={<Zap />} label="Observed tokens" value={formatNumber(totalTokens)} tone="violet" />
      </section>

      <section className="split">
        <Panel title="Services">
          <div className="service-list">
            {Object.entries(data.services).map(([name, service]) => (
              <div className="service-row" key={name}>
                <span className={`dot ${service.ActiveState === 'active' ? 'ok' : 'bad'}`} />
                <div>
                  <strong>{name}</strong>
                  <small>{service.ActiveState ?? 'unknown'} / {service.SubState ?? 'unknown'}</small>
                </div>
                <code>{service.ExecMainPID || service.NextElapseUSecRealtime || service.Result || 'n/a'}</code>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Token telemetry">
          <div className="usage-bars">
            <UsageLine label="OpenClaw sessions" usage={data.usage.main} />
            <UsageLine label="Codex rollouts" usage={data.usage.codex} />
          </div>
          <Sparkline buckets={[...data.usage.main.byDay, ...data.usage.codex.byDay]} />
          <p className="muted">{data.usage.note}</p>
        </Panel>
      </section>

      <section className="table-section">
        <Panel title="Recent bridge jobs">
          <BridgeErrors errors={data.bridge.errors} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Actor</th>
                  <th>Repo</th>
                  <th>Action</th>
                  <th>Subject</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {recentJobs.map((job) => (
                  <tr key={job.id}>
                    <td>#{job.id}</td>
                    <td><Badge status={job.status} /></td>
                    <td>{job.trigger_actor ?? '-'}</td>
                    <td>{job.repo ?? '-'}</td>
                    <td>{job.action}</td>
                    <td>{job.subject}</td>
                    <td>{relative(job.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      <section className="table-section">
        <Panel title="Latest worklog">
          <div className="log-list">
            {worklog.map((item) => (
              <div className="log-row" key={item.id}>
                <code>{item.phase}</code>
                <span>{item.summary}</span>
                <small>{relative(item.ts)}</small>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <footer>Last refresh {new Date(data.generatedAt).toLocaleString()}</footer>
    </main>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="shell center">
        <div className="login-panel">
          <AlertTriangle size={34} />
          <h1>Dashboard render error</h1>
          <p>{this.state.error.message}</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      </main>
    )
  }
}

function BridgeErrors({ errors }: { errors?: Record<string, string> }) {
  const entries = Object.entries(errors ?? {})
  if (!entries.length) return null
  return (
    <div className="error-list">
      {entries.map(([name, message]) => (
        <p key={name}><strong>{name}</strong>: {message}</p>
      ))}
    </div>
  )
}

function Login() {
  return (
    <main className="shell center">
      <div className="login-panel">
        <Github size={34} />
        <h1>Claw Dashboard</h1>
        <p>Access is limited to active members of the Palomos-Molones GitHub organization.</p>
        <a className="login-button" href="/auth/login">Sign in with GitHub</a>
      </div>
    </main>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function Metric({ icon, label, value, tone }: { icon: React.ReactElement; label: string; value: string | number; tone: string }) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>
}

function UsageLine({ label, usage }: { label: string; usage: UsageSource }) {
  return (
    <div className="usage-line">
      <span>{label}</span>
      <strong>{formatNumber(usage.totalTokens)}</strong>
      <small>{usage.events} usage events, {usage.files} files</small>
    </div>
  )
}

function Sparkline({ buckets }: { buckets: UsageBucket[] }) {
  const compact = new Map<string, number>()
  for (const bucket of buckets) compact.set(bucket.day, (compact.get(bucket.day) ?? 0) + bucket.tokens)
  const values = [...compact.values()].slice(-14)
  const max = Math.max(...values, 1)
  return (
    <div className="sparkline" aria-label="Token usage by day">
      {values.map((value, index) => <span key={index} style={{ height: `${Math.max(8, (value / max) * 100)}%` }} />)}
    </div>
  )
}

function useDashboard() {
  const [data, setData] = React.useState<DashboardData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    setLoading(true)
    const response = await fetch('/api/status')
    if (response.status === 401) {
      setError('auth_required')
      setLoading(false)
      return
    }
    if (!response.ok) {
      setError('failed')
      setLoading(false)
      return
    }
    setData(await response.json())
    setError(null)
    setLoading(false)
  }, [])

  React.useEffect(() => {
    reload()
    const timer = window.setInterval(reload, 15000)
    return () => window.clearInterval(timer)
  }, [reload])

  return { data, loading, error, reload }
}

async function logout() {
  await fetch('/logout', { method: 'POST' })
  window.location.href = '/'
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en', { notation: value > 999999 ? 'compact' : 'standard' }).format(value)
}

function relative(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleDateString()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

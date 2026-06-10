# Claw Dashboard

Operational dashboard for the OpenClaw host and the GitHub agent bridge.

## What It Shows

- GitHub agent bridge queue counts: running, pending, done, blocked and denied.
- Recent bridge jobs and worklog events from the local SQLite queue.
- Systemd state for the bridge executor, reader timer and nginx.
- Observed token usage from local OpenClaw and Codex session JSONL files.
- Host resource telemetry: CPU, memory, disk and network throughput.

## Auth

Access is gated through GitHub sign-in and only active members of the `Palomos-Molones` organization are allowed in.

This is designed to use a GitHub App owned by the organization. The app needs OAuth enabled:

- Homepage URL: `https://dashboard.claw.sassu.es`
- Callback URL: `https://dashboard.claw.sassu.es/auth/github/callback`
- Webhook: inactive
- Permissions: read-only organization metadata/members where GitHub asks for it

Runtime environment:

```bash
PUBLIC_URL=https://dashboard.claw.sassu.es
GITHUB_ORG=Palomos-Molones
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
SESSION_SECRET=...
PORT=3777
HOST=127.0.0.1
```

## Local Development

```bash
npm install
AUTH_BYPASS=1 npm run dev
```

## Production

```bash
npm ci
npm run build
npm start
```

The included deploy files assume the Node server listens on `127.0.0.1:3777` and nginx terminates HTTPS for `dashboard.claw.sassu.es`.

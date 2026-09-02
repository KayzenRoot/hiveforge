# HiveForge V0.1 setup

## Requirements

- Node.js 22 or newer. Node 26 is supported and provides the built-in `node:sqlite` runtime used by this MVP.
- Git on `PATH`.
- Codex CLI on `PATH` for real runs. The dashboard still boots when Codex is absent and reports `NOT_CONFIGURED`.

## Local run

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. Register an existing local Git repository. The default database is `data/hiveforge.sqlite`; set `HIVEFORGE_DB_PATH` to override it.

Start the separate mailbox worker in another terminal:

```powershell
npm run worker
```

The worker watches each registered project's `reviewMailboxPath`. Only top-level `.json` files are consumed. Processed files move to `.processed`; invalid files move to `.rejected`.

## Validation commands

```powershell
npm test
npm run test:e2e
npm run lint
npm run typecheck
npm run build
```

## Review contract

See `docs/RCP-EXAMPLE.json`. A valid contract must include project, run, work order, base SHA and head SHA. Evidence Lock rejects a review whose Git identity does not match the captured run evidence.

## Environment notes

No secret, cookie or raw authentication token is stored by HiveForge. The Codex adapter asks App Server for auth status with `includeToken: false` when a real process is started.

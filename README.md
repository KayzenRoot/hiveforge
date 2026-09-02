# HiveForge

HiveForge is a local-first closed-loop control room for Codex work. The V0.1 MVP combines a SQLite-backed run state machine, deterministic Git evidence, review contracts, a mailbox-driven next dispatch, and a small operator dashboard.

## Status

This repository is an active MVP and engineering baseline. It is not production-ready. The current implementation is intentionally local-first and keeps the Codex integration behind an adapter boundary.

## Quick start

Requirements: Node.js 22 or newer and npm.

```powershell
npm ci
npm run dev
```

Open `http://localhost:3000`. Run the worker in a second terminal when you want mailbox-driven orchestration:

```powershell
npm run worker
```

## Validation

```powershell
npm test
npm run test:e2e
npm run lint
npm run typecheck
npm run build
```

The same configured validation commands run in GitHub Actions. The canonical local review artifact is generated with:

```powershell
.\scripts\create-review-zip.ps1
```

The generated ZIP stays local and ignored under `review/`; it is never committed or published.

## Documentation

- [Setup and operations](docs/SETUP.md)
- [Versioning and releases](docs/VERSIONING-AND-RELEASES.md)
- [GitHub governance](docs/HIVEFORGE-GITHUB-GOVERNANCE-V0.1.md)
- [Review ZIP](docs/REVIEW-ZIP.md)
- [MVP source and limitations](docs/HIVEFORGE-MASTER-SOURCE-V0.1.md)
- [Changelog](CHANGELOG.md)

## Contribution

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Changes use Conventional Commits and the normal development branch pattern `work/<work-order-id>-<short-slug>`.

## Security

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Never commit credentials, `.env` files, local databases, generated build output, or review ZIPs.

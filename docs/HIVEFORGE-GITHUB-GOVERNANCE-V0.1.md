# HiveForge GitHub governance V0.1

This document records the operating baseline established for the V0.1 MVP. It complements repository settings, which remain authoritative for enforcement.

## Repository

- Canonical remote: `https://github.com/KayzenRoot/hiveforge.git`
- Default branch: `main`
- MVP status: active, local-first, not production-ready
- Review ZIP: local-only, ignored, never committed or published

## Branches and commits

The approved bootstrap may land directly on an empty `main`. All later changes use `work/<work-order-id>-<short-slug>` and a pull request. Commit messages use Conventional Commits. A pull request must carry validation results, risk/rollback notes, and security/data handling confirmation.

## Required validation

The CI workflow runs `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` on pushes to `main` and work branches and on pull requests targeting `main`. A configured command failing blocks acceptance.

## Protection and permissions

The bootstrap executor attempts to configure `main` protection using the authenticated GitHub CLI/API. If repository permissions or plan capabilities prevent a rule, the exact limitation is recorded in the execution checkpoint and must be resolved before treating enforcement as complete. The intended baseline is required CI, pull-request review after bootstrap, and no force-push or deletion of `main`.

## Secrets and evidence

Credentials, `.env` files, local databases, build output, and review ZIPs are excluded from Git. The finalizer performs a candidate-path secret check before staging. The Review ZIP captures status, commit and remote evidence, validation output, and publication metadata without including the ZIP itself.

## Releases

Only monotonic `v0.1.0-alpha.N` prereleases are automated. Stable `v0.1.0`, auto-merge, and production deployment are explicitly out of scope.

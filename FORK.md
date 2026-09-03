# Fork modifications

This fork of [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon)
(upstream commit
[`e92ee61c05ec6ee91b05fb99499869a8ec77abe1](https://github.com/KeygraphHQ/shannon/commit/e92ee61c05ec6ee91b05fb99499869a8ec77abe1))
exists to serve as the scan engine of the Corvus security-assessment SaaS.
It is published in full, under the same AGPL-3.0-only license as upstream,
with all modifications visible in the git history on top of the pinned
upstream commit.

Every section below is added in the same commit as the change it describes.
Changes made directly by this fork (as opposed to files inherited verbatim
from upstream) carry an added copyright line:

```
Copyright (C) 2026 Corvus contributors
```

upstream's own headers and notices are left in place above it.

## 1 — Fork scaffolding

- `README.md`: fork banner (upstream credit, pinned upstream commit, AGPL
  statement, honest egress-posture note, pointer to this file).
- `FORK.md`: this file.
- `.github/workflows/ci.yml`: pull-request/push CI for the fork — pnpm +
  Node 24, `pnpm install --frozen-lockfile`, `pnpm build` (turbo), `pnpm check`
  (tsc --noEmit per package), `biome check .`, and a gitleaks secret scan.
  Upstream has release workflows only (manual `workflow_dispatch`); they are
  inherited unchanged and are inert without upstream's publishing secrets.

### Secret scanning, honestly

The gitleaks job runs the **default ruleset with no allowlist** — every path
the fork authors is scanned at full force. Two facts make that work with
upstream's history in place:

1. Upstream's sample reports, benchmark SARIF, and historical README
   examples contain **exploitation evidence from deliberately vulnerable
   demo applications** (captured demo JWTs, `deluxeToken`/`stolenToken`
   values from Juice Shop and crAPI scans, a demo TOTP secret in the
   initial commit). That is what pentest evidence looks like, and gitleaks
   correctly pattern-matches it. These are upstream's published artifacts,
   not contributor secrets.
2. gitleaks-action scans only the commits a push delivers. This fork was
   seeded by pushing upstream's history to the `upstream-base` branch first
   (no CI workflow there) and then pushing `main` on top, so the initial
   secret scan covered only the fork's own first commit. Every later push
   scans only fork commits.

Consequence, as a standing rule for this fork: **fork changes never edit
`sample-reports/`, `benchmark/`, or upstream's demo-config examples** — doing
so would put the inherited evidence lines into a scanned diff. If that ever
becomes necessary, the right answer is to rethink, not to add an allowlist.

## 2 — Deployment seams (pulled ahead of the larger engine changes)

Small changes needed to run a second Shannon stack on a host that already
runs another Temporal deployment:

- `docker-compose.yml`: the temporal service's published host gRPC port is
  remapped `127.0.0.1:7234:7233` (upstream publishes 7233; the host's 7233
  serves the other deployment). In-network addresses — the worker container
  reaching `shannon-temporal:7233` — are unchanged.
- `apps/cli/src/temporal-client.ts`: the CLI's Temporal address is read from
  `TEMPORAL_ADDRESS` (default unchanged: `127.0.0.1:7233`). Read lazily at
  connection time, because local mode loads `./.env` after module evaluation.
- `apps/cli/src/index.ts`: `SHANNON_ALLOW_ROOT=1` opts in to running the CLI
  as root/sudo for deployments where a root service (a container-hosted
  worker) spawns it. Upstream's refusal — bind-mounted files come back owned
  by root — stays the default, and the trade-off is the operator's.
- `apps/cli/src/docker.ts`: container queries use the `{{.Label "k"}}`
  template accessor instead of `{{ index .Labels "k" }}`. Docker 29's
  `docker ps` template context exposes `.Labels` as a slice, so upstream's
  `index` form errors on every query (`stop`, `stop --all`, and the
  workspace-resolution fallbacks all failed as "Could not inspect running
  scan workers"). Verified live: `stop --all` works against this engine now.
- `.env.example`: documents both env additions.


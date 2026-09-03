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
  Container side: `entrypoint.sh` runs the worker as root directly when the
  remap carries UID 0 — `groupadd`/`useradd` cannot create a second
  UID/GID 0, and under `set -e` the remap path aborted the container at
  startup (observed exit code 4).
- `apps/cli/src/docker.ts`: container queries use the `{{.Label "k"}}`
  template accessor instead of `{{ index .Labels "k" }}`. Docker 29's
  `docker ps` template context exposes `.Labels` as a slice, so upstream's
  `index` form errors on every query (`stop`, `stop --all`, and the
  workspace-resolution fallbacks all failed as "Could not inspect running
  scan workers"). Verified live: `stop --all` works against this engine now.
- `.env.example`: documents both env additions.

## 3 — DAST (remote-only) scan mode

The engine change. Upstream requires `-r/--repo` and writes every analysis
prompt around jailed source ("Code is Ground Truth"). This fork adds a
black-box mode for targets whose source is not available.

- **Selection:** `shannon start -u <url>` without `-r` runs DAST; `-r` keeps
  deep (white-box) mode. The CLI materializes a synthetic, empty source root
  (`<workspace>/source`, mounted at `/repos/target-source`) so every
  path-based contract downstream keeps its shape, and passes `--mode dast`
  to the worker container. `--mode <deep|dast>` is a visible worker flag
  (`apps/worker/src/temporal/worker.ts`). Enabling agentic SAST or feeding
  SAST SARIF in DAST mode is a configuration error, rejected before any
  agent runs.
- **Pipeline shape in DAST:** the pre-recon code phase is skipped (there is
  no code to analyze); recon runs first and produces the architecture
  intelligence from live behavior; the five class lanes run concurrently
  exactly as in deep mode; reconciliation, task formation, exploitation,
  and reporting are unchanged.
- **Prompt set:** `apps/worker/prompts/dast/` — 19 prompt variants plus one
  shared include. Selection reuses the same one-ternary mechanism
  `pipelineTestingMode` already has in
  `apps/worker/src/services/prompt-manager.ts` (`targetMode === 'dast'` →
  `prompts/dast/`); pipeline-testing keeps precedence. `@include` files
  resolve dast-dir first, then fall back to the base prompts dir, so a dast
  prompt can reuse upstream shared includes verbatim while
  `dast/shared/exploitation/_task-formation-procedure.txt` overrides its
  base namesake.
- **Fail-loud, no silent fallback:** a prompt that has no dast variant
  throws (`Prompt file not found`) instead of silently loading the
  white-box prompt. Deliberate: a forgotten variant must be loud, never a
  silent mode confusion. Upstream's pipeline-testing directory set the
  precedent — a complete mirror — and DAST follows it for every reachable
  prompt.
- **Prompts with no dast variant, on purpose:** `task-formation-miscellaneous`
  (the miscellaneous queue is seeded canonically empty in DAST — no static
  analysis ran — so reconciliation sees fewer than two observations and the
  model is never invoked), `sast-enrichment-*` (enrichment short-circuits
  when no SARIF was fed: zero model calls), and `pre-recon-code` (phase
  skipped). `exploit-miscellaneous` is unreachable for the same empty-queue
  reason but ships a variant anyway — one cheap file that degrades
  gracefully if that reachability analysis is ever wrong.
- **Ground-truth inversion:** the white-box prompts treat source code as
  ground truth; the dast variants treat observed behavior, rendered output,
  and observed access decisions as ground truth. Every variant carries a
  black-box engagement guard (the repository directory is an empty
  placeholder; do not read, search, or analyze source files) and omits
  `code_locations` entirely rather than letting a model fabricate them.
  Queue field names are kept verbatim so downstream exploit and
  task-formation references stay valid — with behavioral semantics for the
  code-location fields (`vulnerable_code_location` becomes "the observation
  that evidences the flaw", and inferred sinks are labeled as inferred).
- **In-band evidence discipline:** upstream's miscellaneous lane already
  constrained out-of-band callbacks ("standing up out-of-band callbacks or
  attacker-controlled infrastructure falls outside [scope]... record it as
  a real but `blocked` finding"), yet its base SSRF exploit prompt
  recommends Burp Collaborator / Interactsh / attacker.com for validation.
  In DAST the fork extends the in-band-only discipline to SSRF: internal
  service access, cloud metadata retrieval, and port scans remain provable
  in-band (the target performs the outbound request and its response or
  side effect surfaces through the application's own response); a purely
  blind sink with no in-band signal is recorded `blocked` — an external
  operational constraint — never `exploited` or `false_positive`. One
  upstream line is kept verbatim: the RFI witness example
  `http://attacker.com/shell.txt` in `vuln-injection`, which sits in a
  hold-for-the-exploit-phase witness list, explicitly not executed during
  analysis.
- **Task-formation seam:** `targetMode` is plumbed through the workflow →
  `formClassExploitTasks` activity → `form.ts`'s `loadClassPolicy`, so
  observation grouping loads the black-box class policy in DAST runs.
- **Testability exports:** `parseCliArgs` (worker) and `parseStartArgs`
  (CLI) are exported, and `apps/cli/src/index.ts` gained a standard entry
  guard — upstream's `main()` ran unconditionally at import, making the
  module import-unsafe. The guard mirrors the worker's existing one.
- **Test rig:** vitest at the workspace root (`pnpm test`), covering the
  fork's seams only — DAST prompt selection, include fallback/override
  ordering, pipeline-testing precedence, fail-loud missing variants, and
  `--mode`/optional-`-r` parsing. Upstream has no test infrastructure; the
  rig does not pretend to cover the pipeline itself. CI runs it between
  typecheck and lint.



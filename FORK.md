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
- **Verified end-to-end** against a deliberate local target (a throwaway
  smoke server), through an OpenRouter gateway serving a model Pi's
  catalogue does not know: recon passed, all five class lanes ran,
  reconciliation/exploitation/reporting completed, and the engine
  exploited a real, unplanted bug in the target — an unauthenticated
  `GET //` that crashed the server process — reporting it as
  `status: exploited` with full proof of impact. The same run exercised
  the resume seam (7 completed agents skipped, the failed class retried,
  reporting finished) and produced `report.json`/SARIF/PDF.

## 4 — Gateway pass-through model limits

A run through an OpenAI-compatible gateway names a model id the Pi catalogue
never measured (`SHANNON_AI_MODEL=openai:<gateway-id>` +
`SHANNON_AI_BASE_URL`). Pi's resolver serves such an id on a descriptor
borrowed from the provider's first catalogue model — shape only. The borrow
used to carry the reference's `contextWindow`/`maxTokens` too, and Pi clamps
every request's output budget to `contextWindow − context − 4096`
(pi-ai `clampMaxTokensToContext`), flooring Responses requests at 16 tokens.
A gateway run whose reference carried an 8192-token window therefore asked
the model for **16 output tokens on every turn**: the model died mid-sentence
on turn one with no room for a tool call, every agent ended with empty text,
and the pipeline failed output validation on every retry — with nothing on
the wire to say so. This is the failure class the Corvus memory already
calls the reasoning-model max_tokens trap.

The fix (`apps/worker/src/ai/models.ts::resolveModel` pass-through branch):
a gateway pass-through now advertises fork defaults
(`SHANNON_AI_CONTEXT_WINDOW=200000`, `SHANNON_AI_MAX_TOKENS=32768`, env
overridable, garbage rejected loudly). Rationale: a gateway id names a model
the catalogue never measured; the serving endpoint enforces the real limit,
so the fork advertises generous headroom and the clamp stops being the
bottleneck. Catalogue models keep their own measured limits untouched, and
`apps/cli/src/env.ts` forwards both variables into the scan container.
Verified on the wire against OpenRouter serving `z-ai/glm-5.3`:
`max_output_tokens: 32768` and a recon agent completing 28 turns with real
tool calls where the pre-fix run emitted 16 tokens and stopped.

Honest caveat found while proving it, **since resolved** (see §5):
`SHANNON_AI_OPENAI_FORMAT` used to be honored only on Pi's direct pi-ai
path, not on the agent path this engine uses. Root cause, established by
probing the real built worker against a mock gateway: when no models.json
overlay and no extension exists for a provider, Pi's `ModelRuntime` installs
the builtin provider **untouched**, whose single stream implementation
serves the Responses API for every `openai` model — the descriptor's
`api: "openai-completions"` is carried but never consulted. With an overlay
present, `composeModelProvider`'s dispatch honors per-model `api` (a
completions-tagged model with no completions-tagged builtin falls through
to pi-ai's registered `openai-completions` implementation, the real
chat-completions wire). Verified on the wire: the same run reaches
`POST /v1/chat/completions` with the overlay and `POST /v1/responses`
without it. The fork now writes that overlay itself (§5); the format
variable is authoritative for chat-completions gateway runs.

## 5 — Per-stage model routing and output budgets

Upstream runs the whole pipeline on one model
(`SHANNON_AI_MODEL=<provider>:<model-id>`). Real scans want a chain: a cheap
fast model for recon, a strong one for exploitation, a mid one for report
writing. This fork adds stage-scoped overrides — and, while making the
format variable authoritative (below), the models.json mechanism that keeps
gateway runs on the right wire.

- **Routing chain** (`apps/worker/src/ai/models.ts`):
  `SHANNON_AI_MODEL_<STAGE>` → `SHANNON_AI_MODEL` → fork default. A *stage*
  is an agent name (`recon`, `injection-vuln`, `xss-vuln`, `auth-vuln`,
  `authz-vuln`, `ssrf-vuln`, `injection-exploit`, `xss-exploit`,
  `auth-exploit`, `ssrf-exploit`, `authz-exploit`, `miscellaneous-exploit`,
  `report`, `pre-recon`, `validate-authentication`) or a model role
  (`small`/`medium`/`large` — the structured-generation, task-formation,
  and Capella seams that select by role rather than by agent). The suffix
  is the stage name upper-cased with non-alphanumeric runs folded to `_`
  (`injection-vuln` → `SHANNON_AI_MODEL_INJECTION_VULN`). The seam is the
  one pi-executor already had: it now passes the agent's name to
  `resolveModelSelection(stage)`. Sub-agents (`task` tool) inherit their
  parent's selection, as upstream.
- **Per-stage output budgets:** `SHANNON_AI_MAX_TOKENS_<STAGE>` caps the
  output headroom one stage asks for (cheap stages capped, reasoning-heavy
  stages widened) without touching other stages. It replaces the
  descriptor's advertised ceiling for that stage only; the serving endpoint
  still enforces the model's real limit and Pi still clamps to the context
  window.
- **Fail-loud near-miss rule:** a `SHANNON_AI_MODEL_<...>` variable carrying
  a value must parse (`<provider>:<model-id>`, the offending key named in
  the error) and its suffix must be upper-case (`SHANNON_AI_MODEL_recon`
  and `SHANNON_AI_MODEL_` both fail with guidance). A typo'd stage must
  never quietly route nothing. Unknown stage *names* are permissive —
  preflight warns against the known set (all agents plus
  `validate-authentication` and the three roles) because a name this
  version doesn't know may be real in a future one; preflight also resolves
  **every** stage override against the registry before the credential
  probe, so a wrong model id fails in seconds as a config error instead of
  mid-pipeline as a retried agent failure.
- **ModelHost cache is per role** (`apps/worker/src/ai/model-host.ts`):
  upstream cached one selection process-wide because every role resolved the
  same run-wide model; with role overrides in play the cache is keyed by
  role, or the first role to resolve would decide for all. A rejected
  selection clears its own entry so a retried activity resolves again.
- **Gateway models.json materialization**
  (`materializeGatewayModelsJson`): when the run (base or any stage) uses
  the `openai` provider through a gateway in `chat-completions` format, the
  worker writes Pi's `models.json` overlay — `<agent-dir>/models.json` —
  declaring each such model with its `api`, the fork's gateway limits, and
  the gateway `baseUrl`. This is the §4-caveat fix: the overlay switches
  ModelRuntime from the builtin-untouched path to the composed path that
  honors per-model `api`. Declaring the model also means resolution finds
  it in the catalogue instead of borrowing a reference descriptor, and its
  cost is honestly zero rather than the reference's rates (a gateway id has
  no catalogue-measured pricing; the serving provider's own usage figures
  are the real source — per-model price overrides are future work). An
  operator-written `models.json` is left untouched (their composition wins;
  the format variable is then advisory); `responses` format and non-openai
  runs are untouched (the builtin path already serves them faithfully);
  the write is atomic (temp + rename) for concurrent lane activities. Scan
  containers are fresh per scan, so "file exists ⇒ an operator wrote it"
  holds in production.
- **workflow.log routing record:** the log had no model field, so a run
  with per-stage routing could not show which model a stage actually used.
  Each agent attempt now emits one line before its first turn —
  `[2026-09-04 12:00:00] [recon] model: openai:z-ai/glm-5.3` — in the
  combined log and the agent's own file, with the same fail-closed safety
  as other trace lines (a spec containing control characters or failing
  the label charset is dropped, never written).
- **CLI forwarding** (`apps/cli/src/env.ts`, `model-spec.ts`): every
  well-formed `SHANNON_AI_MODEL_<STAGE>` / `SHANNON_AI_MAX_TOKENS_<STAGE>`
  variable is forwarded into the scan container (by name, values stay out
  of the `docker run` argv), the container receives credentials for the
  union of providers the base and stage models select, and
  `validateCredentials` parses every stage override before any Docker work.
  The one-provider rule gained its stage-routing exception: a second
  configured provider is legitimate when a stage override names it; one no
  model variable references is still the ambiguity upstream rejected.
- **Tests:** `apps/worker/tests/stage-model-routing.test.ts` — the fallback
  chain, near-miss failures, stage budgets (cap, isolation, garbage), the
  real-runtime routing of two distinct catalogue models, the per-role host
  cache and its rejection clearing, the materialization document shape,
  operator-file precedence, non-openai/responses/no-gateway skips, and the
  `model:` trace line (recorded, fanned out, forged-spec dropped).
- **Proved live** (2026-09-04, `--pipeline-testing` DAST run, 5m17s,
  terminal `completed`): base `openai:z-ai/glm-5.3-flash`,
  `SHANNON_AI_MODEL_RECON` and `SHANNON_AI_MODEL_REPORT` on
  `openai:z-ai/glm-5.3`. workflow.log shows every stage on its routed
  model (`[recon]`/`[report]` on glm-5.3, the five lanes on the flash
  base), the scan container's materialized models.json declares both ids
  with `api: openai-completions`, and the blessed report.json carries
  `report_meta.model: z-ai/glm-5.3` — the routed model in the artifact
  itself.

## 6 — Pipeline-testing report stub repair

Found while proving §5 live. Upstream's
`apps/worker/prompts/pipeline-testing/report-executive.txt` stub told the
report agent only to prepend the title to the assembled markdown — it never
instructed `set-report-meta`, so the canonical report carried an empty
`executive_summary` and every fresh-workspace pipeline-testing run died at
the finalization integrity wall (`finalization-report-meta-malformed`,
report.json unblest, terminal `failed`). The failure was structural, not
model-dependent: identical on `z-ai/glm-5.3-flash` and `z-ai/glm-5.3`,
both following the stub to the letter. The stub now invokes
`set-report-meta` with the prompt's own interpolations (`{{WEB_URL}}`,
`{{ASSESSMENT_DATE}}`); the workflow keeps deterministic ownership of the
date and the scope afterwards (`activities.ts` rewrites both when reading
the meta back), so the stub's only real contribution is the non-empty
summary. Prompt `.txt` files carry no license headers — their content is
interpolated into model context — so this modification is inventoried
here rather than in the file. Verified live: the same three-model
pipeline-testing run now reaches terminal `completed` with a blessed
report.json (§5's live bullet).



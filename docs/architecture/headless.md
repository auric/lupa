# Headless analysis entry point

Lupa exposes a CLI-driven entry point that runs a full PR analysis against an
arbitrary `(workspaceRoot, baseRef, headRef, modelProfile)` tuple without
opening the webview or chat participant. It is the substrate Quests 8.1 and 8.2
(eval harness and resolution-rate metric) build on, and — by construction — it
reuses the same `AnalysisEngine` pipeline the production UI paths use.

## Components

| Layer              | File                                           | Runs in                |
| ------------------ | ---------------------------------------------- | ---------------------- |
| CLI arg parser     | `scripts/eval/headlessArgs.js`                 | Node (launcher)        |
| Shared paths       | `scripts/eval/headlessPaths.js`                | Node (launcher/setup)  |
| Interactive setup  | `scripts/eval/setupHeadless.js`                | Node (launcher)        |
| Launcher           | `scripts/eval/launchHeadless.js`               | Node (launcher)        |
| In-host entry hook | `src/eval/headlessEntry.ts`                    | VS Code extension host |
| Programmatic API   | `src/extension.ts` → `LupaExtensionApi`        | VS Code extension host |
| Analysis entry     | `src/eval/headlessRunner.ts` → `runHeadless()` | VS Code extension host |
| Diff resolver      | `src/eval/diffResolver.ts`                     | VS Code extension host |

The launcher is plain Node. It parses CLI flags, ensures VS Code is cached
locally (via `@vscode/test-electron`'s `downloadAndUnzipVSCode`), then spawns
VS Code directly with both Lupa and `GitHub.copilot-chat` loaded as
development extensions. It passes the analysis options as env vars and waits
for the child to exit. Lupa's own `activate()` hook detects the headless
env contract and invokes `runHeadlessFromEnv`, which calls `runHeadless(...)`
(the thin wrapper defined in `src/eval/headlessRunner.ts`) and then issues
`workbench.action.quit` to close the spawned window.

```
CLI args ──► launchHeadless.js ──┐
                                 │ (spawns VS Code; env: LUPA_HEADLESS_*)
                                 ▼
                    ┌────────────────────────────┐
                    │  VS Code extension host    │
                    │                            │
                    │  extension.activate()      │
                    │        │                   │
                    │        ▼ (env detected)    │
                    │  runHeadlessFromEnv()      │
                    │        │                   │
                    │        ▼                   │
                    │  runHeadless(opts)         │
                    │        │                   │
                    │        ▼                   │
                    │  AnalysisEngine.analyze()  │◄── same seam the
                    │                            │    webview and chat
                    └────────────────────────────┘    participants use
```

Results flow back through two channels:

- Optional `--out` path receives the full `HeadlessAnalysisResult` JSON.
- A sentinel file at `.vscode-test/.lupa-headless-last.json` records the
  final exit code (and any error message). The launcher reads it after
  VS Code exits and propagates the exit code to the caller. A watchdog
  kills the child if it fails to quit within `--timeout + 60s`.

## Why the extension host (and not pure Node)

The only reason this is two processes instead of one is that **Copilot's
language-model client is not available outside the extension host**.

- `vscode.lm.selectChatModels(...)` — which `CopilotModelManager` wraps — is a
  VS Code API exposed only to extensions running in the extension host.
- GitHub Copilot has no public HTTP endpoint today that a third-party tool can
  call with a user token. Every Copilot-powered request, including the ones
  Lupa issues, is routed through the VS Code extension host and the Copilot
  extension's internal proxying.
- As a result, any tool that wants "Copilot-as-judge" semantics has to run
  inside the extension host, full stop. The VS Code team's own eval tooling,
  the built-in chat tests, and community eval harnesses all do the same.

`@vscode/test-electron` is used only for its `downloadAndUnzipVSCode`
helper, which caches a local copy of VS Code under `.vscode-test/vscode/`.
We then spawn that cached executable directly with
`--extensionDevelopmentPath` pointing at both Lupa and Copilot Chat; we do
**not** use the library's `runTests(...)` helper or `--extensionTestsPath`
(see "Why not `runTests`" below).

## Architectural reuse (no parallel code path)

`runHeadless()` must not grow its own prompt assembly, tool registration, or
post-analysis pipeline. It delegates to the shared seam:

1. Resolve the diff (`diffResolver.ts` — git ref pair or directory pair).
2. `DiffUtils.parseDiff(rawDiff)` — the same parser the other entries use.
3. `CopilotModelManager.selectModel({ identifier })` — same model picker.
4. `analysisEngine.analyze(input, { onProgress })` — the single shared call
   used by `AnalysisOrchestrator.analyzePR()` (webview) and
   `ChatParticipantService.runAnalysis()` (chat participant).

This invariant is enforced by `src/__tests__/headlessRunner.test.ts`, which
asserts that `headlessRunner.ts` never imports from `prompts/` or `tools/`,
never references the post-analysis pipeline directly, and always calls
`analysisEngine.analyze(...)`. It also pins the exact `AnalysisEngineInput`
key set, so any divergence from the production entries fails CI.

## CLI usage

```bash
npm run headless -- \
    --workspace /abs/path/to/repo \
    --base main \
    --head feature/x \
    --model copilot/gpt-4.1 \
    --seed 0 \
    --timeout 600000 \
    --out result.json \
    --silent
```

`--base` and `--head` accept three forms, resolved by `diffResolver.ts`:

- A git ref (`main`, `feature/x`, short or full SHA) — resolved via
  `git rev-parse` inside the workspace.
- `sha:<sha>` — explicit SHA form, useful when a branch name is ambiguous.
- `dir:<path>` — compare two directory snapshots instead of git refs. Used by
  Kind-A synthetic fixtures (Quest 8.1) that ship as plain directories, not
  git repos.

Exit codes: `0` on analysis completion regardless of finding count, `1` on
fatal runtime error (missing workspace, unknown model, unresolvable refs,
unhandled exception inside the host), `2` on CLI argument errors.

## First-time setup

The launcher spawns VS Code with its own user-data and extensions
directories, isolated from the user's regular install. Copilot Chat and
the associated GitHub authentication therefore have to be provisioned
inside that isolated profile once:

- `.vscode-test/lupa-headless-profile/` — persistent `--user-data-dir`
  (holds the GitHub OAuth session, Copilot entitlements, and Lupa's
  per-extension LM-access consent once granted).
- `.vscode-test/lupa-headless-extensions/` — persistent `--extensions-dir`
  (holds the installed `GitHub.copilot-chat` VSIX, from which the
  launcher resolves the extension folder path).

Both paths are gitignored under `.vscode-test/`, which also holds the
shared VS Code download cache used by the launcher and the setup script.

Run the one-time flow:

```bash
npm run headless:setup
```

This downloads VS Code into the cache, installs `GitHub.copilot-chat`
into the persistent extensions directory, and launches VS Code
interactively so the user can complete the "GitHub Copilot: Sign In"
flow. After the VS Code window is closed, the auth token persists in
the profile and every subsequent `npm run headless` run reuses it —
no further sign-in needed.

On the first real `npm run headless` after setup, VS Code will display
a one-time "Allow Lupa to use Copilot?" prompt in the spawned window.
Click Allow. The approval is stored in the dedicated profile and every
subsequent run proceeds silently.

Re-running `npm run headless:setup` is safe (idempotent) and is the
correct recovery path if Copilot auth ever expires.

## Why not `runTests` / `--extensionTestsPath`

Earlier iterations used `@vscode/test-electron`'s `runTests(...)` helper
with an `extensionTestsPath` module. That path puts the extension host
into `ExtensionMode.Test`, and the Copilot extension's
`LanguageModelAccess` explicitly refuses to register `vscode.lm`
providers in test mode (unless the `IS_SCENARIO_AUTOMATION=1` flag is
set — which is Copilot's own internal test harness and requires a
static GitHub PAT, bypassing the user's Copilot Pro sign-in). The net
effect was that `selectChatModels` always returned an empty array even
though Copilot Chat itself worked inside the spawned window.

The direct-spawn model here sidesteps that: VS Code is launched without
`--extensionTestsPath`, so Lupa and Copilot Chat load as normal
Development-mode extensions, Copilot registers its LM provider, and the
user's signed-in Copilot subscription is used for every request. The
one-time cost is a single "Allow Lupa to use Copilot?" consent prompt
in the spawned window on the first real run; the approval is persisted
in the dedicated `--user-data-dir` and every subsequent run is silent.

## How Copilot is loaded into the host

`launchHeadless.js` passes `--extensionDevelopmentPath` twice — once for
the Lupa repo root and once for the resolved `github.copilot-chat`
install folder — so both load side-by-side as development extensions
and Lupa's `extensionDependencies` declaration resolves. The
copilot-chat folder is discovered at launch time by reading
`extensions.json` in the persistent extensions directory, so the
version suffix in the folder name is not hard-coded and survives
Copilot updates. `--disable-extensions` is set so no other user
extensions in the shared `--extensions-dir` are loaded; only the two
development extensions and VS Code's built-in system extensions run.
Auth persists because `--user-data-dir` is shared across runs; the
GitHub OAuth token managed by the `vscode.github-authentication`
system extension is found by copilot-chat on each launch.

## Future: pure-Node path

If GitHub ever publishes a stable HTTP surface for Copilot chat completions
authenticated with the user's Copilot token — equivalent in shape to the
OpenAI Chat Completions API — the Electron launcher becomes optional:

- `CopilotModelManager` would grow an HTTP transport alongside its current
  `vscode.lm` transport. The `ILLMClient` interface `AnalysisEngine.analyze`
  consumes is already transport-agnostic, so no downstream change is
  required.
- `launchHeadless.js` could then call `runHeadless()` in-process, without
  `@vscode/test-electron`, eliminating the ~5–10s VS Code-spawn overhead
  per run and letting CI parallelize runs cheaply.
- The extension-host path would remain as the production UX and as a
  fallback for users without a compatible Copilot token.

Nothing in `src/eval/` should accumulate extension-host assumptions beyond
what `vscode.lm` strictly requires. In particular, the diff resolver, arg
parser, and result shape are deliberately free of `vscode.*` coupling so the
eventual migration is a transport swap, not a rewrite.

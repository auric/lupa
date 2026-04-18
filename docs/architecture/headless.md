# Headless analysis entry point

Lupa exposes a CLI-driven entry point that runs a full PR analysis against an
arbitrary `(workspaceRoot, baseRef, headRef, modelProfile)` tuple without
opening the webview or chat participant. It is the substrate Quests 8.1 and 8.2
(eval harness and resolution-rate metric) build on, and — by construction — it
reuses the same `AnalysisEngine` pipeline the production UI paths use.

## Components

| Layer                 | File                                           | Runs in                |
| --------------------- | ---------------------------------------------- | ---------------------- |
| CLI arg parser        | `scripts/eval/headlessArgs.js`                 | Node (launcher)        |
| Launcher              | `scripts/eval/launchHeadless.js`               | Node (launcher)        |
| Extension-host runner | `scripts/eval/extensionTestRunner.js`          | VS Code extension host |
| Programmatic API      | `src/extension.ts` → `LupaExtensionApi`        | VS Code extension host |
| Analysis entry        | `src/eval/headlessRunner.ts` → `runHeadless()` | VS Code extension host |
| Diff resolver         | `src/eval/diffResolver.ts`                     | VS Code extension host |

The launcher is plain Node. It parses CLI flags, resolves the workspace path,
then hands off to `@vscode/test-electron`, which spawns a VS Code extension
host, loads the built Lupa extension, and executes
`scripts/eval/extensionTestRunner.js` inside that host. The runner activates
Lupa, reads the JSON-serialized options from `LUPA_HEADLESS_ARGS`, and calls
`api.runHeadless(...)`, which is the thin wrapper defined in
`src/eval/headlessRunner.ts`.

```
CLI args ──► launchHeadless.js ──┐
                                 │ (spawns VS Code via @vscode/test-electron)
                                 ▼
                    ┌────────────────────────────┐
                    │  VS Code extension host    │
                    │                            │
                    │  extensionTestRunner.js    │
                    │        │                   │
                    │        ▼                   │
                    │  LupaExtensionApi          │
                    │  .runHeadless(opts)        │
                    │        │                   │
                    │        ▼                   │
                    │  AnalysisEngine.analyze()  │◄── same seam the
                    │                            │    webview and chat
                    └────────────────────────────┘    participants use
```

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

`@vscode/test-electron` is VS Code's supported mechanism for doing exactly
this: download VS Code into a cache, launch it with the extension-under-test
loaded, and execute a Node module inside the host. We use it for production
CI of Lupa's analysis path rather than strictly as a test runner.

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

- A git ref (`main`, `feature/x`, short or full SHA) — resolved via `git
  rev-parse` inside the workspace.
- `sha:<sha>` — explicit SHA form, useful when a branch name is ambiguous.
- `dir:<path>` — compare two directory snapshots instead of git refs. Used by
  Kind-A synthetic fixtures (Quest 8.1) that ship as plain directories, not
  git repos.

Exit codes: `0` on analysis completion regardless of finding count, `1` on
fatal runtime error (missing workspace, unknown model, unresolvable refs,
unhandled exception inside the host), `2` on CLI argument errors.

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

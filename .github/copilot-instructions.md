# Lupa

VS Code extension for PR analysis using GitHub Copilot. See [CLAUDE.md](../CLAUDE.md) for full architecture.

## Agent Behavior

Be a skeptical collaborator, not a compliant assistant. Question assumptions, verify claims against the codebase, and push back when something seems wrong. I am not always right. Neither are you, but we both strive for accuracy.

**Code quality expectations:**

- Write production-ready TypeScript: DRY, SOLID, properly typed
- Comments only where non-obvious; avoid redundant explanations
- Documentation should read as if written by a senior engineer, not generated
- Verify changes compile (`npm run build`) and consider test impact

**Working style:**

- Research before implementing—read existing patterns in the codebase first
- When uncertain, investigate rather than guess
- Propose alternatives if you see a better approach
- Acknowledge limitations honestly rather than fabricating answers
- Use subagents for parallel research tasks—break complex work into small, focused subtasks (never delegate the entire task to a single subagent)
- Keep in mind terminal is powershell; test output can be massive—after running tests, read only the last ~50 lines for the summary

## Commands

- `npm run check-types` - Fast type checking (~2s), prefer over `npm run build` for validation
- `npm run build` - Full build (~30s), use sparingly
- `npm run test` - Run all tests; **output is massive**, read only final summary lines
- `npm run package` - Production build
- `npx vitest run src/__tests__/file.test.ts` - Single test

**Context window warning:** Test output can overwhelm context. After running tests, read only the last ~50 lines for the summary. Prefer running specific test files over the full suite.

## Conventions

- Use `Log` from `loggingService.ts`, not `console.log` (exception: webviews)
- Use `toolSuccess()`/`toolError()` for tool return values
- Prefer `param: string | undefined` over `param?: string`
- New tools: extend `BaseTool`, use Zod schema, register in `ServiceManager.initializeTools()`
- New services: implement `vscode.Disposable`, use `getInstance()` for singletons
- Tests mock VS Code via `__mocks__/vscode.js`

## Key Files

- `../src/services/serviceManager.ts` - DI container, 3-phase initialization
- `../src/services/toolCallingAnalysisProvider.ts` - Main analysis loop
- `../vite.config.mts` - Dual build config (Node.js extension + browser webview)

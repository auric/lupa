# Lupa

VS Code extension for PR analysis using GitHub Copilot. See [CLAUDE.md](../CLAUDE.md) for full architecture.

## Agent Behavior

Be a skeptical collaborator, not a compliant assistant. Question assumptions, verify claims against the codebase, and push back when something seems wrong. I am not always right. Neither are you, but we both strive for accuracy.

**Code quality expectations:**

- Write production-ready TypeScript: DRY, SOLID, properly typed
- No obvious comments—add comments only when logic is non-trivial or intent is unclear
- Documentation should read as if written by a senior engineer, not generated
- Verify changes compile (`npm run build`) and consider test impact

**Working style:**

- Research before implementing—read existing patterns in the codebase first
- When uncertain, investigate rather than guess
- Propose alternatives if you see a better approach
- Acknowledge limitations honestly rather than fabricating answers
- Use subagents for parallel research tasks—break complex work into small, focused subtasks (never delegate the entire task to a single subagent)
- Keep in mind terminal is powershell; test output can be massive—after running tests, read only the last ~50 lines for the summary
- At session end, provide a ready-to-use git commit message summarizing changes

## BMAD Method (v6 Alpha)

This project uses BMAD-METHOD for agent-driven development workflows. When executing as a BMAD agent (e.g., Quick Flow Solo Dev Agent):

**CRITICAL: Before any BMAD workflow execution, you MUST read and load the required config and workflow files. Do not proceed from memory—always fetch the actual files.**

**If your mode starts with `bmd-` or `bmad-`, you ARE a BMAD agent. Stop and load the required files NOW before proceeding.**

1. **Activation is mandatory**: Load agent persona file first, then read `{project-root}/_bmad/core/config.yaml` for user settings
2. **Workflow execution**: Before running any workflow, load `{project-root}/_bmad/core/tasks/workflow.xml` as the core OS
3. **Stay in character**: Follow agent persona and menu system until explicitly dismissed
4. **Output discipline**: Save outputs after each workflow step—never batch multiple steps together

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

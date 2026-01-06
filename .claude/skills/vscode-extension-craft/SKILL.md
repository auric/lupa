---
name: vscode-extension-craft
description: Create distinctive, production-grade VS Code extensions with TypeScript. Use this skill when building, reviewing, or refactoring VS Code extensions—including commands, views, providers, webviews, language features, or AI/chat integrations. Produces extensions that feel native, activate fast, and follow VS Code's design philosophy.
---

# VS Code Extension Craft

Build VS Code extensions that feel native—fast, focused, properly architected. Extensions should be invisible until needed, then indispensable.

## Unknown API Protocol

**CRITICAL**: When unsure about VS Code API behavior, newer APIs, or third-party library usage:

1. Check VS Code API typings first (hover in IDE shows signatures)
2. Query DeepWiki MCP with `microsoft/vscode` for VS Code APIs
3. Query DeepWiki MCP with relevant repo for third-party libraries (e.g., `vitest-dev/vitest`)
4. Use Tavily MCP to search official documentation as last resort

**NEVER hallucinate API signatures or behavior.** If documentation is unclear, verify before implementing.

## Documentation & Comments

**JSDoc only for:**

- Public API functions and exported classes
- Non-obvious parameters or return types
- Complex generic type definitions

**Inline comments only when:**

- Logic is genuinely non-obvious to a senior developer
- Business rule requires explanation
- Workaround for known issue (include issue link)

**NEVER add comments for:**

- Self-explanatory code (`// increment counter`)
- Type information already expressed in TypeScript
- Control flow that's clear from variable/function names
- Closing braces or obvious structure

## Design Thinking

Before coding:

- **Purpose**: What specific problem? What's the core value?
- **API Surface**: Commands? Views? Language features? Webviews?
- **User Experience**: Command palette, context menus, activity bar, status bar?
- **Architecture**: Minimal single-file? Service-oriented with DI?

Implement code that is:

- Fast to activate (<100ms)
- Native-feeling (appropriate VS Code APIs)
- Properly disposed (no memory leaks)
- Testable with mocked `vscode` module

## Core Principles

### Activation Strategy

Be specific with activation events—`"*"` or `"onStartupFinished"` makes your extension a startup tax.

```json
"activationEvents": [
  "onCommand:myext.specificCommand",
  "onView:myext.treeView",
  "workspaceContains:**/.myconfig"
]
```

Defer heavy work: register commands immediately, initialize on-demand.

### Disposable Management

Every `register*`, `create*`, `on*` call returns a Disposable. Track all of them.

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(...),
  vscode.workspace.onDidChangeConfiguration(...),
  myService  // Services implement Disposable
);
```

### Dependency Injection Over Singletons

**Avoid singletons.** They hide dependencies and break testability.

- Use a ServiceManager as composition root
- Pass dependencies via constructors
- Phase initialization by dependency order
- Only exception: truly stateless utilities (logging) MAY use getInstance()

```typescript
// ServiceManager is the ONLY composition root
class ServiceManager {
    async initialize() {
        const settings = new SettingsService(context);
        const git = new GitService(settings); // Explicit dependency
        const analysis = new AnalysisService(git, settings);
    }
}
```

### CancellationToken Propagation

Propagate tokens through all async operations. Check `isCancellationRequested` before expensive work.

## TypeScript Patterns

Use strict TypeScript configuration. Prefer discriminated unions for state machines, branded types for type-safe IDs, and `param: T | undefined` over `param?: T` for explicit nullability.

## Anti-Patterns

NEVER produce:

- **Singletons for stateful services** — Use DI, ServiceManager as composition root
- **Global state in extension.ts** — Use service classes
- **Forgotten disposables** — Every `register*`, `create*`, `on*` returns one
- **Blocking activation** — Defer heavy work
- **Synchronous file I/O** — Use `vscode.workspace.fs` async APIs
- **Hardcoded paths** — Use workspace folders or Git root
- **`any` types** — VS Code APIs are well-typed
- **Obvious comments** — Code should be self-documenting
- **Webview for everything** — Native TreeViews and QuickPicks perform better

## API Selection

| Need              | API                                    | When                  |
| ----------------- | -------------------------------------- | --------------------- |
| User action       | `commands.registerCommand`             | Discrete operations   |
| Hierarchical data | `TreeDataProvider`                     | File trees, outlines  |
| Rich UI           | `WebviewViewProvider`                  | Forms, dashboards     |
| Quick selection   | `window.showQuickPick`                 | Choosing from options |
| Background status | `StatusBarItem`                        | Ongoing state         |
| Long operation    | `window.withProgress`                  | Operations >500ms     |
| Code intelligence | `DefinitionProvider`, `HoverProvider`  | Language features     |
| AI features       | `ChatParticipant`, `LanguageModelTool` | Copilot integration   |

## References

- [api-patterns.md](references/api-patterns.md) — VS Code API patterns and when to use each
- [service-architecture.md](references/service-architecture.md) — DI, lifecycle, anti-singleton patterns
- [testing-strategies.md](references/testing-strategies.md) — Mocking vscode module, mock factories
- [performance-checklist.md](references/performance-checklist.md) — Activation, lazy loading, caching

## Quality Indicators

- Activation <100ms
- All disposables tracked
- No singletons (except stateless utilities)
- Tests with mocked `vscode` module
- CancellationToken respected in long operations
- Clear error messages with actionable guidance

# Service Architecture Patterns

Patterns for structuring VS Code extensions with proper DI and lifecycle management.

## Table of Contents

- [When to Use Services](#when-to-use-services)
- [Why Not Singletons](#why-not-singletons)
- [Service Manager Pattern](#service-manager-pattern)
- [Dependency Injection](#dependency-injection)
- [Event-Driven Communication](#event-driven-communication)

---

## When to Use Services

| Extension Size | Pattern                                       |
| -------------- | --------------------------------------------- |
| 1-2 files      | Direct implementation in `extension.ts`       |
| 3-10 files     | Functional modules with explicit dependencies |
| 10+ files      | ServiceManager with phased DI                 |

---

## Why Not Singletons

**Singletons are an anti-pattern for stateful services.** They cause:

- **Hidden dependencies** — Code uses global state invisibly
- **Testing difficulty** — Can't inject mocks easily
- **Initialization order bugs** — Singleton accessed before dependencies ready
- **Memory leaks** — Static references prevent garbage collection

**Instead:**

- Use ServiceManager as the single composition root
- Pass all dependencies via constructor injection
- Only exception: truly stateless utilities (logging) MAY use getInstance()

```typescript
// BAD: Singleton hiding dependencies
class AnalysisService {
    analyze() {
        const git = GitService.getInstance(); // Hidden dependency
        const settings = SettingsService.getInstance(); // Another hidden one
    }
}

// GOOD: Explicit dependencies
class AnalysisService {
    constructor(
        private readonly git: IGitService,
        private readonly settings: ISettingsService
    ) {}
}
```

---

## Service Manager Pattern

Single composition root with phased initialization:

```typescript
class ServiceManager implements vscode.Disposable {
    private services: Partial<IServiceRegistry> = {};

    async initialize(): Promise<IServiceRegistry> {
        // Phase 1: Foundation (no dependencies)
        this.services.settings = new SettingsService(this.context);

        // Phase 2: Core (depend on foundation)
        this.services.git = new GitService(this.services.settings);

        // Phase 3: High-level (depend on core)
        this.services.analysis = new AnalysisService(
            this.services.git,
            this.services.settings
        );

        return this.services as IServiceRegistry;
    }

    dispose(): void {
        // Dispose in reverse order
        [
            this.services.analysis,
            this.services.git,
            this.services.settings,
        ].forEach((s) => s?.dispose());
    }
}
```

**Key principle**: A service can only depend on services from earlier phases.

---

## Dependency Injection

### Constructor Injection (Preferred)

```typescript
class AnalysisService implements vscode.Disposable {
    constructor(
        private readonly git: IGitService,
        private readonly settings: ISettingsService
    ) {}
}
```

### Interface-Based Dependencies (For Testability)

```typescript
interface IGitService {
    getRepositoryRoot(): Promise<string>;
    getDiff(): Promise<string>;
}

// In tests: easy to mock
const mockGit: IGitService = {
    getRepositoryRoot: vi.fn().mockResolvedValue('/mock'),
    getDiff: vi.fn().mockResolvedValue('mock diff'),
};
```

### Setter Injection (For Circular Dependencies)

When two services need each other:

```typescript
const a = new ServiceA();
const b = new ServiceB(a);
a.setServiceB(b); // Late binding
```

---

## Event-Driven Communication

Use typed EventEmitters for loose coupling:

```typescript
class AnalysisService implements vscode.Disposable {
    private readonly _onComplete = new vscode.EventEmitter<AnalysisResult>();
    readonly onComplete = this._onComplete.event;

    async analyze(): Promise<void> {
        const result = await this.performAnalysis();
        this._onComplete.fire(result);
    }

    dispose(): void {
        this._onComplete.dispose();
    }
}
```

**Always track event subscriptions for disposal:**

```typescript
this.disposables.push(
    analysisService.onComplete((result) => this.display(result))
);
```

# Testing Strategies for VS Code Extensions

Essential patterns for testing extensions with mocked dependencies.

## Mocking the vscode Module

VS Code extensions can't import the real `vscode` module in tests.

**Setup:**

1. Create `__mocks__/vscode.js` with mocks for the VS Code APIs your extension uses
2. Use `vi.fn()` from Vitest for all mock functions
3. Configure Vitest alias to resolve `vscode` to the mock

```typescript
// vitest.config.ts
alias: {
    vscode: path.resolve(__dirname, '__mocks__/vscode.js');
}
```

**Key mocking considerations:**

- Mock constructors (Position, Range, Uri) with `vi.fn(function() {...})` syntax (Vitest 4 requirement)
- Include static methods on Uri: `Uri.file()`, `Uri.parse()`, `Uri.joinPath()`
- Mock CancellationTokenSource with proper listener tracking for cancel propagation tests
- EventEmitter needs `event` getter and `fire()` method

---

## Mock Factories

Create reusable factories in a shared test utilities file:

```typescript
// src/__tests__/testUtils/mockFactories.ts
import * as vscode from 'vscode';
import { vi } from 'vitest';

export function createMockCancellationTokenSource() {
    const listeners: (() => void)[] = [];
    const token: vscode.CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
            listeners.push(listener);
            return {
                dispose: () => {
                    /* remove listener */
                },
            };
        },
    };
    return {
        token,
        cancel: () => {
            (token as any).isCancellationRequested = true;
            listeners.forEach((l) => l());
        },
        dispose: vi.fn(),
    };
}
```

**Why factories matter:**

- Consistent mock setup across tests
- Proper listener tracking for event-based tests
- Easy to extend with project-specific behavior

---

## Test Patterns

### Interface-Based Mocking

Depend on interfaces, not implementations, for easy mocking:

```typescript
interface IGitService {
    getRepositoryRoot(): Promise<string>;
    getDiff(): Promise<string>;
}

// In tests
const mockGit: IGitService = {
    getRepositoryRoot: vi.fn().mockResolvedValue('/root'),
    getDiff: vi.fn().mockResolvedValue(''),
};
const service = new AnalysisService(mockGit);
```

### Testing Disposal

```typescript
it('should dispose all resources', () => {
    const service = new MyService();
    service.dispose();
    // Verify internal disposables were cleaned up
});
```

### Testing Cancellation

```typescript
it('should stop on cancellation', async () => {
    const cts = createMockCancellationTokenSource();
    const promise = service.longOperation(cts.token);

    cts.cancel();

    await expect(promise).resolves.not.toThrow();
});
```

---

## Testing Anti-Patterns

- **Testing implementation details** — Test behavior, not private methods
- **Overmocking** — Mock at boundaries, not internal functions
- **Missing edge cases** — Test cancellation, empty inputs, errors

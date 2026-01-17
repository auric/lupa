# Development Guide

> **Build, test, and contribute to Lupa**

## Prerequisites

| Requirement    | Version   | Notes                          |
| -------------- | --------- | ------------------------------ |
| Node.js        | ≥20       | Required for build and runtime |
| npm            | Latest    | Package manager                |
| VS Code        | ≥1.107.0  | Extension host                 |
| Git            | Any       | Version control                |
| GitHub Copilot | Installed | Required for LLM access        |

---

## Quick Start

```bash
# Clone repository
git clone https://github.com/auric/lupa.git
cd lupa

# Install dependencies (also installs Git hooks)
npm install

# Build extension
npm run build

# Open in VS Code
code .

# Press F5 to launch Extension Development Host
```

---

## Git Hooks

Pre-commit hooks are installed automatically via Husky when you run `npm install`.

### What Runs on Commit

| Step | Check    | Scope          | Purpose                       |
| ---- | -------- | -------------- | ----------------------------- |
| 1    | tsc      | Entire project | TypeScript type checking      |
| 2    | oxlint   | Entire project | Linting (blocks on errors)    |
| 3    | prettier | Staged files   | Auto-format (writes to files) |

### Fixing Issues Before Commit

```bash
npm run lint:fix    # Auto-fix lint issues and format code
```

### Hook Not Working?

```bash
npm run prepare     # Reinstall hooks
```

---

## NPM Scripts

### Development

| Command               | Description                              | Time |
| --------------------- | ---------------------------------------- | ---- |
| `npm run build`       | Full build (type check + node + webview) | ~30s |
| `npm run check-types` | TypeScript type checking only            | ~2s  |
| `npm run watch`       | Build and watch for changes              | -    |
| `npm run clean`       | Remove dist/ and .vsix files             | -    |

### Testing

| Command                 | Description              | Notes                                |
| ----------------------- | ------------------------ | ------------------------------------ |
| `npm run test`          | Run all tests            | ⚠️ Large output, read last ~50 lines |
| `npm run test:watch`    | Watch mode               | Interactive                          |
| `npm run test:coverage` | Generate coverage report | Outputs to coverage/                 |
| `npx vitest run <file>` | Run specific test file   | Faster iteration                     |

### Production

| Command                         | Description                            |
| ------------------------------- | -------------------------------------- |
| `npm run package`               | Production build (minified)            |
| `npm run package:vsix`          | Create .vsix package (production)      |
| `npm run package:vsix:internal` | Create .vsix with dev features enabled |
| `npm run vscode:prepublish`     | Pre-publish hook (runs package)        |

### Build Profiles

The extension supports two build profiles for packaging:

| Profile      | Commands                | Webview                 | Use Case                    |
| ------------ | ----------------------- | ----------------------- | --------------------------- |
| `production` | Core only               | Core only               | Public release              |
| `internal`   | All (incl. toolTesting) | All (incl. toolTesting) | Internal testing/dogfooding |

**Production build** (default): Strips development-only commands from package.json and excludes dev webview bundles.

**Internal build**: Full-featured build for internal testing. All commands and webviews included.

```bash
# Production release
npm run package:vsix

# Internal build with dev tools
npm run package:vsix:internal
```

The profile is controlled via `BUILD_PROFILE` environment variable, with configuration centralized in `scripts/build-profiles.js`.

---

## Build System

### Dual Build Architecture

Vite builds two separate bundles:

1. **Node.js Extension** (`npm run build:node`)
    - Entry: `src/extension.ts`
    - Output: `dist/extension.js` (CommonJS)
    - Target: ES2024
    - SSR mode with bundled dependencies

2. **Browser Webview** (`npm run build:webview`)
    - Entry: `src/webview/main.tsx`
    - Output: `dist/webview/main.js` (ESM)
    - Target: ES2024
    - React with Compiler plugin
    - Tailwind CSS processing

### Build Configuration

Key configuration in `vite.config.mts`:

```typescript
// Extension build
lib: {
  entry: { extension: 'src/extension.ts' },
  formats: ['cjs'],
}

// Webview build (via BUILD_TARGET=webview)
rollupOptions: {
  input: { main: 'src/webview/main.tsx' },
  output: { format: 'esm' },
}
```

---

## Testing

### Test Structure

```
src/__tests__/
├── *.test.ts          # Node.js tests
├── *.test.tsx         # React component tests
└── testUtils/
    └── mockFactories.ts  # Shared mock factories
```

### Test Environments

| Environment | Files        | Purpose                          |
| ----------- | ------------ | -------------------------------- |
| Node        | `*.test.ts`  | Extension logic, services, tools |
| jsdom       | `*.test.tsx` | React components                 |

### VS Code Mocking

VS Code API is mocked via `__mocks__/vscode.js`:

```typescript
// In tests, vscode is automatically mocked
import * as vscode from 'vscode';

// Mock specific behavior
vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
    Buffer.from('file content')
);
```

### Mock Factories

Use shared factories from `testUtils/mockFactories.ts`:

```typescript
import {
    createMockCancellationTokenSource,
    createMockWorkspaceSettings,
    createMockGitRepository,
} from './testUtils/mockFactories';

const tokenSource = createMockCancellationTokenSource();
const settings = createMockWorkspaceSettings();
```

### Running Specific Tests

```bash
# Single file
npx vitest run src/__tests__/toolExecutor.test.ts

# Pattern match
npx vitest run -t "should execute tool"

# Watch mode
npx vitest --watch src/__tests__/toolExecutor.test.ts
```

### Coverage

```bash
npm run test:coverage

# View report
open coverage/lcov-report/index.html
```

---

## Debugging

### Extension Host

1. Open VS Code with workspace
2. Press `F5` to launch Extension Development Host
3. Set breakpoints in `src/` files
4. Trigger commands or chat participant

### Webview

1. In Extension Development Host, trigger analysis
2. Open Developer Tools: `Cmd+Shift+P` → "Developer: Open Webview Developer Tools"
3. Debug React components in browser DevTools

### Logging

```typescript
import { Log } from './services/loggingService';

Log.info('Analysis started');
Log.debug('Tool arguments:', args);
Log.warn('Rate limit approaching');
Log.error('Tool execution failed:', error);
```

View logs: `Output` panel → `Lupa`

---

## Code Style

### Logging

✅ Use `Log` from `loggingService.ts`
❌ Never use `console.log` in extension code (webview exception)

### Tool Results

```typescript
import { toolSuccess, toolError } from '../types/toolResultTypes';

// Success
return toolSuccess(formattedData);

// Error
return toolError('File not found');
```

### Type Safety

```typescript
// Prefer explicit undefined
function process(param: string | undefined): void;

// Over optional parameter
function process(param?: string): void; // Avoid
```

### New Tools

1. Create class extending `BaseTool` in `src/tools/`
2. Define Zod schema for parameters
3. Implement `execute(args, context)` returning `ToolResult` — `context: ExecutionContext` is required
4. Register in `ServiceManager.initializeTools()`
5. Access per-analysis dependencies via `ExecutionContext` (cancellationToken, planManager, etc.)

```typescript
import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';

export class MyTool extends BaseTool {
    name = 'my_tool';
    description = 'Does something useful';

    schema = z.object({
        param: z.string().describe('Parameter description'),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        // Check cancellation for long operations
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        // Implementation
        return toolSuccess(result);
    }
}
```

### Testing Tools

Use `createMockExecutionContext()` from `testUtils/mockFactories.ts` when testing tool execution:

```typescript
import { createMockExecutionContext } from './testUtils/mockFactories';

it('should process input correctly', async () => {
    const tool = new MyTool();
    const result = await tool.execute(
        { param: 'value' },
        createMockExecutionContext()
    );
    expect(result.success).toBe(true);
});
```

For cancellation testing, use `createCancelledExecutionContext()`:

```typescript
it('should handle cancellation', async () => {
    const tool = new MyTool();
    await expect(
        tool.execute({ param: 'value' }, createCancelledExecutionContext())
    ).rejects.toThrow();
});
```

---

## Adding Features

### New Service

1. Implement `vscode.Disposable` interface
2. Add to appropriate phase in `ServiceManager`
3. Update `IServiceRegistry` interface

```typescript
// In ServiceManager.ts
private async initializeCoreServices(): Promise<void> {
  this.services.myService = new MyService(this.services.workspaceSettings!);
}
```

### New Chat Command

1. Add to `chatParticipants.commands` in `package.json`
2. Implement handler in `ChatParticipantService`
3. Add to followup provider if needed

### New Webview Component

1. Create component in `src/webview/components/`
2. Use shadcn/ui primitives when possible
3. Test with jsdom environment

---

## Quality Checklist

Before submitting changes:

- [ ] `npm run check-types` passes
- [ ] Relevant tests added/updated
- [ ] No `console.log` in extension code
- [ ] Tool results use `toolSuccess`/`toolError`
- [ ] New tools registered in `ServiceManager`
- [ ] Comments explain non-obvious logic

---

## Troubleshooting

### Build Fails

```bash
# Clean and rebuild
npm run clean
npm install
npm run build
```

### Tests Fail with Mock Errors

```bash
# Reset mocks
npm run test -- --clearCache
```

### Extension Not Loading

1. Check Output panel for errors
2. Verify VS Code version ≥1.107.0
3. Ensure GitHub Copilot is installed and authenticated

### Webview Not Updating

1. Close all webview panels
2. Rebuild: `npm run build:webview`
3. Reload window: `Cmd+Shift+P` → "Developer: Reload Window"

---

## Related Documentation

- [Architecture](architecture.md) - System design and patterns
- [Source Tree](source-tree-analysis.md) - Directory structure
- [Component Inventory](component-inventory.md) - All components
- [CLAUDE.md](../CLAUDE.md) - Complete development guidelines

# Performance Checklist for VS Code Extensions

Optimization strategies for fast, responsive extensions.

## Table of Contents

- [Activation Performance](#activation-performance)
- [Lazy Loading Patterns](#lazy-loading-patterns)
- [Memory Management](#memory-management)
- [File Operations](#file-operations)
- [Caching Strategies](#caching-strategies)
- [Bundle Optimization](#bundle-optimization)

---

## Activation Performance

### Activation Time Budget

| Category             | Target   | Warning       |
| -------------------- | -------- | ------------- |
| Perceived startup    | <50ms    | >100ms        |
| Total activation     | <100ms   | >200ms        |
| Heavy initialization | Deferred | In activate() |

### Measure Activation Time

```typescript
export async function activate(context: vscode.ExtensionContext) {
    const start = performance.now();

    // Initialization code

    const elapsed = performance.now() - start;
    console.log(`Extension activated in ${elapsed.toFixed(1)}ms`);
}
```

### Defer Heavy Initialization

```typescript
// BAD: Blocking activation
export async function activate(context: vscode.ExtensionContext) {
    const allSymbols = await indexEntireWorkspace(); // Blocks for seconds
    globalState.symbols = allSymbols;
}

// GOOD: Lazy initialization
export async function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('myext.search', async () => {
            const symbols = await getOrCreateSymbolIndex();
            await searchSymbols(symbols);
        })
    );
}

let symbolIndex: SymbolIndex | undefined;
async function getOrCreateSymbolIndex(): Promise<SymbolIndex> {
    if (!symbolIndex) {
        symbolIndex = await indexEntireWorkspace();
    }
    return symbolIndex;
}
```

### Specific Activation Events

```json
// BAD: Activates on every startup
"activationEvents": ["*"]

// BAD: Activates after all extensions load
"activationEvents": ["onStartupFinished"]

// GOOD: Activates only when needed
"activationEvents": [
  "onCommand:myext.analyze",
  "onView:myext.sidebar",
  "onLanguage:typescript",
  "workspaceContains:**/.myconfig"
]
```

---

## Lazy Loading Patterns

### Dynamic Imports

```typescript
// Register command immediately, import heavy module on demand
context.subscriptions.push(
    vscode.commands.registerCommand('myext.heavyFeature', async () => {
        const { HeavyAnalyzer } = await import('./heavyAnalyzer');
        const analyzer = new HeavyAnalyzer();
        await analyzer.run();
    })
);
```

### Service-on-Demand Pattern

```typescript
class ServiceProvider {
    private _analysisService?: AnalysisService;

    async getAnalysisService(): Promise<AnalysisService> {
        if (!this._analysisService) {
            // Heavy initialization happens only on first access
            this._analysisService = new AnalysisService();
            await this._analysisService.initialize();
        }
        return this._analysisService;
    }
}
```

### Lazy TreeDataProvider

```typescript
class LazyTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private cache = new Map<string, TreeItem[]>();

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        const key = element?.id ?? 'root';

        if (this.cache.has(key)) {
            return this.cache.get(key)!;
        }

        // Only fetch when user expands
        const children = await this.fetchChildren(element);
        this.cache.set(key, children);
        return children;
    }

    invalidate(key?: string): void {
        if (key) {
            this.cache.delete(key);
        } else {
            this.cache.clear();
        }
        this._onDidChangeTreeData.fire(undefined);
    }
}
```

---

## Memory Management

### Dispose Everything

```typescript
class MyService implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private cache = new Map<string, CachedData>();
    private watchers: vscode.FileSystemWatcher[] = [];

    dispose(): void {
        // Dispose VS Code resources
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];

        // Dispose watchers
        this.watchers.forEach((w) => w.dispose());
        this.watchers = [];

        // Clear caches
        this.cache.clear();
    }
}
```

### Bounded Caches

```typescript
class LRUCache<K, V> {
    private cache = new Map<K, V>();

    constructor(private maxSize: number) {}

    get(key: K): V | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // Move to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Delete oldest
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, value);
    }
}

// Usage
const symbolCache = new LRUCache<string, Symbol[]>(100);
```

### WeakMap for Object-Keyed Caches

```typescript
// Automatically garbage collected when document is closed
const documentCache = new WeakMap<vscode.TextDocument, AnalysisResult>();

function getCachedAnalysis(
    doc: vscode.TextDocument
): AnalysisResult | undefined {
    return documentCache.get(doc);
}

function setCachedAnalysis(
    doc: vscode.TextDocument,
    result: AnalysisResult
): void {
    documentCache.set(doc, result);
}
```

---

## File Operations

### Use Workspace FS API

```typescript
// GOOD: Async, cancellable, works with virtual filesystems
const content = await vscode.workspace.fs.readFile(uri);
const text = new TextDecoder().decode(content);

// BAD: Blocks, only works with local files
const text = fs.readFileSync(path, 'utf-8');
```

### Batch File Operations

```typescript
// BAD: Sequential reads
const results = [];
for (const file of files) {
    const content = await vscode.workspace.fs.readFile(file);
    results.push(processContent(content));
}

// GOOD: Parallel reads with concurrency limit
async function readFilesWithLimit(
    files: vscode.Uri[],
    limit: number = 10
): Promise<Uint8Array[]> {
    const results: Uint8Array[] = [];

    for (let i = 0; i < files.length; i += limit) {
        const batch = files.slice(i, i + limit);
        const batchResults = await Promise.all(
            batch.map((f) => vscode.workspace.fs.readFile(f))
        );
        results.push(...batchResults);
    }

    return results;
}
```

### Use Glob Patterns Efficiently

```typescript
// GOOD: Use ripgrep through VS Code
const files = await vscode.workspace.findFiles(
    '**/*.ts', // Include pattern
    '**/node_modules/**' // Exclude pattern
);

// GOOD: Relative patterns for specific folders
const pattern = new vscode.RelativePattern(workspaceFolder, 'src/**/*.ts');
const files = await vscode.workspace.findFiles(pattern);
```

---

## Caching Strategies

### File Content Cache with Invalidation

```typescript
class FileCache implements vscode.Disposable {
    private cache = new Map<string, { content: string; mtime: number }>();
    private watcher: vscode.FileSystemWatcher;

    constructor(pattern: vscode.GlobPattern) {
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidChange((uri) => this.invalidate(uri));
        this.watcher.onDidDelete((uri) => this.invalidate(uri));
    }

    async get(uri: vscode.Uri): Promise<string> {
        const key = uri.toString();
        const stat = await vscode.workspace.fs.stat(uri);
        const cached = this.cache.get(key);

        if (cached && cached.mtime === stat.mtime) {
            return cached.content;
        }

        const content = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(uri)
        );
        this.cache.set(key, { content, mtime: stat.mtime });
        return content;
    }

    invalidate(uri: vscode.Uri): void {
        this.cache.delete(uri.toString());
    }

    dispose(): void {
        this.watcher.dispose();
        this.cache.clear();
    }
}
```

### Symbol Index Cache

```typescript
class SymbolIndexCache {
    private index: Map<string, Symbol[]> = new Map();
    private dirty = true;

    constructor() {
        // Invalidate on file changes
        vscode.workspace.onDidChangeTextDocument(() => {
            this.dirty = true;
        });
    }

    async getSymbols(uri: vscode.Uri): Promise<Symbol[]> {
        if (this.dirty) {
            await this.rebuild();
            this.dirty = false;
        }
        return this.index.get(uri.toString()) ?? [];
    }

    private async rebuild(): Promise<void> {
        // Rebuild index...
    }
}
```

---

## Bundle Optimization

### Vite/esbuild Configuration

```typescript
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/extension.ts',
            formats: ['cjs'],
            fileName: 'extension',
        },
        rollupOptions: {
            external: ['vscode'], // Don't bundle vscode
        },
        minify: 'esbuild',
        sourcemap: true,
        target: 'node18',
    },
});
```

### Minimize Dependencies

```typescript
// BAD: Huge dependency for one function
import _ from 'lodash';
const grouped = _.groupBy(items, 'category');

// GOOD: Native or minimal
const grouped = Object.groupBy(items, (item) => item.category);

// Or import only what you need
import groupBy from 'lodash/groupBy';
```

### Analyze Bundle Size

```bash
# Check what's in your bundle
npx vite-bundle-analyzer

# Or use esbuild's analyze
npx esbuild src/extension.ts --bundle --analyze
```

---

## Performance Checklist

Before release, verify:

- [ ] Extension activates in <100ms
- [ ] No heavy work in `activate()` function
- [ ] Activation events are specific (not `*`)
- [ ] All disposables are tracked and disposed
- [ ] Caches have size limits
- [ ] File operations use async APIs
- [ ] No synchronous file I/O
- [ ] Bundle size is reasonable (<1MB ideally)
- [ ] Dependencies are minimal and tree-shaken
- [ ] CancellationTokens are respected in long operations

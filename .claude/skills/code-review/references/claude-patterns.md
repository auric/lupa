# Claude Opus 4.6 Code Patterns

Patterns to watch for when reviewing code written by Claude Opus 4.6. Since the reviewer is also an LLM, this file explicitly addresses confirmation bias — the tendency to see well-structured code as correct code.

## Reviewer Bias Awareness

Claude reviewing Claude-written code has specific blind spots:

1. **Structural beauty ≠ correctness** — LLM-generated code tends to look clean and well-organized. Don't let good structure convince you the logic is correct. Specifically check edge cases in async operations, cancellation flows, and state rollbacks.

2. **Shared vocabulary bias** — Both author and reviewer use the same naming conventions and abstraction patterns. Something that "looks right" might just match your training distribution. Question whether the abstraction actually serves users of this code.

3. **Over-confidence in type safety** — TypeScript types give a false sense of security. Types ensure shape correctness but not semantic correctness. A function returning `Promise<ToolResult>` might always return the wrong result while still compiling.

4. **Missing negative test instinct** — Claude tends to write happy-path tests and skip failure/edge cases. When reviewing tests, actively ask: "What error paths are untested?"

## Over-Engineering Patterns

These patterns appear correct and often pass type checking, but add complexity without proportional value.

### Unnecessary Try-Catch in Tools

The #1 pattern to watch for in Lupa tools. ToolExecutor is the centralized error handler — it already converts errors to `toolError()`, rethrows CancellationError, and handles TimeoutError. A tool wrapping its entire `execute()` in try-catch is redundant.

```typescript
// ❌ Redundant — ToolExecutor already does this
async execute(args: Args, context: ExecutionContext): Promise<ToolResult> {
    try {
        const result = await doWork(args);
        return toolSuccess(result);
    } catch (error) {
        rethrowIfCancellationOrTimeout(error);
        return toolError(`Failed: ${error}`);
    }
}

// ✅ Let ToolExecutor handle errors
async execute(args: Args, context: ExecutionContext): Promise<ToolResult> {
    const result = await doWork(args);
    return toolSuccess(result);
}
```

Only add try-catch when the tool needs specific error handling (partial results, graceful degradation, continue-on-error loops).

### Interface for Single Implementation

```typescript
// ❌ No other class implements IAnalysisEngine
interface IAnalysisEngine {
    analyze(diff: FileDiff[]): Promise<Analysis>;
}
class AnalysisEngine implements IAnalysisEngine { ... }

// ✅ Just use the class directly until a second implementation exists
class AnalysisEngine {
    analyze(diff: FileDiff[]): Promise<Analysis> { ... }
}
```

### Factory/Builder for Simple Construction

```typescript
// ❌ Factory adds no value
class ToolResultFactory {
    static createSuccess(data: unknown): ToolResult {
        return toolSuccess(data);
    }
}

// ✅ Direct construction
return toolSuccess(data);
```

### Over-Parameterization

```typescript
// ❌ Options object for features never used
interface FileReadOptions {
    encoding?: BufferEncoding;
    normalize?: boolean;
    maxSize?: number;
    fallbackContent?: string;
}

// ✅ Only include parameters actually used by callers
function readFile(
    path: string,
    encoding: BufferEncoding = 'utf-8'
): Promise<string>;
```

### Defensive Coding at Non-Boundaries

```typescript
// ❌ Internal function validates what callers already ensure
function processValidatedDiff(diff: ValidatedDiff): Analysis {
    if (!diff) throw new Error('diff is required'); // can't happen
    if (!diff.files) throw new Error('files required'); // type guarantees this
    // ...
}

// ✅ Trust the type system for internal functions
function processValidatedDiff(diff: ValidatedDiff): Analysis {
    // Type guarantees diff and diff.files exist
    return diff.files.map(analyzeFile);
}
```

## Over-Documentation Patterns

### Obvious JSDoc

```typescript
// ❌ Restates the function name and types
/**
 * Gets the user by ID.
 * @param id - The user ID
 * @returns The user object
 */
function getUser(id: string): Promise<User>;

// ✅ Only document non-obvious behavior
/**
 * Returns cached user if available. Cache expires after 5 minutes.
 */
function getUser(id: string): Promise<User>;
```

### Step-by-Step Comments

```typescript
// ❌ Narrating the code
// Step 1: Get the files
const files = await getFiles();
// Step 2: Filter the files
const filtered = files.filter(isRelevant);
// Step 3: Process each file
const results = await Promise.all(filtered.map(process));
// Step 4: Return results
return results;

// ✅ Code speaks for itself
const files = await getFiles();
const relevant = files.filter(isRelevant);
return Promise.all(relevant.map(process));
```

## Naming Patterns

### Over-Verbose Names

```typescript
// ❌ Unnecessarily long
handleUserAuthenticationAndSessionCreation();
processAndValidateInputDataFromExternalSource();
createNewInstanceOfAnalysisEngine();

// ✅ Concise but clear
authenticateUser();
validateInput();
createAnalysisEngine();
```

### Redundant Type in Name

```typescript
// ❌ Type is in the type annotation
const userArray: User[] = [];
const nameString: string = user.name;
const isValidBoolean: boolean = validate(input);

// ✅ Just use the concept name
const users: User[] = [];
const name: string = user.name;
const isValid: boolean = validate(input);
```

## Async/Concurrency Blind Spots

These are the bugs Claude most often introduces or misses:

### CancellationToken Timing

```typescript
// ❌ Token state may not be set when error is thrown
catch (error) {
    if (context.cancellationToken.isCancellationRequested) {
        // might not be true yet!
    }
}

// ✅ Check the error type instead
catch (error) {
    if (isCancellationError(error)) {
        throw error;  // propagate cancellation
    }
}
```

### Resource Cleanup in Parallel Operations

```typescript
// ❌ Disposable not cleaned up on early exit
const cts = new CancellationTokenSource();
const results = await Promise.all(tasks.map((t) => run(t, cts.token)));
cts.dispose();

// ✅ Always dispose in finally
const cts = new CancellationTokenSource();
try {
    return await Promise.all(tasks.map((t) => run(t, cts.token)));
} finally {
    cts.dispose();
}
```

### State Rollback Completeness

Check: when a guarded phase rolls back state, does it roll back ALL mutable state? Known gaps in Lupa:

- `toolCallCounts` is NOT rolled back in guarded phases
- `ReasoningChain` IS snapshot/restored (fixed)
- Conversation history, FindingStore, investigatedFiles, completionReadiness ARE restored

## Detection Heuristic

For each piece of code, ask:

1. **Would a senior TypeScript developer write this?** Not "is it correct" but "is it natural"
2. **Does this add capability or just structure?** Abstractions without multiple consumers are overhead
3. **Is the error handling proportional to the risk?** Centralized handlers reduce the need for per-function error handling
4. **What semantic bug could hide behind this clean structure?** Look at state transitions, async timing, and resource lifecycle

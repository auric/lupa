# AI Slop Patterns

Patterns indicating low-quality, AI-generated, or "vibe-coded" content. Use this reference when analyzing code for quality issues.

## Obvious Comments (AUTO-REMOVE)

Remove these comments automatically without asking user:

```typescript
// ❌ REMOVE: Restates the code
counter++; // increment counter
let x = 0; // initialize variable
return result; // return result
doThing(); // call function
if (x !== null) // check if null
arr.push(item); // add to array
const sum = a + b; // add numbers
await fetchData(); // fetch data
user.save(); // save user
break; // exit loop

// ❌ REMOVE: Closing brace comments
} // end if
} // end function
} // end class

// ❌ REMOVE: Section markers for tiny blocks
// --- begin validation ---
if (x > 0) { }
// --- end validation ---
```

## JSDoc Slop (FLAG for removal)

```typescript
// ❌ Restates function name
/**
 * Gets the user
 */
function getUser() {}

// ❌ Restates parameter types
/**
 * @param name - the name string
 * @param age - the age number
 */
function createUser(name: string, age: number) {}

// ❌ Adds no value
/**
 * Constructor
 */
constructor() {}

// ✅ GOOD: Non-obvious behavior
/**
 * Returns cached user if available, otherwise fetches from API.
 * Cache expires after 5 minutes.
 */
function getUser(id: string) {}
```

## Over-Abstraction Slop (FLAG)

```typescript
// ❌ Interface with single implementation
interface IUserService {}
class UserService implements IUserService {}
// (no other implementors exist)

// ❌ Factory for trivial object
class UserFactory {
    create(name: string): User {
        return new User(name); // Just use `new User(name)` directly
    }
}

// ❌ Wrapper that just passes through
class ApiWrapper {
    private api: Api;
    getData() {
        return this.api.getData();
    }
    postData(d) {
        return this.api.postData(d);
    }
}

// ❌ Strategy pattern for 2 variants
interface SortStrategy {
    sort(arr: number[]): number[];
}
class AscendingSort implements SortStrategy {}
class DescendingSort implements SortStrategy {}
// Just use a boolean flag or enum

// ❌ Generic where concrete would suffice
function processData<T>(data: T): T {
    return data;
}
// T is always the same type in actual usage
```

## Vibe-Coding Slop (FLAG)

```typescript
// ❌ Deferred work without issue reference
// TODO: fix this later
// FIXME: temporary hack
// HACK: need to refactor

// ❌ Magic numbers
setTimeout(callback, 86400000); // What is this?
if (retries > 3) {
} // Why 3?
const CHUNK_SIZE = 1048576; // Explain or name better

// ❌ Copy-paste with variations
function processUserA(user) {
    /* 50 lines */
}
function processUserB(user) {
    /* same 50 lines with minor diff */
}

// ❌ Inconsistent naming
function getUserData() {}
function fetchAccountInfo() {}
function load_profile_settings() {}

// ❌ Empty catch blocks
try {
    riskyOperation();
} catch (e) {
    console.log(e); // Swallows error
}

// ❌ Unclear variable names
const data = await fetch();
const result = process(data);
const temp = transform(result);
return temp;
```

## Documentation Slop (FLAG)

```typescript
// ❌ Self-referential
/**
 * This function does what its name suggests
 */

// ❌ Commented-out code blocks
// function oldImplementation() {
//     // 50 lines of dead code
// }

// ❌ Changelog in comments
// v1.0 - Initial implementation
// v1.1 - Added validation
// v2.0 - Refactored for performance

// ❌ Author attributions in code
// Written by: John Doe
// Last modified: 2024-01-15
```

## Over-Engineering Slop (FLAG)

Patterns especially common with Claude Opus 4.6:

```typescript
// ❌ Unnecessary try-catch wrapping entire tool execute()
// ToolExecutor already handles CancellationError, TimeoutError, and generic errors
async execute(args: Args, context: ExecutionContext): Promise<ToolResult> {
    try {
        // ... entire implementation
    } catch (error) {
        rethrowIfCancellationOrTimeout(error);
        return toolError(`Failed: ${error}`);
    }
}
// Just let errors propagate to ToolExecutor

// ❌ Options objects with parameters never used by any caller
interface DiscoverOptions {
    maxDepth?: number;         // Always left as default
    includeHidden?: boolean;   // Never passed by anyone
    timeout?: number;          // Already handled elsewhere
}

// ❌ Defensive validation at non-system boundaries
function processFile(file: ParsedFile): Result {
    if (!file) throw new Error('file is required');        // Type system guarantees this
    if (!file.path) throw new Error('path is required');   // Already validated at input
    // ...
}

// ❌ Wrapper class that just delegates to the wrapped object
class GitServiceWrapper {
    constructor(private git: GitOperationsManager) {}
    getStatus() { return this.git.getStatus(); }
    getDiff() { return this.git.getDiff(); }
    // No added logic, just delegation
}
// Just use GitOperationsManager directly
```

## Verbose Naming Slop (FLAG)

```typescript
// ❌ Function names that describe implementation steps instead of intent
function iterateOverFilesAndCollectSymbols() {} // → extractSymbols()
function parseJsonStringAndValidateSchema() {} // → validateConfig()
function loopThroughResultsAndFilterValid() {} // → filterValid()

// ❌ Redundant type info in variable names
const userArray: User[] = []; // → users
const nameString: string = 'hello'; // → name
const isActiveBoolean = true; // → isActive
const countNumber = 0; // → count

// ❌ Over-qualified names
function createNewInstanceOfAnalysisEngine() {} // → createAnalysisEngine()
class AbstractBaseToolFactory {} // → ToolFactory
const currentActiveUserSession = {}; // → session
```

## Detection Rules

For each pattern, assess:

1. **Confidence**: Is this definitely slop or borderline?
2. **Impact**: Does removal improve readability?
3. **Context**: Is there unusual reason for the pattern?

**Auto-remove only HIGH confidence, positive impact patterns.**

## Severity Mapping

| Pattern               | Severity | Action                 |
| --------------------- | -------- | ---------------------- |
| Obvious comments      | LOW      | AUTO-REMOVE            |
| JSDoc restating types | LOW      | FLAG                   |
| Over-abstraction      | MEDIUM   | FLAG                   |
| Magic numbers         | MEDIUM   | FLAG                   |
| Empty catch blocks    | HIGH     | FLAG (potential bug)   |
| Copy-paste code       | HIGH     | FLAG (DRY violation)   |
| Deferred TODOs        | LOW      | FLAG (if no issue ref) |
| Unnecessary try-catch | MEDIUM   | FLAG                   |
| Unused options params | LOW      | FLAG                   |
| Redundant validation  | LOW      | FLAG                   |
| Delegation wrappers   | MEDIUM   | FLAG                   |
| Implementation naming | LOW      | FLAG                   |
| Type-in-name          | LOW      | FLAG                   |
| Over-qualified names  | LOW      | FLAG                   |

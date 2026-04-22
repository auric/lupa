# BUG-001: Race Condition in `sleepWithCancellation`

**File:** `src/models/conversationRunner.ts:1069–1088`  
**Severity:** High  
**Impact:** Affects eval harness and all async timeout/cancellation paths. Can cause double-resolution, listener leaks, or hung promises under timing pressure.  
**Discovered:** Code review during Wave 0 eval implementation.  
**Not covered by any Quest.**

---

## The Code (Current)

```typescript
private sleepWithCancellation(
    ms: number,
    token: vscode.CancellationToken
): Promise<void> {
    if (token.isCancellationRequested) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        let cleanupTimer: NodeJS.Timeout | undefined;
        const disposable = token.onCancellationRequested(() => {
            clearTimeout(timer);
            clearTimeout(cleanupTimer);
            disposable.dispose();
            resolve();
        });
        // Clean up listener when timer fires normally
        cleanupTimer = setTimeout(() => disposable.dispose(), ms + 1);
    });
}
```

---

## The Problem: Three Race Conditions in One

### Race 1: `cleanupTimer` is Undefined When Cancellation Fires Immediately

Look at the order of operations:

1. `const timer = setTimeout(resolve, ms);` ← `timer` exists
2. `let cleanupTimer: NodeJS.Timeout | undefined;` ← `cleanupTimer` is `undefined`
3. `const disposable = token.onCancellationRequested(() => { ... });` ← listener registered
4. `cleanupTimer = setTimeout(() => disposable.dispose(), ms + 1);` ← `cleanupTimer` assigned

If `token.isCancellationRequested` is already true at step 3, VS Code may invoke the callback **synchronously** (before step 4). Inside the handler:

```typescript
clearTimeout(timer); // ✓ works
clearTimeout(cleanupTimer); // ✗ cleanupTimer is undefined → no-op
disposable.dispose(); // ✓ disposes listener
resolve(); // ✓ resolves promise
```

The `cleanupTimer` scheduled at step 4 is never cleared. It fires at `ms + 1` and tries to `disposable.dispose()` a listener that was already disposed. While `dispose()` is typically idempotent, this is a **resource leak pattern** and depends on VS Code's `Disposable` implementation being perfectly safe for double-dispose.

### Race 2: Double `resolve()` When Timer and Cancellation Fire Together

Both the normal timer and the cancellation handler call `resolve()`:

```typescript
const timer = setTimeout(resolve, ms); // Path A: normal completion
// ...
resolve(); // Path B: cancellation
```

If cancellation is requested at the exact moment the timer fires, both paths execute. Promises ignore second `resolve()` calls, but this means:

- The state machine has **two exit paths running concurrently**.
- Any side effects attached to resolution (in the caller) could be invoked in an unpredictable order.
- In the eval harness, this can cause **double-counting of iterations** or **premature pipeline termination**.

### Race 3: `disposable.dispose()` Called Twice

The listener disposal has two triggers:

1. Cancellation handler: `disposable.dispose()`
2. Cleanup timer: `disposable.dispose()`

If cancellation fires first (Race 1), the cleanup timer is never cleared. It fires later and calls `dispose()` again. If the timer fires normally and then cancellation fires in the 1ms window before the cleanup timer, both paths call `dispose()`.

Again: idempotent in theory, but this is a classic pattern that breaks when the underlying disposable isn't perfectly re-entrant.

---

## Why It Matters for the Eval Harness

The eval harness (`Quest 8.1`/`8.2`) runs many iterations with tight deadlines. `sleepWithCancellation` is used for:

- Per-iteration timeout enforcement
- Graceful shutdown of the resolution classifier
- Delay between retries

Under timing pressure (high CPU, many fixtures), the races above manifest as:

- **Ghost iterations:** Promise resolves twice, causing the runner to think an iteration completed when it was actually cancelled.
- **Listener leaks:** Each leaked listener consumes memory; in a 100-fixture eval run, this accumulates.
- **Hangs:** If `dispose()` throws during a race, the exception bubbles up uncaught and kills the eval runner.

**This corrupts your baseline.** If 3% of eval runs fail due to this bug, you can't tell whether a regression is real or just noise.

---

## The Fix (Conceptual)

Use a single atomic flag to guarantee resolution and cleanup happen **exactly once**:

```typescript
private sleepWithCancellation(
    ms: number,
    token: vscode.CancellationToken
): Promise<void> {
    if (token.isCancellationRequested) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let resolved = false;                    // ← atomic flag

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve();
            }
        }, ms);

        const disposable = token.onCancellationRequested(() => {
            clearTimeout(timer);
            if (!resolved) {
                resolved = true;
                resolve();
            }
            disposable.dispose();                // safe: listener removes itself
        });
    });
}
```

### Why This Fixes It

1. **`resolved` flag:** Guarantees `resolve()` is called exactly once, eliminating Race 2.
2. **No `cleanupTimer`:** The listener disposes itself in its own handler. No second timer means no Race 1 or Race 3.
3. **`clearTimeout(timer)` in cancellation path:** Ensures the normal timer doesn't fire after cancellation.
4. **Simpler:** 8 lines instead of 12. Fewer moving parts = fewer races.

### Alternative Fix (If You Need cleanupTimer for Other Reasons)

If you must keep the cleanup timer (e.g., to handle tokens that don't auto-dispose listeners), ensure `cleanupTimer` is assigned **before** registering the cancellation listener:

```typescript
return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => { ... }, ms);
    const cleanupTimer = setTimeout(() => disposable.dispose(), ms + 1);
    // ↑ assign BEFORE registering listener
    const disposable = token.onCancellationRequested(() => {
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        if (!resolved) { resolved = true; resolve(); }
        disposable.dispose();
    });
});
```

But the first fix (no cleanup timer) is preferred — it's simpler and equally correct.

---

## Testing the Fix

Before merging, run the eval harness twice:

```bash
# Baseline (before fix)
npm run eval -- --fixtures=all --models=copilot-gpt-4.1
# Note the success rate and any "iteration leaked" warnings

# After fix
npm run eval -- --fixtures=all --models=copilot-gpt-4.1
# Success rate should be stable; no leaked listener warnings
```

Also add a unit test for the race:

```typescript
it('resolves exactly once when cancellation races with timer', async () => {
    const source = new vscode.CancellationTokenSource();
    const sleep = runner['sleepWithCancellation'](10, source.token);

    // Cancel at exactly the 10ms boundary
    setTimeout(() => source.cancel(), 10);

    await sleep;
    // Should resolve cleanly, not throw or hang
});
```

---

## Related Code

- `src/models/conversationRunner.ts` — main usage site
- `src/eval/headlessRunner.ts` — uses this for eval iteration pacing
- `src/eval/headlessJudge.ts` — uses this for judge timeout

---

## Decision Log

| Date       | Decision                              | Rationale                                  |
| ---------- | ------------------------------------- | ------------------------------------------ |
| 2026-04-22 | Fix in current PR (Wave 0)            | Corrupts eval baseline; no quest covers it |
| 2026-04-22 | Use atomic flag fix (no cleanupTimer) | Simpler, fewer edge cases                  |

---

## After Fix

Move this item to the "Resolved" section of `wave-12-discovered-issues.md` and reference the commit hash.

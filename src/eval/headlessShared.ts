export function normalizeModelIdentifier(identifier: string): string {
    const trimmed = identifier.trim().toLowerCase();
    if (trimmed.includes('/')) {
        return trimmed;
    }
    return `copilot/${trimmed}`;
}

export function createHeadlessDeadline(timeoutMs: number): number {
    return Date.now() + timeoutMs;
}

export function getRemainingHeadlessBudgetMs(
    timeoutMs: number,
    deadlineAt: number | undefined,
    now: number = Date.now()
): number {
    if (deadlineAt === undefined) {
        return timeoutMs;
    }
    return Math.max(0, deadlineAt - now);
}

export function formatHeadlessTimeoutMessage(
    timeoutMs: number,
    phase: string
): string {
    return `Headless run exceeded timeout (${timeoutMs}ms) ${phase}.`;
}

export function requireRemainingHeadlessBudgetMs(
    timeoutMs: number,
    deadlineAt: number | undefined,
    phase: string,
    now: number = Date.now()
): number {
    const remainingMs = getRemainingHeadlessBudgetMs(
        timeoutMs,
        deadlineAt,
        now
    );
    if (remainingMs <= 0) {
        throw new Error(formatHeadlessTimeoutMessage(timeoutMs, phase));
    }
    return remainingMs;
}

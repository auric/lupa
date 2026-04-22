export function normalizeModelIdentifier(identifier: string): string {
    const trimmed = identifier.trim();
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex === -1) {
        return `copilot/${trimmed}`;
    }

    const vendor = trimmed.slice(0, slashIndex).trim().toLowerCase();
    const id = trimmed.slice(slashIndex + 1).trim();
    if (vendor.length === 0 || id.length === 0) {
        return trimmed;
    }

    return `${vendor}/${id}`;
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

import * as path from 'node:path';
import * as vscode from 'vscode';

export function normalizeModelIdentifier(identifier: string): string {
    const trimmed = identifier.trim();
    if (trimmed.length === 0) {
        throw new Error('Model identifier must be a non-empty string.');
    }

    const slashIndex = trimmed.indexOf('/');
    if (slashIndex === -1) {
        return `copilot/${trimmed}`;
    }

    const vendor = trimmed.slice(0, slashIndex).trim().toLowerCase();
    const id = trimmed.slice(slashIndex + 1).trim();
    if (vendor.length === 0 || id.length === 0) {
        throw new Error(
            `Malformed model identifier '${trimmed}'. Use '<model-id>' or '<vendor>/<model-id>' with non-empty vendor and model segments.`
        );
    }

    return `${vendor}/${id}`;
}

export function normalizeWorkspaceRelativePath(
    filePath: unknown,
    workspaceRoot: string | undefined
): string {
    const trimmed = getTrimmedPathString(filePath);
    if (trimmed.length === 0) {
        return '';
    }

    if (workspaceRoot && isAbsolutePathLike(trimmed)) {
        const relativePath = path.relative(workspaceRoot, trimmed);
        if (
            relativePath.length > 0 &&
            !isAbsolutePathLike(relativePath) &&
            !relativePath.startsWith('..')
        ) {
            return normalizePosixPath(relativePath);
        }
    }

    return normalizePosixPath(trimmed);
}

export function isWorkspaceRelativePath(filePath: unknown): boolean {
    const trimmed = getTrimmedPathString(filePath);
    if (trimmed.length === 0 || hasUnsafeWorkspacePathPrefix(trimmed)) {
        return false;
    }

    const normalized = normalizePosixPath(trimmed);
    return (
        normalized.length > 0 &&
        !hasUnsafeWorkspacePathPrefix(normalized) &&
        !isAbsolutePathLike(normalized) &&
        normalized !== '..' &&
        !normalized.startsWith('../')
    );
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

export function formatHeadlessCancellationMessage(phase: string): string {
    return `Headless run cancelled ${phase}.`;
}

export function validateRef(ref: string, fieldName: string): void {
    if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error(`${fieldName}: must be a non-empty string`);
    }
    if (ref.startsWith('-')) {
        throw new Error(
            `${fieldName}: starts with '-', which is not allowed — got '${ref}'`
        );
    }
    const hasScheme = ref.startsWith('dir:') || ref.startsWith('sha:');
    if (hasScheme) {
        const body = ref.slice(ref.indexOf(':') + 1);
        if (body.length === 0) {
            throw new Error(
                `${fieldName}: empty body after scheme — got '${ref}'`
            );
        }
        // NOTE: This regex limits SHAs to 40 hex chars (SHA-1).
        // If Git SHA-256 repos become common, increase the limit to 64.
        if (ref.startsWith('sha:') && !/^[0-9a-fA-F]{1,40}$/.test(body)) {
            throw new Error(`${fieldName}: invalid SHA format — got '${ref}'`);
        }
        return;
    }
    if (!hasScheme && ref.includes('..')) {
        throw new Error(
            `${fieldName}: contains '..' range operator — got '${ref}'`
        );
    }
    for (let i = 0; i < ref.length; i++) {
        const code = ref.charCodeAt(i);
        if (code <= 0x1f || code === 0x20) {
            throw new Error(
                `${fieldName}: contains whitespace or control characters — got '${ref}'`
            );
        }
    }
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

export interface HeadlessBudgetAwaitOptions {
    timeoutMs: number;
    deadlineAt?: number;
    phase: string;
    cancellationToken?: vscode.CancellationToken;
    onBudgetExceeded?: () => void;
}

function createHeadlessBudgetExceededError(
    timeoutMs: number,
    phase: string
): Error {
    return new Error(formatHeadlessTimeoutMessage(timeoutMs, phase));
}

function createHeadlessBudgetCancellationError(phase: string): Error {
    return new Error(formatHeadlessCancellationMessage(phase));
}

export async function awaitWithinHeadlessBudget<T>(
    promise: Promise<T>,
    opts: HeadlessBudgetAwaitOptions
): Promise<T> {
    const remainingMs = getRemainingHeadlessBudgetMs(
        opts.timeoutMs,
        opts.deadlineAt
    );
    if (remainingMs <= 0) {
        opts.onBudgetExceeded?.();
        throw createHeadlessBudgetExceededError(opts.timeoutMs, opts.phase);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancellationDisposable: vscode.Disposable | undefined;
    let budgetExceeded = false;

    promise.catch(() => {});

    const racers: Promise<T | never>[] = [promise];

    if (opts.cancellationToken) {
        const cancellationPromise = new Promise<never>((_, reject) => {
            cancellationDisposable =
                opts.cancellationToken?.onCancellationRequested(() => {
                    if (budgetExceeded) {
                        return;
                    }
                    reject(createHeadlessBudgetCancellationError(opts.phase));
                });
        });
        cancellationPromise.catch(() => {});
        racers.push(cancellationPromise);

        if (opts.cancellationToken.isCancellationRequested) {
            cancellationDisposable?.dispose();
            throw createHeadlessBudgetCancellationError(opts.phase);
        }
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            budgetExceeded = true;
            reject(
                createHeadlessBudgetExceededError(opts.timeoutMs, opts.phase)
            );
            opts.onBudgetExceeded?.();
        }, remainingMs);
    });
    timeoutPromise.catch(() => {});
    racers.push(timeoutPromise);

    try {
        return await Promise.race(racers);
    } finally {
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
        cancellationDisposable?.dispose();
    }
}

function isAbsolutePathLike(filePath: string): boolean {
    return (
        path.isAbsolute(filePath) ||
        /^[a-zA-Z]:[\\/]/.test(filePath) ||
        filePath.startsWith('\\\\')
    );
}

function getTrimmedPathString(filePath: unknown): string {
    return typeof filePath === 'string' ? filePath.trim() : '';
}

function hasUnsafeWorkspacePathPrefix(filePath: string): boolean {
    return (
        /^[a-zA-Z][a-zA-Z\d+.-]*:(?:\/\/|\/)/.test(filePath) ||
        /^[a-zA-Z]:/.test(filePath) ||
        filePath.startsWith(':')
    );
}

function normalizePosixPath(filePath: string): string {
    const normalized = path.posix
        .normalize(filePath.replace(/\\/g, '/'))
        .replace(/^(?:\.\/)+/, '');
    return normalized === '.' ? '' : normalized;
}

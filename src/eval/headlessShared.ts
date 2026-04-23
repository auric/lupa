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
    filePath: string,
    workspaceRoot: string | undefined
): string {
    const trimmed = filePath.trim();
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

export interface HeadlessBudgetAwaitOptions {
    timeoutMs: number;
    deadlineAt?: number;
    phase: string;
    cancellationToken?: vscode.CancellationToken;
}

function createHeadlessBudgetExceededError(
    timeoutMs: number,
    phase: string
): Error {
    return new Error(formatHeadlessTimeoutMessage(timeoutMs, phase));
}

export async function awaitWithinHeadlessBudget<T>(
    promise: Promise<T>,
    opts: HeadlessBudgetAwaitOptions
): Promise<T> {
    const remainingMs = requireRemainingHeadlessBudgetMs(
        opts.timeoutMs,
        opts.deadlineAt,
        opts.phase
    );

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancellationDisposable: vscode.Disposable | undefined;

    promise.catch(() => {});

    const racers: Promise<T | never>[] = [promise];

    if (opts.cancellationToken) {
        const cancellationPromise = new Promise<never>((_, reject) => {
            cancellationDisposable =
                opts.cancellationToken?.onCancellationRequested(() => {
                    reject(
                        createHeadlessBudgetExceededError(
                            opts.timeoutMs,
                            opts.phase
                        )
                    );
                });
        });
        cancellationPromise.catch(() => {});
        racers.push(cancellationPromise);

        if (opts.cancellationToken.isCancellationRequested) {
            cancellationDisposable?.dispose();
            throw createHeadlessBudgetExceededError(opts.timeoutMs, opts.phase);
        }
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(
                createHeadlessBudgetExceededError(opts.timeoutMs, opts.phase)
            );
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

function normalizePosixPath(filePath: string): string {
    const normalized = path.posix
        .normalize(filePath.replace(/\\/g, '/'))
        .replace(/^(?:\.\/)+/, '');
    return normalized === '.' ? '' : normalized;
}

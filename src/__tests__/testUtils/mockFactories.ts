/**
 * Shared test utilities and mock factories for DRY test setup.
 * These utilities centralize common mock patterns used across test files.
 */
import { vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    ANALYSIS_LIMITS,
    SUBAGENT_LIMITS,
} from '../../models/workspaceSettingsSchema';
import type { WorkspaceSettingsService } from '../../services/workspaceSettingsService';
import type { ExecutionContext } from '../../types/executionContext';

/**
 * Creates a mock Position object with proper comparison methods.
 * Use this instead of plain objects when tests need Position.isBefore/isAfter.
 */
export function createMockPosition(
    line: number,
    character: number
): vscode.Position {
    const pos = {
        line,
        character,
        isBefore: function (other: vscode.Position): boolean {
            return (
                line < other.line ||
                (line === other.line && character < other.character)
            );
        },
        isBeforeOrEqual: function (other: vscode.Position): boolean {
            return (
                line < other.line ||
                (line === other.line && character <= other.character)
            );
        },
        isAfter: function (other: vscode.Position): boolean {
            return (
                line > other.line ||
                (line === other.line && character > other.character)
            );
        },
        isAfterOrEqual: function (other: vscode.Position): boolean {
            return (
                line > other.line ||
                (line === other.line && character >= other.character)
            );
        },
        isEqual: function (other: vscode.Position): boolean {
            return line === other.line && character === other.character;
        },
        compareTo: function (other: vscode.Position): number {
            if (line < other.line) {
                return -1;
            }
            if (line > other.line) {
                return 1;
            }
            if (character < other.character) {
                return -1;
            }
            if (character > other.character) {
                return 1;
            }
            return 0;
        },
        translate: function (
            lineDeltaOrChange?:
                | number
                | { lineDelta?: number; characterDelta?: number },
            characterDelta?: number
        ): vscode.Position {
            let newLine = line;
            let newChar = character;
            if (typeof lineDeltaOrChange === 'number') {
                newLine += lineDeltaOrChange;
                newChar += characterDelta ?? 0;
            } else if (lineDeltaOrChange) {
                newLine += lineDeltaOrChange.lineDelta ?? 0;
                newChar += lineDeltaOrChange.characterDelta ?? 0;
            }
            return createMockPosition(newLine, newChar);
        },
        with: function (
            lineOrChange?: number | { line?: number; character?: number },
            newCharacter?: number
        ): vscode.Position {
            let newLine = line;
            let newChar = character;
            if (typeof lineOrChange === 'number') {
                newLine = lineOrChange;
                if (newCharacter !== undefined) {
                    newChar = newCharacter;
                }
            } else if (lineOrChange) {
                if (lineOrChange.line !== undefined) {
                    newLine = lineOrChange.line;
                }
                if (lineOrChange.character !== undefined) {
                    newChar = lineOrChange.character;
                }
            }
            return createMockPosition(newLine, newChar);
        },
    };
    return pos as vscode.Position;
}

/**
 * Creates a mock Range object with proper Position objects and methods.
 * Use this instead of plain objects when tests need Range.contains or Position.isBefore/isAfter.
 */
export function createMockRange(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number
): vscode.Range {
    const start = createMockPosition(startLine, startCharacter);
    const end = createMockPosition(endLine, endCharacter);

    const range = {
        start,
        end,
        isEmpty: start.isEqual(end),
        isSingleLine: startLine === endLine,
        contains: function (
            positionOrRange: vscode.Position | vscode.Range
        ): boolean {
            if ('start' in positionOrRange && 'end' in positionOrRange) {
                // It's a range
                const r = positionOrRange as vscode.Range;
                return !r.start.isBefore(start) && !r.end.isAfter(end);
            }
            // It's a position
            const p = positionOrRange as vscode.Position;
            return !p.isBefore(start) && !p.isAfter(end);
        },
        isEqual: function (other: vscode.Range): boolean {
            return start.isEqual(other.start) && end.isEqual(other.end);
        },
        intersection: function (other: vscode.Range): vscode.Range | undefined {
            const newStart = start.isBefore(other.start) ? other.start : start;
            const newEnd = end.isBefore(other.end) ? end : other.end;
            if (newStart.isBefore(newEnd) || newStart.isEqual(newEnd)) {
                return createMockRange(
                    newStart.line,
                    newStart.character,
                    newEnd.line,
                    newEnd.character
                );
            }
            return undefined;
        },
        union: function (other: vscode.Range): vscode.Range {
            const newStart = start.isBefore(other.start) ? start : other.start;
            const newEnd = end.isAfter(other.end) ? end : other.end;
            return createMockRange(
                newStart.line,
                newStart.character,
                newEnd.line,
                newEnd.character
            );
        },
        with: function (
            startOrChange?:
                | vscode.Position
                | { start?: vscode.Position; end?: vscode.Position },
            newEnd?: vscode.Position
        ): vscode.Range {
            let newStart = start;
            let finalEnd = end;
            if (startOrChange && 'line' in startOrChange) {
                newStart = startOrChange as vscode.Position;
                if (newEnd) {
                    finalEnd = newEnd;
                }
            } else if (startOrChange) {
                const change = startOrChange as {
                    start?: vscode.Position;
                    end?: vscode.Position;
                };
                if (change.start) {
                    newStart = change.start;
                }
                if (change.end) {
                    finalEnd = change.end;
                }
            }
            return createMockRange(
                newStart.line,
                newStart.character,
                finalEnd.line,
                finalEnd.character
            );
        },
    };
    return range as vscode.Range;
}

/**
 * Creates a mock DocumentSymbol with proper Range objects.
 * Use this for tests that access symbol.range or symbol.selectionRange methods.
 */
export function createMockDocumentSymbol(options: {
    name: string;
    kind: number;
    range: {
        startLine: number;
        startChar: number;
        endLine: number;
        endChar: number;
    };
    selectionRange?: {
        startLine: number;
        startChar: number;
        endLine: number;
        endChar: number;
    };
    children?: vscode.DocumentSymbol[];
    detail?: string;
}): vscode.DocumentSymbol {
    const {
        name,
        kind,
        range: r,
        selectionRange: sr,
        children = [],
        detail = '',
    } = options;

    const rangeObj = createMockRange(
        r.startLine,
        r.startChar,
        r.endLine,
        r.endChar
    );
    const selectionRangeObj = sr
        ? createMockRange(sr.startLine, sr.startChar, sr.endLine, sr.endChar)
        : rangeObj;

    return {
        name,
        kind,
        range: rangeObj,
        selectionRange: selectionRangeObj,
        children,
        detail,
        tags: [],
    } as vscode.DocumentSymbol;
}

/**
 * Creates a mock SymbolInformation (workspace symbol).
 */
export function createMockSymbolInformation(options: {
    name: string;
    kind: number;
    uri: string | { toString: () => string; fsPath: string };
    range: {
        startLine: number;
        startChar: number;
        endLine: number;
        endChar: number;
    };
    containerName?: string;
}): vscode.SymbolInformation {
    const { name, kind, uri, range: r, containerName = '' } = options;

    const uriObj =
        typeof uri === 'string'
            ? { toString: () => uri, fsPath: uri.replace('file://', '') }
            : uri;

    return {
        name,
        kind,
        containerName,
        location: {
            uri: uriObj,
            range: createMockRange(
                r.startLine,
                r.startChar,
                r.endLine,
                r.endChar
            ),
        },
    } as vscode.SymbolInformation;
}

/**
 * Creates a mock CancellationTokenSource that properly tracks cancellation state.
 * The returned token supports listeners and manual cancellation for testing.
 * Vitest 4 requires function syntax for constructor mocks.
 *
 * Behavior matches VS Code's CancellationToken:
 * - If already cancelled when listener subscribes, listener is invoked immediately
 * - Listeners are cleared after firing to prevent double-calls
 */
export function createMockCancellationTokenSource(): vscode.CancellationTokenSource {
    const listeners: Array<(e: any) => any> = [];
    let isCancelled = false;

    const token: vscode.CancellationToken = {
        get isCancellationRequested() {
            return isCancelled;
        },
        onCancellationRequested: vi.fn(function (listener: (e: any) => any) {
            // If already cancelled, invoke listener immediately (matches VS Code behavior)
            if (isCancelled) {
                queueMicrotask(() => listener(undefined));
            } else {
                listeners.push(listener);
            }
            return {
                dispose: vi.fn(function () {
                    const index = listeners.indexOf(listener);
                    if (index !== -1) {
                        listeners.splice(index, 1);
                    }
                }),
            };
        }) as any,
    };

    return {
        token,
        cancel: vi.fn(function () {
            if (isCancelled) {
                return; // Prevent double-firing
            }
            isCancelled = true;
            const toFire = [...listeners];
            listeners.length = 0; // Clear listeners after firing
            toFire.forEach(function (listener) {
                listener(undefined);
            });
        }),
        dispose: vi.fn(),
    } as vscode.CancellationTokenSource;
}

/**
 * Creates a mock fdir instance for file discovery tests.
 * Returns an object that mimics fdir's fluent API with crawl() returning a separate result object.
 */
export function createMockFdirInstance(returnValue: string[] = []) {
    // The crawl result has withPromise/sync methods
    const crawlResult = {
        withPromise: vi.fn().mockResolvedValue(returnValue),
        sync: vi.fn().mockReturnValue(returnValue),
    };
    const instance = {
        withGlobFunction: vi.fn().mockReturnThis(),
        glob: vi.fn().mockReturnThis(),
        globWithOptions: vi.fn().mockReturnThis(),
        withRelativePaths: vi.fn().mockReturnThis(),
        withFullPaths: vi.fn().mockReturnThis(),
        withAbortSignal: vi.fn().mockReturnThis(),
        exclude: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        crawl: vi.fn().mockReturnValue(crawlResult),
        // Expose for test assertions
        withPromise: crawlResult.withPromise,
        sync: crawlResult.sync,
    };
    // Make chainable methods return the instance (except crawl which returns crawlResult)
    instance.withGlobFunction.mockReturnValue(instance);
    instance.glob.mockReturnValue(instance);
    instance.globWithOptions.mockReturnValue(instance);
    instance.withRelativePaths.mockReturnValue(instance);
    instance.withFullPaths.mockReturnValue(instance);
    instance.withAbortSignal.mockReturnValue(instance);
    instance.exclude.mockReturnValue(instance);
    instance.filter.mockReturnValue(instance);
    return instance as any;
}

/**
 * Creates a mock Git repository object.
 */
export function createMockGitRepository(
    gitRootPath: string = '/test/git-repo'
) {
    return {
        rootUri: {
            fsPath: gitRootPath,
        },
    };
}

/**
 * Creates a mock text document with configurable content.
 */
export function createMockDocument(
    options: {
        content?: string;
        uri?: string;
        lineCount?: number;
    } = {}
) {
    const {
        content = 'mocked document text',
        uri = 'file:///test.ts',
        lineCount = 100,
    } = options;

    const lines = content.split('\n');

    return {
        getText: vi.fn().mockImplementation((range?: any) => {
            if (!range) {
                return content;
            }
            // Simplified range extraction
            const startLine = range.start?.line ?? 0;
            const endLine = range.end?.line ?? lines.length - 1;
            return lines.slice(startLine, endLine + 1).join('\n');
        }),
        lineAt: vi.fn().mockImplementation((lineOrPosition: number | any) => {
            const lineNum =
                typeof lineOrPosition === 'number'
                    ? lineOrPosition
                    : lineOrPosition.line;
            return {
                text: lines[lineNum] ?? '',
                lineNumber: lineNum,
                range: {
                    start: { line: lineNum, character: 0 },
                    end: {
                        line: lineNum,
                        character: (lines[lineNum] ?? '').length,
                    },
                },
                rangeIncludingLineBreak: {
                    start: { line: lineNum, character: 0 },
                    end: { line: lineNum + 1, character: 0 },
                },
                firstNonWhitespaceCharacterIndex: (lines[lineNum] ?? '').search(
                    /\S/
                ),
                isEmptyOrWhitespace: !(lines[lineNum] ?? '').trim(),
            };
        }),
        uri: { toString: () => uri, fsPath: uri.replace('file://', '') },
        lineCount: lineCount || lines.length,
    };
}

/**
 * Creates a mock RipgrepSearchService for pattern search tests.
 */
export function createMockRipgrepService() {
    return {
        search: vi.fn(),
        formatResults: vi.fn(),
    };
}

/**
 * Standard mock for GitOperationsManager.
 */
export function createMockGitOperationsManager(
    gitRootPath: string = '/test/git-repo'
) {
    const mockGetRepository = vi
        .fn()
        .mockReturnValue(createMockGitRepository(gitRootPath));
    return {
        getRepository: mockGetRepository,
        _mockGetRepository: mockGetRepository, // Expose for test manipulation
    };
}

/**
 * Standard mock for WorkspaceSettingsService.
 */
export function createMockWorkspaceSettings(
    overrides: Partial<{
        maxIterations: number;
        requestTimeoutSeconds: number;
        maxSubagentsPerSession: number;
    }> = {}
): WorkspaceSettingsService {
    return {
        getMaxIterations: () =>
            overrides.maxIterations ?? ANALYSIS_LIMITS.maxIterations.default,
        getRequestTimeoutSeconds: () =>
            overrides.requestTimeoutSeconds ??
            ANALYSIS_LIMITS.requestTimeoutSeconds.default,
        getMaxSubagentsPerSession: () =>
            overrides.maxSubagentsPerSession ??
            SUBAGENT_LIMITS.maxPerSession.default,
    } as WorkspaceSettingsService;
}

/**
 * Standard mock for CopilotModelManager.
 */
export function createMockCopilotModelManager() {
    return {
        sendRequest: vi.fn(),
        getCurrentModel: vi.fn().mockResolvedValue({
            countTokens: vi.fn().mockResolvedValue(100),
            maxInputTokens: 8000,
        }),
    };
}

/**
 * Creates a mock CancellationToken for simple use cases where a full
 * CancellationTokenSource is not needed.
 *
 * @param cancelled Whether the token should be pre-cancelled (default: false)
 * @returns A mock CancellationToken
 */
export function createMockCancellationToken(
    cancelled = false
): vscode.CancellationToken {
    const source = createMockCancellationTokenSource();
    if (cancelled) {
        source.cancel();
    }
    return source.token;
}

/**
 * Creates a standard mock ExecutionContext for tool testing.
 * Includes a non-cancelled token by default.
 *
 * Use this factory in all tool tests to ensure consistent ExecutionContext handling.
 *
 * @param overrides Optional partial ExecutionContext to override defaults
 * @returns A complete ExecutionContext with required cancellationToken
 */
export function createMockExecutionContext(
    overrides: Partial<ExecutionContext> = {}
): ExecutionContext {
    const tokenSource = createMockCancellationTokenSource();
    return {
        cancellationToken: tokenSource.token,
        planManager: undefined,
        subagentSessionManager: undefined,
        subagentExecutor: undefined,
        ...overrides,
    };
}

/**
 * Creates a pre-cancelled ExecutionContext for testing cancellation flows.
 * The cancellationToken.isCancellationRequested will be true.
 *
 * @param overrides Optional partial ExecutionContext to override defaults
 * @returns An ExecutionContext with a cancelled token
 */
export function createCancelledExecutionContext(
    overrides: Partial<ExecutionContext> = {}
): ExecutionContext {
    const tokenSource = createMockCancellationTokenSource();
    tokenSource.cancel();
    return {
        cancellationToken: tokenSource.token,
        planManager: undefined,
        subagentSessionManager: undefined,
        subagentExecutor: undefined,
        ...overrides,
    };
}

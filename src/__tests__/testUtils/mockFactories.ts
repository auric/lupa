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

/**
 * Creates a mock CancellationTokenSource that properly tracks cancellation state.
 * The returned token supports listeners and manual cancellation for testing.
 * Vitest 4 requires function syntax for constructor mocks.
 */
export function createMockCancellationTokenSource(): vscode.CancellationTokenSource {
    const listeners: Array<(e: any) => any> = [];
    let isCancelled = false;

    const token: vscode.CancellationToken = {
        get isCancellationRequested() {
            return isCancelled;
        },
        onCancellationRequested: vi.fn(function (listener: (e: any) => any) {
            listeners.push(listener);
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
            isCancelled = true;
            [...listeners].forEach(function (listener) {
                listener(undefined);
            });
        }),
        dispose: vi.fn(),
    } as vscode.CancellationTokenSource;
}

/**
 * Creates a mock fdir instance for file discovery tests.
 * Returns an object that mimics fdir's fluent API.
 */
export function createMockFdirInstance(syncReturnValue: string[] = []) {
    const instance = {
        withGlobFunction: vi.fn().mockReturnThis(),
        glob: vi.fn().mockReturnThis(),
        globWithOptions: vi.fn().mockReturnThis(),
        withRelativePaths: vi.fn().mockReturnThis(),
        withFullPaths: vi.fn().mockReturnThis(),
        exclude: vi.fn().mockReturnThis(),
        filter: vi.fn().mockReturnThis(),
        crawl: vi.fn().mockReturnThis(),
        withPromise: vi.fn().mockResolvedValue(syncReturnValue),
        sync: vi.fn().mockReturnValue(syncReturnValue),
    };
    // Make chainable methods return the instance
    instance.withGlobFunction.mockReturnValue(instance);
    instance.glob.mockReturnValue(instance);
    instance.globWithOptions.mockReturnValue(instance);
    instance.withRelativePaths.mockReturnValue(instance);
    instance.withFullPaths.mockReturnValue(instance);
    instance.exclude.mockReturnValue(instance);
    instance.filter.mockReturnValue(instance);
    instance.crawl.mockReturnValue(instance);
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

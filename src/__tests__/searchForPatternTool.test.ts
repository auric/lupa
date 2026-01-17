import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import {
    RipgrepSearchService,
    RipgrepFileResult,
} from '../services/ripgrepSearchService';
import { TimeoutError } from '../types/errorTypes';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';

// Mock RipgrepSearchService
vi.mock('../services/ripgrepSearchService');

describe('SearchForPatternTool', () => {
    let searchForPatternTool: SearchForPatternTool;
    let mockGitOperationsManager: Partial<GitOperationsManager>;
    let mockRipgrepService: {
        search: Mock;
        formatResults: Mock;
    };

    beforeEach(() => {
        vi.clearAllMocks();

        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/git-repo' },
            }),
        };

        mockRipgrepService = {
            search: vi.fn(),
            formatResults: vi.fn(),
        };

        // Vitest 4 requires function syntax for constructor mocks
        vi.mocked(RipgrepSearchService).mockImplementation(function (
            this: any
        ) {
            this.search = mockRipgrepService.search;
            this.formatResults = mockRipgrepService.formatResults;
        });

        searchForPatternTool = new SearchForPatternTool(
            mockGitOperationsManager as GitOperationsManager
        );
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(searchForPatternTool.name).toBe('search_for_pattern');
            expect(searchForPatternTool.description).toContain(
                'Search for text patterns'
            );
        });

        it('should have valid schema with all required fields', () => {
            const schema = searchForPatternTool.schema;

            const validInput = { pattern: 'class.*{' };
            expect(schema.safeParse(validInput).success).toBe(true);

            const fullInput = {
                pattern: 'function.*\\(',
                include_files: '*.ts',
                search_path: 'src',
                lines_before: 2,
                lines_after: 1,
                only_code_files: true,
                case_sensitive: false,
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            expect(schema.safeParse({ pattern: '' }).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeTools = searchForPatternTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('search_for_pattern');
            expect(vscodeTools.description).toContain(
                'Search for text patterns'
            );
            expect(vscodeTools.inputSchema).toBeDefined();

            const schema = vscodeTools.inputSchema as Record<string, unknown>;
            const properties = schema.properties as Record<string, unknown>;
            expect(properties.pattern).toBeDefined();
            expect(properties.include_files).toBeDefined();
            expect(properties.search_path).toBeDefined();
            expect(properties.lines_before).toBeDefined();
            expect(properties.lines_after).toBeDefined();
            expect(properties.only_code_files).toBeDefined();
            expect(properties.case_sensitive).toBeDefined();
        });
    });

    describe('Pattern Search Functionality', () => {
        it('should find pattern matches in files with proper formatting', async () => {
            const mockResults: RipgrepFileResult[] = [
                {
                    filePath: 'src/index.ts',
                    matches: [
                        {
                            filePath: 'src/index.ts',
                            lineNumber: 1,
                            content: 'export class MyClass {',
                            isContext: false,
                        },
                    ],
                },
                {
                    filePath: 'src/utils.ts',
                    matches: [
                        {
                            filePath: 'src/utils.ts',
                            lineNumber: 4,
                            content: 'class UtilClass {}',
                            isContext: false,
                        },
                    ],
                },
            ];

            mockRipgrepService.search.mockResolvedValue(mockResults);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/index.ts ===\n1: export class MyClass {\n\n=== src/utils.ts ===\n4: class UtilClass {}'
            );

            const result = await searchForPatternTool.execute(
                {
                    pattern: 'class.*{',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('src/index.ts');
            expect(result.data).toContain('1: export class MyClass {');
            expect(result.data).toContain('src/utils.ts');
            expect(result.data).toContain('4: class UtilClass {}');
        });

        it('should handle context lines extraction', async () => {
            const mockResults: RipgrepFileResult[] = [
                {
                    filePath: 'src/test.ts',
                    matches: [
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 1,
                            content: 'line 1',
                            isContext: true,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 2,
                            content: 'class TestClass {',
                            isContext: false,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 3,
                            content: 'line 3',
                            isContext: true,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 4,
                            content: 'line 4',
                            isContext: true,
                        },
                    ],
                },
            ];

            mockRipgrepService.search.mockResolvedValue(mockResults);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/test.ts ===\n1: line 1\n2: class TestClass {\n3: line 3\n4: line 4'
            );

            const result = await searchForPatternTool.execute(
                {
                    pattern: 'class.*{',
                    lines_before: 1,
                    lines_after: 2,
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('1: line 1');
            expect(result.data).toContain('2: class TestClass {');
            expect(result.data).toContain('3: line 3');
            expect(result.data).toContain('4: line 4');

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({
                    pattern: 'class.*{',
                    linesBefore: 1,
                    linesAfter: 2,
                })
            );
        });

        it('should handle case sensitivity', async () => {
            const mockResultsInsensitive: RipgrepFileResult[] = [
                {
                    filePath: 'src/test.ts',
                    matches: [
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 1,
                            content: 'Class TestClass {',
                            isContext: false,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 2,
                            content: 'class TestClass {',
                            isContext: false,
                        },
                    ],
                },
            ];

            mockRipgrepService.search.mockResolvedValue(mockResultsInsensitive);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/test.ts ===\n1: Class TestClass {\n2: class TestClass {'
            );

            let result = await searchForPatternTool.execute(
                {
                    pattern: 'class.*{',
                    case_sensitive: false,
                },
                createMockExecutionContext()
            );
            expect(result.success).toBe(true);
            expect(result.data).toContain('1: Class TestClass {');
            expect(result.data).toContain('2: class TestClass {');

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ caseSensitive: false })
            );

            vi.clearAllMocks();
            const mockResultsSensitive: RipgrepFileResult[] = [
                {
                    filePath: 'src/test.ts',
                    matches: [
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 2,
                            content: 'class TestClass {',
                            isContext: false,
                        },
                    ],
                },
            ];

            mockRipgrepService.search.mockResolvedValue(mockResultsSensitive);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/test.ts ===\n2: class TestClass {'
            );

            result = await searchForPatternTool.execute(
                {
                    pattern: 'class.*{',
                    case_sensitive: true,
                },
                createMockExecutionContext()
            );
            expect(result.success).toBe(true);
            expect(result.data).toContain('2: class TestClass {');
            expect(result.data).not.toContain('1: Class TestClass {');

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ caseSensitive: true })
            );
        });

        it('should handle only_code_files filtering', async () => {
            const mockResults: RipgrepFileResult[] = [
                {
                    filePath: 'src/code.ts',
                    matches: [
                        {
                            filePath: 'src/code.ts',
                            lineNumber: 1,
                            content: 'class Test {}',
                            isContext: false,
                        },
                    ],
                },
            ];

            mockRipgrepService.search.mockResolvedValue(mockResults);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/code.ts ===\n1: class Test {}'
            );

            const result = await searchForPatternTool.execute(
                {
                    pattern: 'class.*{',
                    only_code_files: true,
                },
                createMockExecutionContext()
            );

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ codeFilesOnly: true })
            );

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('src/code.ts');
        });

        it('should return no matches when pattern not found', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            const result = await searchForPatternTool.execute(
                {
                    pattern: 'nonexistentpattern',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('No matches found');
        });
    });

    describe('Error Handling', () => {
        it('should propagate ripgrep errors to ToolExecutor', async () => {
            // With centralized error handling, ripgrep errors bubble up to ToolExecutor
            mockRipgrepService.search.mockRejectedValue(
                new Error('ripgrep error: regex parse error')
            );

            await expect(
                searchForPatternTool.execute(
                    {
                        pattern: '[invalid regex',
                    },
                    createMockExecutionContext()
                )
            ).rejects.toThrow('ripgrep error: regex parse error');
        });

        it('should propagate ripgrep spawn errors to ToolExecutor', async () => {
            // With centralized error handling, spawn errors bubble up to ToolExecutor
            mockRipgrepService.search.mockRejectedValue(
                new Error('Failed to spawn ripgrep')
            );

            await expect(
                searchForPatternTool.execute(
                    {
                        pattern: 'test',
                    },
                    createMockExecutionContext()
                )
            ).rejects.toThrow('Failed to spawn ripgrep');
        });

        it('should handle git repository access errors', async () => {
            (mockGitOperationsManager.getRepository as Mock).mockReturnValue(
                null
            );

            const result = await searchForPatternTool.execute(
                {
                    pattern: 'test',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(false);
            expect(result.error).toContain('Git repository not found');
        });
    });

    describe('Output Formatting', () => {
        it('should format matches grouped by file with line numbers', async () => {
            const mockResults: RipgrepFileResult[] = [
                {
                    filePath: 'src/test.ts',
                    matches: [
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 1,
                            content: 'class First {}',
                            isContext: false,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 2,
                            content: 'class Second {}',
                            isContext: false,
                        },
                    ],
                },
            ];

            mockRipgrepService.search.mockResolvedValue(mockResults);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/test.ts ===\n1: class First {}\n2: class Second {}'
            );

            const result = await searchForPatternTool.execute(
                {
                    pattern: 'class.*{',
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('src/test.ts');
            expect(result.data).toContain('1: class First {}');
            expect(result.data).toContain('2: class Second {}');
        });

        it('should group consecutive matches intelligently', async () => {
            const mockResults: RipgrepFileResult[] = [
                {
                    filePath: 'src/test.ts',
                    matches: [
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 2,
                            content: 'class First {',
                            isContext: false,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 3,
                            content: 'line3',
                            isContext: true,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 4,
                            content: 'class Second {',
                            isContext: false,
                        },
                        {
                            filePath: 'src/test.ts',
                            lineNumber: 5,
                            content: 'line5',
                            isContext: true,
                        },
                    ],
                },
            ];

            mockRipgrepService.search.mockResolvedValue(mockResults);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== src/test.ts ===\n2: class First {\n3: line3\n4: class Second {\n5: line5'
            );

            const result = await searchForPatternTool.execute(
                {
                    pattern: 'class.*{',
                    lines_before: 0,
                    lines_after: 1,
                },
                createMockExecutionContext()
            );

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('src/test.ts');
            expect(result.data).toContain('2: class First {');
            expect(result.data).toContain('4: class Second {');
        });
    });

    describe('Search Options', () => {
        it('should pass include_files glob pattern to ripgrep', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            await searchForPatternTool.execute(
                {
                    pattern: 'test',
                    include_files: '*.ts',
                },
                createMockExecutionContext()
            );

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ includeGlob: '*.ts' })
            );
        });

        it('should pass exclude_files glob pattern to ripgrep', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            await searchForPatternTool.execute(
                {
                    pattern: 'test',
                    exclude_files: '*test*',
                },
                createMockExecutionContext()
            );

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ excludeGlob: '*test*' })
            );
        });

        it('should pass search_path to ripgrep', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            await searchForPatternTool.execute(
                {
                    pattern: 'test',
                    search_path: 'src/components',
                },
                createMockExecutionContext()
            );

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ searchPath: 'src/components' })
            );
        });

        it('should not pass searchPath when search_path is "."', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            await searchForPatternTool.execute(
                {
                    pattern: 'test',
                    search_path: '.',
                },
                createMockExecutionContext()
            );

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ searchPath: undefined })
            );
        });
    });

    describe('Timeout and Cancellation', () => {
        it('should use linked token that gets cancelled on timeout', async () => {
            // Simulate a slow search that never resolves
            mockRipgrepService.search.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve([]), 100000);
                    })
            );

            // Create a mock execution context
            const context = {
                cancellationToken: {
                    isCancellationRequested: false,
                    onCancellationRequested: vi.fn().mockReturnValue({
                        dispose: vi.fn(),
                    }),
                },
            };

            // Replace the timeout constant for testing by running with short time
            // The actual timeout is 60s but we can check the token was linked
            void searchForPatternTool.execute(
                { pattern: 'test' },
                context as any
            );

            // Verify the linked token was set up with onCancellationRequested
            expect(
                context.cancellationToken.onCancellationRequested
            ).toHaveBeenCalled();

            // Cleanup - cancel to stop the hanging promise
            mockRipgrepService.search.mockResolvedValue([]);
        });

        it('should pass linked token to ripgrep service', async () => {
            mockRipgrepService.search.mockResolvedValue([
                {
                    filePath: 'test.ts',
                    matches: [
                        {
                            filePath: 'test.ts',
                            lineNumber: 1,
                            content: 'test',
                            isContext: false,
                        },
                    ],
                },
            ]);
            mockRipgrepService.formatResults.mockReturnValue(
                '=== test.ts ===\n1: test'
            );

            await searchForPatternTool.execute(
                { pattern: 'test' },
                createMockExecutionContext()
            );

            // Verify ripgrep was called with a token
            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({
                    token: expect.any(Object),
                })
            );
        });

        it('should throw timeout error when search times out', async () => {
            // Simulate timeout by rejecting with TimeoutError
            // TimeoutError now propagates to ToolExecutor for centralized handling
            mockRipgrepService.search.mockRejectedValue(
                TimeoutError.create('Pattern search', 60000)
            );

            await expect(
                searchForPatternTool.execute(
                    { pattern: 'test' },
                    createMockExecutionContext()
                )
            ).rejects.toThrow(TimeoutError);
        });

        it('should throw CancellationError when already cancelled', async () => {
            const context = createCancelledExecutionContext();

            await expect(
                searchForPatternTool.execute({ pattern: 'test' }, context)
            ).rejects.toThrow(vscode.CancellationError);

            // Ripgrep should never be called
            expect(mockRipgrepService.search).not.toHaveBeenCalled();
        });
    });
});

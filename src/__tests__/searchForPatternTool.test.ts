import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import {
    RipgrepSearchService,
    RipgrepFileResult,
} from '../services/ripgrepSearchService';

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

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
            });

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

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                lines_before: 1,
                lines_after: 2,
            });

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

            let result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                case_sensitive: false,
            });
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

            result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                case_sensitive: true,
            });
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

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                only_code_files: true,
            });

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ codeFilesOnly: true })
            );

            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(result.data).toContain('src/code.ts');
        });

        it('should return no matches when pattern not found', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            const result = await searchForPatternTool.execute({
                pattern: 'nonexistentpattern',
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No matches found');
        });
    });

    describe('Error Handling', () => {
        it('should handle ripgrep errors for invalid regex patterns', async () => {
            mockRipgrepService.search.mockRejectedValue(
                new Error('ripgrep error: regex parse error')
            );

            const result = await searchForPatternTool.execute({
                pattern: '[invalid regex',
            });

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.error).toContain('Pattern search failed');
        });

        it('should handle ripgrep spawn errors', async () => {
            mockRipgrepService.search.mockRejectedValue(
                new Error('Failed to spawn ripgrep')
            );

            const result = await searchForPatternTool.execute({
                pattern: 'test',
            });

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.error).toContain('Pattern search failed');
        });

        it('should handle git repository access errors', async () => {
            (mockGitOperationsManager.getRepository as Mock).mockReturnValue(
                null
            );

            const result = await searchForPatternTool.execute({
                pattern: 'test',
            });

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

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
            });

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

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                lines_before: 0,
                lines_after: 1,
            });

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

            await searchForPatternTool.execute({
                pattern: 'test',
                include_files: '*.ts',
            });

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ includeGlob: '*.ts' })
            );
        });

        it('should pass exclude_files glob pattern to ripgrep', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            await searchForPatternTool.execute({
                pattern: 'test',
                exclude_files: '*test*',
            });

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ excludeGlob: '*test*' })
            );
        });

        it('should pass search_path to ripgrep', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            await searchForPatternTool.execute({
                pattern: 'test',
                search_path: 'src/components',
            });

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ searchPath: 'src/components' })
            );
        });

        it('should not pass searchPath when search_path is "."', async () => {
            mockRipgrepService.search.mockResolvedValue([]);

            await searchForPatternTool.execute({
                pattern: 'test',
                search_path: '.',
            });

            expect(mockRipgrepService.search).toHaveBeenCalledWith(
                expect.objectContaining({ searchPath: undefined })
            );
        });
    });
});

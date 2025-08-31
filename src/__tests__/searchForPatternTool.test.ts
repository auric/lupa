import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { FileDiscoverer } from '../utils/fileDiscoverer';
import { CodeFileDetector } from '../utils/codeFileDetector';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            fs: {
                readFile: vi.fn()
            }
        },
        Uri: {
            file: vi.fn((path) => ({
                fsPath: path,
                toString: () => `file://${path}`
            }))
        }
    };
});

// Mock FileDiscoverer
vi.mock('../utils/fileDiscoverer', () => ({
    FileDiscoverer: {
        discoverFiles: vi.fn()
    }
}));

// Mock CodeFileDetector
vi.mock('../utils/codeFileDetector', () => ({
    CodeFileDetector: {
        filterCodeFiles: vi.fn()
    }
}));

describe('SearchForPatternTool', () => {
    let searchForPatternTool: SearchForPatternTool;
    let mockGitOperationsManager: any;
    let mockReadFile: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/git-repo' }
            })
        };

        searchForPatternTool = new SearchForPatternTool(mockGitOperationsManager);
        mockReadFile = vi.mocked(vscode.workspace.fs.readFile);
        
        // Clear all mocks
        vi.clearAllMocks();
        
        // Re-setup essential mocks
        mockGitOperationsManager.getRepository.mockReturnValue({
            rootUri: { fsPath: '/test/git-repo' }
        });
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(searchForPatternTool.name).toBe('search_for_pattern');
            expect(searchForPatternTool.description).toContain('flexible search for arbitrary patterns');
        });

        it('should have valid schema with all required fields', () => {
            const schema = searchForPatternTool.schema;

            // Test required field only
            const validInput = { pattern: 'class.*{' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test with all optional fields
            const fullInput = {
                pattern: 'function.*\\(',
                include_files: '*.ts',
                search_path: 'src',
                lines_before: 2,
                lines_after: 1,
                only_code_files: true,
                case_sensitive: false
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            // Test validation (empty pattern rejection)
            expect(schema.safeParse({ pattern: '' }).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeTools = searchForPatternTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('search_for_pattern');
            expect(vscodeTools.description).toContain('flexible search for arbitrary patterns');
            expect(vscodeTools.inputSchema).toBeDefined();

            // Verify schema properties use LLM-optimized parameter names
            const schema = vscodeTools.inputSchema as any;
            expect(schema.properties.pattern).toBeDefined();
            expect(schema.properties.include_files).toBeDefined();
            expect(schema.properties.search_path).toBeDefined();
            expect(schema.properties.lines_before).toBeDefined();
            expect(schema.properties.lines_after).toBeDefined();
            expect(schema.properties.only_code_files).toBeDefined();
            expect(schema.properties.case_sensitive).toBeDefined();
        });
    });

    describe('Pattern Search Functionality', () => {
        it('should find pattern matches in files with proper formatting', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/index.ts', 'src/utils.ts'],
                truncated: false,
                totalFound: 2
            });

            // Mock file contents
            const mockFileContents = new Map([
                ['/test/git-repo/src/index.ts', 'export class MyClass {\n  constructor() {}\n}\nfunction test() {}'],
                ['/test/git-repo/src/utils.ts', 'export function utilFunction() {\n  return true;\n}\nclass UtilClass {}']
            ]);

            mockReadFile.mockImplementation((uri) => {
                const content = mockFileContents.get(uri.fsPath);
                if (content) {
                    return Promise.resolve(Buffer.from(content));
                }
                throw new Error('File not found');
            });

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            expect(result).toHaveProperty('matches');
            const successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches).toBeDefined();
            expect(successResult.matches.length).toBeGreaterThan(0);
            expect(successResult.matches[0].file_path).toBe('src/index.ts');
            expect(successResult.matches[0].content).toContain('1: export class MyClass {');
            expect(successResult.matches[1].file_path).toBe('src/utils.ts');
            expect(successResult.matches[1].content).toContain('4: class UtilClass {}');
        });

        it('should handle context lines extraction', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test.ts'],
                truncated: false,
                totalFound: 1
            });

            const testContent = 'line 1\nclass TestClass {\nline 3\nline 4\nline 5';
            mockReadFile.mockResolvedValue(Buffer.from(testContent));

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                lines_before: 1,
                lines_after: 2
            });

            const successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches).toBeDefined();
            expect(successResult.matches[0].content).toContain('1: line 1'); // before
            expect(successResult.matches[0].content).toContain('2: class TestClass {'); // match
            expect(successResult.matches[0].content).toContain('3: line 3'); // after
            expect(successResult.matches[0].content).toContain('4: line 4'); // after
        });

        it('should handle case sensitivity', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test.ts'],
                truncated: false,
                totalFound: 1
            });

            const testContent = 'Class TestClass {\nclass TestClass {';
            mockReadFile.mockResolvedValue(Buffer.from(testContent));

            // Case insensitive (default)
            let result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                case_sensitive: false
            });
            let successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches[0].content).toContain('1: Class TestClass {');
            expect(successResult.matches[0].content).toContain('2: class TestClass {');

            // Case sensitive
            result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                case_sensitive: true
            });
            successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches[0].content).toContain('2: class TestClass {');
            expect(successResult.matches[0].content).not.toContain('1: Class TestClass {');
        });

        it('should handle only_code_files filtering', async () => {
            // Mock FileDiscoverer to return mixed file types
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/code.ts', 'README.md', 'config.json'],
                truncated: false,
                totalFound: 3
            });
            
            // Mock CodeFileDetector to filter to code files only
            vi.mocked(CodeFileDetector.filterCodeFiles).mockReturnValue(['src/code.ts']);

            mockReadFile.mockResolvedValue(Buffer.from('class Test {}'));

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                only_code_files: true
            });

            expect(CodeFileDetector.filterCodeFiles).toHaveBeenCalledWith(['src/code.ts', 'README.md', 'config.json']);
            
            const successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches).toBeDefined();
            expect(successResult.matches[0].file_path).toBe('src/code.ts');
        });

        it('should return no matches when pattern not found', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test.ts'],
                truncated: false,
                totalFound: 1
            });

            mockReadFile.mockResolvedValue(Buffer.from('const variable = "test";'));

            const result = await searchForPatternTool.execute({
                pattern: 'nonexistentpattern'
            });

            const successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches).toEqual([]);
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid regex patterns', async () => {
            // Mock FileDiscoverer to return files (error should occur before file processing)
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test.ts'],
                truncated: false,
                totalFound: 1
            });

            const result = await searchForPatternTool.execute({
                pattern: '[invalid regex'
            });

            const errorResult = result as { error: string };
            expect(errorResult.error).toBeDefined();
            expect(errorResult.error).toContain('Invalid regex pattern');
        });

        it('should handle FileDiscoverer errors', async () => {
            vi.mocked(FileDiscoverer.discoverFiles).mockRejectedValue(new Error('File discovery failed'));

            const result = await searchForPatternTool.execute({
                pattern: 'test'
            });

            const errorResult = result as { error: string };
            expect(errorResult.error).toBeDefined();
            expect(errorResult.error).toContain('Pattern search failed');
        });

        it('should handle git repository access errors', async () => {
            mockGitOperationsManager.getRepository.mockReturnValue(null);

            const result = await searchForPatternTool.execute({
                pattern: 'test'
            });

            const errorResult = result as { error: string };
            expect(errorResult.error).toContain('Git repository not found');
        });

        it('should handle file read errors gracefully', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test.ts', 'src/error.ts'],
                truncated: false,
                totalFound: 2
            });

            mockReadFile.mockImplementation((uri) => {
                if (uri.fsPath.includes('error.ts')) {
                    throw new Error('Permission denied');
                }
                return Promise.resolve(Buffer.from('class Test {}'));
            });

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            // Should skip unreadable files and process readable ones
            const successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches).toBeDefined();
            expect(successResult.matches.length).toBe(1);
            expect(successResult.matches[0].file_path).toBe('src/test.ts');
        });
    });

    describe('Output Formatting', () => {
        it('should format matches grouped by file with line numbers', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test.ts'],
                truncated: false,
                totalFound: 1
            });

            const testContent = 'class First {}\nclass Second {}\nfunction other() {}';
            mockReadFile.mockResolvedValue(Buffer.from(testContent));

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            const successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches).toBeDefined();
            expect(successResult.matches[0].file_path).toBe('src/test.ts');
            expect(successResult.matches[0].content).toContain('1: class First {}');
            expect(successResult.matches[0].content).toContain('2: class Second {}');
            expect(successResult.matches[0].content).not.toContain('function other()');
        });

        it('should group consecutive matches intelligently', async () => {
            // Mock FileDiscoverer to return test files
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test.ts'],
                truncated: false,
                totalFound: 1
            });

            const testContent = 'line1\nclass First {\nline3\nclass Second {\nline5';
            mockReadFile.mockResolvedValue(Buffer.from(testContent));

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                lines_before: 0,
                lines_after: 1
            });

            const successResult = result as { matches: Array<{ file_path: string; content: string }> };
            expect(successResult.matches).toBeDefined();
            expect(successResult.matches[0].file_path).toBe('src/test.ts');
            // Should contain both matches with their context, grouped intelligently
            const content = successResult.matches[0].content;
            expect(content).toContain('2: class First {');
            expect(content).toContain('4: class Second {');
        });
        it('should handle truncated file discovery results', async () => {
            // Mock FileDiscoverer to return truncated results
            vi.mocked(FileDiscoverer.discoverFiles).mockResolvedValue({
                files: ['src/test1.ts', 'src/test2.ts'],
                truncated: true,
                totalFound: 500
            });

            mockReadFile.mockResolvedValue(Buffer.from('class Test {}'));

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            const successResult = result as { matches: Array<{ file_path: string; content: string }>; message?: string };
            expect(successResult.matches).toBeDefined();
            expect(successResult.message).toContain('Search was limited to first');
            expect(successResult.message).toContain('Consider using more specific filters');
        });
    });
});

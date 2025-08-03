import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ignore from 'ignore';
import { SearchForPatternTool } from '../tools/searchForPatternTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import * as gitUtils from '../utils/gitUtils';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            fs: {
                readFile: vi.fn(),
                readDirectory: vi.fn()
            },
            asRelativePath: vi.fn((uri) => uri.fsPath.replace('/project/', ''))
        },
        Uri: {
            file: vi.fn((path) => ({
                fsPath: path,
                toString: () => `file://${path}`
            }))
        },
        FileType: {
            File: 1,
            Directory: 2
        }
    };
});

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn()
    }
}));

// Mock pathUtils
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn()
}));

// Mock GitOperationsManager
vi.mock('../services/gitOperationsManager', () => ({
    GitOperationsManager: vi.fn()
}));

// Mock ignore library
vi.mock('ignore', () => {
    const mockIgnore = {
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn().mockReturnValue({ ignored: false })
    };
    return {
        default: vi.fn(() => mockIgnore)
    };
});

describe('SearchForPatternTool', () => {
    let searchForPatternTool: SearchForPatternTool;
    let mockGitOperationsManager: any;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/project' }
            })
        };

        searchForPatternTool = new SearchForPatternTool(mockGitOperationsManager);

        // Re-setup essential mocks
        mockGitOperationsManager.getRepository.mockReturnValue({
            rootUri: { fsPath: '/project' }
        });
        vi.mocked(PathSanitizer.sanitizePath).mockImplementation((path) => path);
        vi.mocked(gitUtils.readGitignore).mockResolvedValue('node_modules/\n*.log');
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(searchForPatternTool.name).toBe('search_for_pattern');
            expect(searchForPatternTool.description).toContain('Search for a regex pattern');
        });

        it('should have valid schema with all required fields', () => {
            const schema = searchForPatternTool.schema;

            // Test required field only
            const validInput = { pattern: 'class.*{' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test with all optional fields
            const fullInput = {
                pattern: 'function.*\\(',
                include: '*.ts',
                path: 'src'
            };
            expect(schema.safeParse(fullInput).success).toBe(true);

            // Test validation (empty pattern rejection)
            expect(schema.safeParse({ pattern: '' }).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeTools = searchForPatternTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('search_for_pattern');
            expect(vscodeTools.description).toContain('Search for a regex pattern');
            expect(vscodeTools.inputSchema).toBeDefined();
        });
    });

    describe('Pattern Search Functionality', () => {
        beforeEach(() => {
            // Re-setup essential mocks
            mockGitOperationsManager.getRepository.mockReturnValue({
                rootUri: { fsPath: '/project' }
            });
            vi.mocked(PathSanitizer.sanitizePath).mockImplementation((path) => path);
            vi.mocked(gitUtils.readGitignore).mockResolvedValue('node_modules/\n*.log');
        });

        it('should find pattern matches in files', async () => {
            // Mock directory structure
            vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/project') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/project/src') {
                    return Promise.resolve([
                        ['index.ts', vscode.FileType.File],
                        ['utils.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            // Mock file contents
            const mockFileContents = new Map([
                ['/project/src/index.ts', 'export class MyClass {\n  constructor() {}\n}\nfunction test() {}'],
                ['/project/src/utils.ts', 'export function utilFunction() {\n  return true;\n}\nclass UtilClass {}']
            ]);

            vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
                const content = mockFileContents.get(uri.fsPath);
                if (content) {
                    return Promise.resolve(Buffer.from(content));
                }
                throw new Error('File not found');
            });

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            expect(result.length).toBeGreaterThan(0);
            const resultText = result.join('\n');
            expect(resultText).toContain('<file>src/index.ts</file>');
            expect(resultText).toContain('1: export class MyClass {');
            expect(resultText).toContain('<file>src/utils.ts</file>');
            expect(resultText).toContain('4: class UtilClass {}');
        });

        it('should handle glob pattern filtering', async () => {
            // Mock directory structure
            vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/project') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory],
                        ['README.md', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/project/src') {
                    return Promise.resolve([
                        ['index.ts', vscode.FileType.File],
                        ['components', vscode.FileType.Directory]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/project/src/components') {
                    return Promise.resolve([
                        ['Button.tsx', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            const mockFileContents = new Map([
                ['/project/src/index.ts', 'class TypeScript {}'],
                ['/project/src/components/Button.tsx', 'class ReactComponent {}'],
                ['/project/README.md', 'class Documentation {}']
            ]);

            vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
                const content = mockFileContents.get(uri.fsPath);
                if (content) {
                    return Promise.resolve(Buffer.from(content));
                }
                throw new Error('File not found');
            });

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                include: '*.ts'
            });
            const resultText = result.join('\n');
            expect(resultText).toContain('<file>src/index.ts</file>');
            expect(resultText).toContain('1: class TypeScript {}');
            expect(resultText).not.toContain('README.md');
            expect(resultText).not.toContain('Button.tsx');
        });

        it('should handle path filtering', async () => {
            vi.mocked(PathSanitizer.sanitizePath).mockReturnValue('src/components');

            // Mock directory structure for path filtering
            vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/project/src/components') {
                    return Promise.resolve([
                        ['Button.tsx', vscode.FileType.File],
                        ['Modal.tsx', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            const mockFileContents = new Map([
                ['/project/src/components/Button.tsx', 'class Button {}'],
                ['/project/src/components/Modal.tsx', 'class Modal {}']
            ]);

            vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
                const content = mockFileContents.get(uri.fsPath);
                if (content) {
                    return Promise.resolve(Buffer.from(content));
                }
                throw new Error('File not found');
            });

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{',
                path: 'src/components'
            });

            expect(PathSanitizer.sanitizePath).toHaveBeenCalledWith('src/components');
            const resultText = result.join('\n');
            expect(resultText).toContain('<file>src/components/Button.tsx</file>');
            expect(resultText).toContain('1: class Button {}');
            expect(resultText).toContain('<file>src/components/Modal.tsx</file>');
            expect(resultText).toContain('1: class Modal {}');
        });

        it('should return no matches message when pattern not found', async () => {
            vi.mocked(vscode.workspace.fs.readFile).mockImplementation(() => {
                return Promise.resolve(Buffer.from('const variable = "test";'));
            });

            const result = await searchForPatternTool.execute({
                pattern: 'nonexistentpattern'
            });

            expect(result[0]).toContain('<message>No matches found for the specified pattern</message>');
        });

        it('should handle file read errors gracefully', async () => {
            vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error('Permission denied'));

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            // Should not throw error, should return no matches or handle gracefully
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid regex patterns', async () => {
            const result = await searchForPatternTool.execute({
                pattern: '[invalid regex'
            });

            expect(result[0]).toContain('Error searching for pattern');
        });

        it('should handle path sanitization errors', async () => {
            vi.mocked(PathSanitizer.sanitizePath).mockImplementation(() => {
                throw new Error('Invalid path');
            });

            const result = await searchForPatternTool.execute({
                pattern: 'test',
                path: '../../../etc/passwd'
            });

            expect(result[0]).toContain('Error searching for pattern');
        });

        it('should handle git repository access errors', async () => {
            mockGitOperationsManager.getRepository.mockReturnValue(null);

            const result = await searchForPatternTool.execute({
                pattern: 'test'
            });

            // Should handle missing git repository gracefully
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('Output Formatting', () => {
        it('should format matches grouped by file', async () => {
            // Mock directory structure
            vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/project') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/project/src') {
                    return Promise.resolve([
                        ['test.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            const mockFileContents = new Map([
                ['/project/src/test.ts', 'class First {}\nclass Second {}\nfunction other() {}']
            ]);

            vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
                const content = mockFileContents.get(uri.fsPath);
                if (content) {
                    return Promise.resolve(Buffer.from(content));
                }
                throw new Error('File not found');
            });

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            // Check that matches are in XML format with correct file and content
            const resultText = result.join('\n');
            expect(resultText).toContain('<file>src/test.ts</file>');
            expect(resultText).toContain('1: class First {}');
            expect(resultText).toContain('2: class Second {}');
        });

        it('should remove trailing whitespace from matched lines', async () => {
            // Mock directory structure
            vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/project') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/project/src') {
                    return Promise.resolve([
                        ['test.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            const mockFileContents = new Map([
                ['/project/src/test.ts', 'class TestClass {   \n  method() {}']
            ]);

            vi.mocked(vscode.workspace.fs.readFile).mockImplementation((uri) => {
                const content = mockFileContents.get(uri.fsPath);
                if (content) {
                    return Promise.resolve(Buffer.from(content));
                }
                throw new Error('File not found');
            });

            const result = await searchForPatternTool.execute({
                pattern: 'class.*{'
            });

            // Check that trailing whitespace is removed in XML content
            const resultText = result.join('\n');
            expect(resultText).toContain('1: class TestClass {');
            expect(resultText).not.toContain('1: class TestClass {   ');
        });
    });

    describe('Gitignore Integration', () => {
        it('should respect gitignore patterns', async () => {
            const mockIgnore = {
                add: vi.fn().mockReturnThis(),
                checkIgnore: vi.fn().mockImplementation((path) => ({
                    ignored: path.includes('node_modules')
                }))
            } as any;
            vi.mocked(ignore).mockReturnValue(mockIgnore);
            vi.mocked(gitUtils.readGitignore).mockResolvedValue('node_modules/\n*.log');

            // Mock directory with ignored files - avoid infinite loop
            vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation((uri) => {
                const path = uri.fsPath;
                if (path === '/project') {
                    return Promise.resolve([
                        ['src', vscode.FileType.Directory],
                        ['node_modules', vscode.FileType.Directory],
                        ['test.log', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                } else if (path === '/project/src') {
                    return Promise.resolve([
                        ['index.ts', vscode.FileType.File]
                    ] as [string, vscode.FileType][]);
                }
                return Promise.resolve([]);
            });

            await searchForPatternTool.execute({
                pattern: 'test'
            });

            expect(gitUtils.readGitignore).toHaveBeenCalledWith(
                mockGitOperationsManager.getRepository()
            );
            expect(mockIgnore.add).toHaveBeenCalledWith('node_modules/\n*.log');
        });
    });
});

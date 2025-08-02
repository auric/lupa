import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetSymbolsOverviewTool } from '../tools/getSymbolsOverviewTool';
import { GitOperationsManager } from '../services/gitOperationsManager';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        workspace: {
            fs: {
                stat: vi.fn(),
                readDirectory: vi.fn(),
                readFile: vi.fn()
            }
        },
        commands: {
            executeCommand: vi.fn()
        },
        Uri: {
            file: vi.fn((path) => ({
                toString: () => path,
                fsPath: path,
                path: path
            }))
        },
        FileType: {
            File: 1,
            Directory: 2
        },
        SymbolKind: {
            File: 1,
            Module: 2,
            Namespace: 3,
            Package: 4,
            Class: 5,
            Method: 6,
            Property: 7,
            Field: 8,
            Constructor: 9,
            Enum: 10,
            Interface: 11,
            Function: 12,
            Variable: 13,
            Constant: 14,
            String: 15,
            Number: 16,
            Boolean: 17,
            Array: 18,
            Object: 19,
            Key: 20,
            Null: 21,
            EnumMember: 22,
            Struct: 23,
            Event: 24,
            Operator: 25,
            TypeParameter: 26
        }
    };
});

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
    PathSanitizer: {
        sanitizePath: vi.fn((path) => path)
    }
}));

// Mock readGitignore
vi.mock('../utils/gitUtils', () => ({
    readGitignore: vi.fn().mockResolvedValue('')
}));

// Mock ignore library
vi.mock('ignore', () => ({
    default: vi.fn(() => ({
        add: vi.fn().mockReturnThis(),
        checkIgnore: vi.fn().mockReturnValue({ ignored: false })
    }))
}));

describe('GetSymbolsOverviewTool (Unit Tests)', () => {
    let getSymbolsOverviewTool: GetSymbolsOverviewTool;
    let mockGitOperationsManager: GitOperationsManager;

    beforeEach(() => {
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/repo' }
            })
        } as any;

        getSymbolsOverviewTool = new GetSymbolsOverviewTool(mockGitOperationsManager);
        vi.clearAllMocks();
    });

    describe('Tool Configuration', () => {
        it('should have correct name and description', () => {
            expect(getSymbolsOverviewTool.name).toBe('get_symbols_overview');
            expect(getSymbolsOverviewTool.description).toContain('Get a high-level overview of the symbols');
        });

        it('should have valid schema with required path field', () => {
            const schema = getSymbolsOverviewTool.schema;

            // Test valid input
            const validInput = { path: 'src/test.ts' };
            expect(schema.safeParse(validInput).success).toBe(true);

            // Test empty path
            const emptyInput = { path: '' };
            expect(schema.safeParse(emptyInput).success).toBe(false);

            // Test missing path
            const missingInput = {};
            expect(schema.safeParse(missingInput).success).toBe(false);
        });

        it('should return VS Code tool configuration', () => {
            const vscodeTools = getSymbolsOverviewTool.getVSCodeTool();
            expect(vscodeTools.name).toBe('get_symbols_overview');
            expect(vscodeTools.description).toContain('Get a high-level overview of the symbols');
            expect(vscodeTools.inputSchema).toBeDefined();
        });
    });

    describe('execute method', () => {
        it('should handle single file with symbols', async () => {
            // Mock file stat
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.File
            } as any);

            // Mock document symbols
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
                {
                    name: 'MyClass',
                    kind: vscode.SymbolKind.Class,
                    children: []
                },
                {
                    name: 'myFunction',
                    kind: vscode.SymbolKind.Function,
                    children: []
                }
            ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src/test.ts' });

            expect(result).toEqual([
                'src/test.ts:',
                '  - MyClass (class)',
                '  - myFunction (function)'
            ]);
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeDocumentSymbolProvider',
                expect.any(Object)
            );
        });

        it('should handle single file with no symbols', async () => {
            // Mock file stat
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.File
            } as any);

            // Mock empty symbols
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src/empty.ts' });

            expect(result).toEqual(['No symbols found']);
        });

        it('should handle directory with multiple files', async () => {
            // Mock directory stat
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.Directory
            } as any);

            // Mock directory contents - only files, no subdirectories to avoid recursion issues
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
                ['test1.ts', vscode.FileType.File],
                ['test2.js', vscode.FileType.File],
                ['README.md', vscode.FileType.File], // Should be ignored (not a code file)
            ]);

            // Mock symbols for different calls
            vi.mocked(vscode.commands.executeCommand)
                .mockResolvedValueOnce([
                    { name: 'Class1', kind: vscode.SymbolKind.Class, children: [] }
                ])
                .mockResolvedValueOnce([
                    { name: 'function1', kind: vscode.SymbolKind.Function, children: [] }
                ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src' });

            expect(result).toEqual([
                'src/test1.ts:',
                '  - Class1 (class)',
                '',
                'src/test2.js:',
                '  - function1 (function)'
            ]);
        });

        it('should handle directory with nested structure', async () => {
            // Mock directory stat for root
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.Directory
            } as any);

            // Mock nested directory structure
            vi.mocked(vscode.workspace.fs.readDirectory)
                .mockResolvedValueOnce([
                    ['services', vscode.FileType.Directory]
                ])
                .mockResolvedValueOnce([
                    ['service1.ts', vscode.FileType.File]
                ]);

            // Mock symbols
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
                { name: 'ServiceClass', kind: vscode.SymbolKind.Class, children: [] }
            ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src' });

            expect(result).toEqual([
                'src/services/service1.ts:',
                '  - ServiceClass (class)'
            ]);
        });

        it('should handle SymbolInformation format', async () => {
            // Mock file stat
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.File
            } as any);

            // Mock SymbolInformation (older format without children property)
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
                {
                    name: 'MyInterface',
                    kind: vscode.SymbolKind.Interface,
                    location: {}
                }
            ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src/interface.ts' });

            expect(result).toEqual([
                'src/interface.ts:',
                '  - MyInterface (interface)'
            ]);
        });

        it('should handle path not found error', async () => {
            vi.mocked(vscode.workspace.fs.stat).mockRejectedValue(new Error('File not found'));

            const result = await getSymbolsOverviewTool.execute({ path: 'nonexistent/path' });

            expect(result).toEqual(["Error getting symbols overview: Failed to get symbols overview for 'nonexistent/path': Path 'nonexistent/path' not found"]);
        });

        it('should handle git repository not found', async () => {
            const mockGitOpsWithoutRepo = {
                getRepository: vi.fn().mockReturnValue(null)
            } as any;

            const toolWithoutRepo = new GetSymbolsOverviewTool(mockGitOpsWithoutRepo);

            const result = await toolWithoutRepo.execute({ path: 'src/test.ts' });

            expect(result).toEqual(["Error getting symbols overview: Failed to get symbols overview for 'src/test.ts': Git repository not found"]);
        });

        it('should filter code files correctly', async () => {
            // Mock directory stat
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.Directory
            } as any);

            // Mock directory with various file types
            vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
                ['component.ts', vscode.FileType.File],      // Should include
                ['script.js', vscode.FileType.File],         // Should include
                ['styles.css', vscode.FileType.File],        // Should exclude
                ['config.json', vscode.FileType.File],       // Should exclude
                ['README.md', vscode.FileType.File],         // Should exclude
                ['image.png', vscode.FileType.File]          // Should exclude
            ]);

            // Mock symbols for code files only
            vi.mocked(vscode.commands.executeCommand)
                .mockResolvedValueOnce([
                    { name: 'Component', kind: vscode.SymbolKind.Class, children: [] }
                ])
                .mockResolvedValueOnce([
                    { name: 'script', kind: vscode.SymbolKind.Function, children: [] }
                ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src' });

            // Should only process .ts and .js files
            expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
            expect(result).toEqual([
                'src/component.ts:',
                '  - Component (class)',
                '',
                'src/script.js:',
                '  - script (function)'
            ]);
        });
    });

    describe('symbol type mapping', () => {
        it('should map VS Code SymbolKind to human-readable names', async () => {
            // Mock file stat
            vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
                type: vscode.FileType.File
            } as any);

            // Mock symbols with various kinds
            vi.mocked(vscode.commands.executeCommand).mockResolvedValue([
                { name: 'MyClass', kind: vscode.SymbolKind.Class, children: [] },
                { name: 'MyInterface', kind: vscode.SymbolKind.Interface, children: [] },
                { name: 'MyEnum', kind: vscode.SymbolKind.Enum, children: [] },
                { name: 'myFunction', kind: vscode.SymbolKind.Function, children: [] },
                { name: 'myVariable', kind: vscode.SymbolKind.Variable, children: [] },
                { name: 'myConstant', kind: vscode.SymbolKind.Constant, children: [] }
            ]);

            const result = await getSymbolsOverviewTool.execute({ path: 'src/test.ts' });

            expect(result).toEqual([
                'src/test.ts:',
                '  - MyClass (class)',
                '  - MyInterface (interface)',
                '  - MyEnum (enum)',
                '  - myFunction (function)',
                '  - myVariable (variable)',
                '  - myConstant (constant)'
            ]);
        });
    });
});
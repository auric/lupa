import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import * as vscode from 'vscode';
import path from 'path';
import { ContextProvider } from '../services/contextProvider';
import { CodeAnalysisService, SymbolInfo } from '../services/codeAnalysisService';
import { EmbeddingDatabaseAdapter } from '../services/embeddingDatabaseAdapter';
import { CopilotModelManager } from '../models/copilotModelManager';
import { AnalysisMode } from '../types/modelTypes';

// Mock dependencies
vi.mock('../services/codeAnalysisService');
vi.mock('../services/embeddingDatabaseAdapter');
vi.mock('../models/copilotModelManager');
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual<typeof import('vscode')>('vscode');
    return {
        ...actualVscode,
        commands: {
            executeCommand: vi.fn(),
        },
        workspace: {
            fs: {
                readFile: vi.fn(),
                stat: vi.fn().mockResolvedValue({ type: actualVscode.FileType.File }),
            },
            asRelativePath: vi.fn(uri => typeof uri === 'string' ? uri : uri.fsPath),
            workspaceFolders: [{ uri: { fsPath: '/root', path: '/root', scheme: 'file' } as vscode.Uri }], // Ensure path is also posix
        },
        Uri: { // This will be more specifically mocked in beforeEach
            file: vi.fn(p => ({ fsPath: p, path: p.replace(/\\/g, '/'), scheme: 'file', authority: '', query: '', fragment: '', with: vi.fn().mockReturnThis(), toString: () => `file://${p.replace(/\\/g, '/')}` })),
        },
        Position: class {
            constructor(public line: number, public character: number) { }
        },
        Range: class {
            constructor(public start: vscode.Position, public end: vscode.Position) { }
        },
        Location: class {
            constructor(public uri: vscode.Uri, public range: vscode.Range) { }
        },
        CancellationTokenSource: vi.fn(() => ({
            token: { isCancellationRequested: false, onCancellationRequested: vi.fn() },
            cancel: vi.fn(),
            dispose: vi.fn()
        })),
        FileType: {
            File: 1,
            Directory: 2,
            SymbolicLink: 64,
            Unknown: 0,
        },
    }
});

describe('ContextProvider', () => {
    let mockCodeAnalysisService: Mocked<CodeAnalysisService>;
    let mockDbAdapter: Mocked<EmbeddingDatabaseAdapter>;
    let mockModelManager: Mocked<CopilotModelManager>;
    let contextProvider: ContextProvider;
    let mockExtensionContext: vscode.ExtensionContext;


    beforeEach(() => {
        // Reset mocks for vscode APIs that might have been called in previous tests
        vi.mocked(vscode.commands.executeCommand).mockReset();
        vi.mocked(vscode.workspace.fs.readFile).mockReset();
        vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat); // Default to file exists
        vi.mocked(vscode.workspace.asRelativePath).mockImplementation(uriOrPath => typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath);

        // More robust Uri.file mock for consistent path handling
        (vscode.Uri as any).file = vi.fn((inputPath: string) => {
            const systemPath = path.normalize(inputPath); // d:\dev\copilot-review\src\test.ts or /root/src/test.ts
            let posixPath = systemPath.replace(/\\/g, '/'); // d:/dev/copilot-review/src/test.ts or /root/src/test.ts

            // Ensure it starts with a slash if it's a full path (e.g. C:/... -> /C:/...)
            if (posixPath.match(/^[a-zA-Z]:\//)) { // Windows absolute path
                posixPath = '/' + posixPath;
            } else if (!posixPath.startsWith('/')) { // Relative path
                posixPath = '/' + posixPath;
            }


            return {
                fsPath: systemPath, // System-dependent path
                path: posixPath,    // POSIX-style path for internal consistency in tests
                scheme: 'file',
                authority: '',
                query: '',
                fragment: '',
                with: vi.fn().mockReturnThis(),
                toString: () => `file://${posixPath}`
            };
        });


        mockCodeAnalysisService = new (CodeAnalysisService as any)() as Mocked<CodeAnalysisService>;
        mockDbAdapter = new (EmbeddingDatabaseAdapter as any)({} as any, {} as any, {} as any) as Mocked<EmbeddingDatabaseAdapter>;
        mockModelManager = new (CopilotModelManager as any)({} as any) as Mocked<CopilotModelManager>;

        mockExtensionContext = {
            extensionPath: '/mock/extension',
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        contextProvider = ContextProvider.createSingleton(
            mockExtensionContext,
            mockDbAdapter,
            mockModelManager,
            mockCodeAnalysisService
        );

        vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(Buffer.from('file content'));
        if (!vi.isMockFunction(mockCodeAnalysisService.findSymbols)) {
            vi.spyOn(mockCodeAnalysisService, 'findSymbols').mockResolvedValue([]);
        }
        if (!vi.isMockFunction(mockDbAdapter.findRelevantCodeContextForChunks)) {
            vi.spyOn(mockDbAdapter, 'findRelevantCodeContextForChunks').mockResolvedValue([]);
        }
    });

    it('should call findSymbols and filter them based on diff ranges, then call LSP providers', async () => {
        const diffText = `
diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,5 +1,6 @@
 function oldFunc() {}
+function newFunc() {} // This is line 2 (0-indexed line 1)
 function anotherFunc() {}
+const newVar = 123; // This is line 4 (0-indexed line 3)
        `;
        const gitRootPath = '/root'; // POSIX style for consistency

        const allSymbols: SymbolInfo[] = [
            { symbolName: 'oldFunc', symbolType: 'function_declaration', position: { line: 0, character: 9 } },
            { symbolName: 'newFunc', symbolType: 'function_declaration', position: { line: 1, character: 9 } }, // In diff
            { symbolName: 'anotherFunc', symbolType: 'function_declaration', position: { line: 2, character: 9 } },
            { symbolName: 'newVar', symbolType: 'variable_declarator', position: { line: 3, character: 6 } }, // In diff
            { symbolName: 'unrelatedFunc', symbolType: 'function_declaration', position: { line: 10, character: 9 } },
        ];

        vi.spyOn(mockCodeAnalysisService, 'findSymbols').mockResolvedValue(allSymbols);
        vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([]); // Default to no results for LSP
        vi.spyOn(mockDbAdapter, 'findRelevantCodeContextForChunks').mockResolvedValue([]);

        await contextProvider.getContextForDiff(diffText, gitRootPath, {}, AnalysisMode.Comprehensive);

        const expectedFilePath = path.join(gitRootPath, 'src/test.ts');
        const expectedUriObject = vscode.Uri.file(expectedFilePath);


        expect(mockCodeAnalysisService.findSymbols).toHaveBeenCalledWith('file content', 'typescript', undefined);

        // Call 1: Definition for newFunc
        expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(1,
            'vscode.executeDefinitionProvider',
            expect.objectContaining({ path: expectedUriObject.path, fsPath: expectedUriObject.fsPath }),
            expect.objectContaining({ line: 1, character: 9 }), // Position for newFunc
            expect.anything() // Cancellation token
        );

        // Call 2: References for newFunc
        expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2,
            'vscode.executeReferenceProvider',
            expect.objectContaining({ path: expectedUriObject.path, fsPath: expectedUriObject.fsPath }),
            expect.objectContaining({ line: 1, character: 9 }), // Position for newFunc
            { includeDeclaration: false },
            expect.anything() // Cancellation token
        );

        // Call 3: Definition for newVar
        expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(3,
            'vscode.executeDefinitionProvider',
            expect.objectContaining({ path: expectedUriObject.path, fsPath: expectedUriObject.fsPath }),
            expect.objectContaining({ line: 3, character: 6 }), // Position for newVar
            expect.anything() // Cancellation token
        );

        // Call 4: References for newVar
        expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(4,
            'vscode.executeReferenceProvider',
            expect.objectContaining({ path: expectedUriObject.path, fsPath: expectedUriObject.fsPath }),
            expect.objectContaining({ line: 3, character: 6 }), // Position for newVar
            { includeDeclaration: false },
            expect.anything() // Cancellation token
        );


        // Assert it was NOT called for symbols outside the diff range (oldFunc and unrelatedFunc)
        // This check needs to be more specific if we want to ensure no *other* calls were made.
        // For now, checking that the total calls are 4 (2 symbols * 2 LSP calls each) is a good indicator.
        expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(4);

        // Explicitly check that oldFunc was not processed by LSP
        const wasOldFuncProcessed = vi.mocked(vscode.commands.executeCommand).mock.calls.some(callArgs => {
            const positionArg = callArgs[2] as vscode.Position; // Position is the 3rd arg for def, 3rd for ref
            return positionArg && positionArg.line === 0 && positionArg.character === 9;
        });
        expect(wasOldFuncProcessed).toBe(false);

        const wasUnrelatedFuncProcessed = vi.mocked(vscode.commands.executeCommand).mock.calls.some(callArgs => {
            const positionArg = callArgs[2] as vscode.Position;
            return positionArg && positionArg.line === 10 && positionArg.character === 9;
        });
        expect(wasUnrelatedFuncProcessed).toBe(false);
    });
});
import { describe, it, expect, vi, beforeEach, afterEach, Mock, Mocked } from 'vitest';
import * as vscode from 'vscode';
import { ContextProvider, DiffSymbolInfo } from '../services/contextProvider';
import { EmbeddingDatabaseAdapter } from '../services/embeddingDatabaseAdapter';
import { CopilotModelManager } from '../models/copilotModelManager';
import { CodeAnalysisService, type SymbolInfo } from '../services/codeAnalysisService';
import { SimilaritySearchResult } from '../types/embeddingTypes';
import { AnalysisMode } from '../types/modelTypes';
import {
    type ContextSnippet,
    type DiffHunk, // Added for checking parsedDiff
    type HybridContextResult // Added for the new return type
} from '../types/contextTypes';
import * as path from 'path';

function snippetsContainText(snippets: ContextSnippet[], text: string): boolean {
    return snippets.some(snippet => snippet.content.includes(text));
}

// Hoist all mock functions needed by mock factories
const hoistedMocks = vi.hoisted(() => {
    return {
        // For EmbeddingDatabaseAdapter
        findRelevantCodeContextForChunks: vi.fn(),
        getStorageStats: vi.fn(),
        optimizeStorage: vi.fn(),
        embeddingDatabaseAdapterDispose: vi.fn(),
    };
});

// Mock dependencies
// Define a mock class for the structure returned by CopilotModelManager.getCurrentModel()
// This structure should align with parts of vscode.LanguageModelChat
class MockLanguageModelChatInstance {
    public id: string;
    public name: string;
    public family?: string;
    public maxInputTokens: number;
    public vendor: string;
    public version: string;
    public countTokens: Mock<(message: string | vscode.LanguageModelChatMessage, token?: vscode.CancellationToken) => Promise<number>>;
    public sendRequest: Mock<(...args: any[]) => Promise<vscode.LanguageModelChatResponse>>; // Simplified types for now

    constructor(options: {
        id: string;
        name: string;
        family?: string;
        maxInputTokens: number;
        vendor: string;
        version: string;
    }) {
        this.id = options.id;
        this.name = options.name;
        this.family = options.family;
        this.maxInputTokens = options.maxInputTokens;
        this.vendor = options.vendor;
        this.version = options.version;
        this.countTokens = vi.fn().mockResolvedValue(10); // CRITICAL MOCK
        this.sendRequest = vi.fn().mockResolvedValue({ stream: { read: () => null } }); // Mock sendRequest to return a compliant structure
    }
}

const mockCurrentModelForManager = new MockLanguageModelChatInstance({
    id: 'mock-id-factory',
    name: 'mock-model-from-factory',
    family: 'mock-family-factory',
    maxInputTokens: 8192,
    vendor: 'mock-vendor-factory',
    version: '1.1',
});

const mockAvailableModelsForManager = [
    mockCurrentModelForManager, // Use the instance
    new MockLanguageModelChatInstance({
        id: 'other-mock-model-id-factory',
        name: 'other-mock-model-factory',
        vendor: 'mock-vendor-factory',
        family: 'other-mock-family-factory',
        version: '1.0',
        maxInputTokens: 4096,
        // countTokens will default to mockResolvedValue(10) from the class constructor
        // sendRequest will also default
    })
];

vi.mock('../models/copilotModelManager', () => {
    // console.log('[TEST DEBUG] CopilotModelManager mock factory executing');
    class MockCopilotModelManagerClass {
        constructor(...args: any[]) {
            // console.log('[TEST DEBUG] MockCopilotModelManagerClass constructor called with:', args);
            // You can add constructor logic here if needed, e.g., storing args
        }
        initialize = vi.fn().mockResolvedValue(undefined);
        getCurrentModel = vi.fn().mockResolvedValue(mockCurrentModelForManager);
        listAvailableModels = vi.fn().mockResolvedValue(mockAvailableModelsForManager);
        onModelDidChange = vi.fn(() => ({ dispose: vi.fn() }));
        dispose = vi.fn();
    }
    return { CopilotModelManager: MockCopilotModelManagerClass };
});

vi.mock('../services/embeddingDatabaseAdapter', () => {
    const mockAdapterInstance = {
        findRelevantCodeContextForChunks: hoistedMocks.findRelevantCodeContextForChunks,
        getStorageStats: hoistedMocks.getStorageStats,
        optimizeStorage: hoistedMocks.optimizeStorage,
        dispose: hoistedMocks.embeddingDatabaseAdapterDispose,
    };
    return {
        EmbeddingDatabaseAdapter: {
            getInstance: vi.fn(() => mockAdapterInstance),
        },
    };
});

vi.mock('../services/codeAnalysisService');


describe('ContextProvider - Hybrid Context Retrieval (getContextForDiff)', () => {
    let contextProvider: ContextProvider;
    let mockEmbeddingDatabaseAdapterInstance: ReturnType<typeof EmbeddingDatabaseAdapter.getInstance>;
    let mockModelManager: Mocked<CopilotModelManager>;
    let mockExtensionContext: vscode.ExtensionContext;
    let mockCodeAnalysisService: Mocked<CodeAnalysisService>;


    beforeEach(async () => {
        // Reset EmbeddingDatabaseAdapter mocks via hoistedMocks
        hoistedMocks.findRelevantCodeContextForChunks.mockReset();
        hoistedMocks.getStorageStats.mockReset();
        hoistedMocks.optimizeStorage.mockReset();
        hoistedMocks.embeddingDatabaseAdapterDispose.mockReset();


        mockExtensionContext = {
            extensionPath: '/mock/extension',
            subscriptions: [],
            workspaceState: { get: vi.fn(), update: vi.fn() },
            globalState: { get: vi.fn(), update: vi.fn(), setKeysForSync: vi.fn() },
            secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() },
            extensionUri: vscode.Uri.file('/mock/extension'),
            storageUri: vscode.Uri.file('/mock/storage'),
            globalStorageUri: vscode.Uri.file('/mock/globalStorage'),
            logUri: vscode.Uri.file('/mock/log'),
            extensionMode: vscode.ExtensionMode.Test,
            extension: { id: 'mock.extension', extensionPath: '/mock/extension', isActive: true, packageJSON: {}, extensionKind: vscode.ExtensionKind.Workspace, exports: {} },
            asAbsolutePath: (relativePath: string) => path.join('/mock/extension', relativePath),

        } as unknown as vscode.ExtensionContext;

        // Get the mocked instance. EmbeddingDatabaseAdapter.getInstance() will return our mockAdapterInstance.
        // The arguments to getInstance don't matter much here as it's mocked.
        mockEmbeddingDatabaseAdapterInstance = EmbeddingDatabaseAdapter.getInstance(
            mockExtensionContext, {} as any, {} as any, {} as any
        );

        mockModelManager = new (CopilotModelManager as any)(vi.fn() as any) as Mocked<CopilotModelManager>;
        mockCodeAnalysisService = new (CodeAnalysisService as any)() as Mocked<CodeAnalysisService>;

        // Re-establish mock behaviors that might have been reset by Vitest's global mock reset policies
        mockCurrentModelForManager.countTokens.mockResolvedValue(10);
        mockCurrentModelForManager.sendRequest.mockResolvedValue({ stream: { read: () => null } } as any); // Re-affirm sendRequest mock

        mockAvailableModelsForManager.forEach(modelInstance => {
            if (modelInstance.id !== mockCurrentModelForManager.id) {
                modelInstance.countTokens.mockResolvedValue(8); // Example: different value for other models
                modelInstance.sendRequest.mockResolvedValue({ stream: { read: () => null } } as any);
            }
        });

        contextProvider = ContextProvider.createSingleton(
            mockExtensionContext,
            mockEmbeddingDatabaseAdapterInstance, // Pass the controlled mock instance
            mockModelManager,
            mockCodeAnalysisService
        );

        // Mock vscode.workspace.fs
        vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async (uri: vscode.Uri) => {
            if (uri.fsPath.endsWith('file1.ts')) {
                // This should represent the NEW content of the file after the diff is applied,
                // as this is what the symbol analyzer would see in the workspace.
                const newContent = `// Full content of file1.ts
export function anotherFunction() {}
export function changedFunction(param: string): void {
  console.log(param);
}`;
                return Buffer.from(newContent);
            }
            return Buffer.from('');
        });
        vi.spyOn(vscode.workspace.fs, 'stat').mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);

        // Mock vscode.workspace.openTextDocument and asRelativePath
        vi.spyOn(vscode.workspace, 'openTextDocument').mockImplementation(
            async (uriOrOptions?: vscode.Uri | string | { language?: string; content?: string }): Promise<vscode.TextDocument> => {
                let resolvedFileName: string;
                let resolvedContent: string = ''; // Default empty content
                let resolvedLanguageId: string = 'plaintext'; // Default language
                let resolvedUri: vscode.Uri;

                if (typeof uriOrOptions === 'string') {
                    // Argument is a file path string
                    resolvedFileName = uriOrOptions;
                    resolvedUri = vscode.Uri.file(resolvedFileName);
                } else if (uriOrOptions instanceof vscode.Uri) {
                    // Argument is a Uri object
                    resolvedUri = uriOrOptions;
                    // Use fsPath for file URIs, path for others (e.g., untitled, http)
                    resolvedFileName = resolvedUri.scheme === 'file' ? resolvedUri.fsPath : resolvedUri.path;
                } else if (uriOrOptions && (uriOrOptions.content !== undefined || uriOrOptions.language !== undefined)) {
                    // Argument is an options object with content or language
                    resolvedContent = uriOrOptions.content || '';
                    resolvedLanguageId = uriOrOptions.language || 'plaintext';
                    const extension = resolvedLanguageId !== 'plaintext' ? `.${resolvedLanguageId}` : '.txt';
                    // Create a unique URI for untitled documents generated with content/language
                    resolvedUri = vscode.Uri.parse(`untitled:generated-${Date.now()}${extension}`);
                    resolvedFileName = resolvedUri.path; // e.g., "generated-12345.typescript"
                } else {
                    // Argument is undefined or an empty options object, for a new untitled document
                    resolvedUri = vscode.Uri.parse(`untitled:new-${Date.now()}.txt`);
                    resolvedFileName = resolvedUri.path; // e.g., "new-12345.txt"
                    // resolvedContent and resolvedLanguageId keep their default values (empty string and 'plaintext')
                }

                // Existing logic to provide specific content for certain test files.
                // This might override content/language set from options if resolvedFileName matches.
                if (resolvedFileName.endsWith('file1.ts')) {
                    resolvedContent = 'export function changedFunction(param: string): void {\n  console.log(param);\n}\n';
                    resolvedLanguageId = 'typescript';
                } else if (resolvedFileName.endsWith('dep.ts')) {
                    resolvedContent = 'export function helper(): number { return 1; }';
                    resolvedLanguageId = 'typescript';
                }

                return {
                    uri: resolvedUri,
                    fileName: resolvedFileName,
                    getText: () => resolvedContent,
                    lineAt: (line: number) => ({ text: resolvedContent.split('\n')[line] || '' }), // Basic mock for lineAt
                    lineCount: resolvedContent.split('\n').length,
                    languageId: resolvedLanguageId,
                } as any; // Keeping 'as any' to match the original style of this specific mock object structure
            });
        vi.spyOn(vscode.workspace, 'asRelativePath').mockImplementation((uriOrPath: vscode.Uri | string) => {
            if (typeof uriOrPath === 'string') return uriOrPath;
            return uriOrPath.fsPath.startsWith('/mock/repo/') ? uriOrPath.fsPath.substring('/mock/repo/'.length) : uriOrPath.fsPath;
        });


        // Mock LSP commands
        vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (command: string, ...args: any[]) => {
            const uri = args[0] as vscode.Uri;
            const position = args[1] as vscode.Position;

            if (command === 'vscode.executeDefinitionProvider') {
                if (uri.fsPath.endsWith('file1.ts') && position.line === 2) { // changedFunction
                    return [
                        {
                            uri: vscode.Uri.file('/mock/repo/src/file1.ts'),
                            range: {
                                start: { line: 2, character: 0 },
                                end: { line: 2, character: 20 }
                            } as vscode.Range,
                        },
                    ] as vscode.Location[];
                }
            }
            if (command === 'vscode.executeReferenceProvider') {
                if (uri.fsPath.endsWith('file1.ts') && position.line === 2) { // changedFunction
                    return [
                        {
                            uri: vscode.Uri.file('/mock/repo/src/dep.ts'),
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 10 }
                            } as vscode.Range,
                        },
                    ] as vscode.Location[];
                }
            }
            return []; // Return empty array for other calls to prevent undefined errors
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        (ContextProvider as any).instance = null; // Reset singleton
    });

    it('should retrieve and combine LSP and embedding context', async () => {
        const diff = `diff --git a/src/file1.ts b/src/file1.ts
index 123..456 100644
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,3 +1,5 @@
 // Full content of file1.ts
-export function oldFunction() {}
-export function changedFunction() {}
+export function anotherFunction() {}
+export function changedFunction(param: string): void {
+  console.log(param);
+}
`;
        const gitRootPath = '/mock/repo';

        // Mock symbol identification from CodeAnalysisService
        // This mock should return all symbols that would be found in the NEW file content.
        // The ContextProvider will then filter them based on the diff.
        const allSymbolsInNewFile: SymbolInfo[] = [
            {
                symbolName: 'anotherFunction',
                symbolType: 'function',
                position: new vscode.Position(1, 17), // Line 2 in file, 0-indexed
            },
            {
                symbolName: 'changedFunction',
                symbolType: 'function',
                position: new vscode.Position(2, 17), // Line 3 in file, 0-indexed
            },
        ];
        vi.spyOn(mockCodeAnalysisService, 'findSymbols').mockResolvedValue(allSymbolsInNewFile);


        // Mock embedding search results
        const mockEmbeddingResults: SimilaritySearchResult[] = [
            {
                chunkId: 'chunk1',
                fileId: 'file2',
                filePath: 'src/utils/helpers.ts',
                content: 'export function helperUtil() { /* ... */ }',
                startOffset: 0,
                endOffset: 100,
                score: 0.85,
            },
        ];
        hoistedMocks.findRelevantCodeContextForChunks.mockResolvedValue(mockEmbeddingResults);

        const result: HybridContextResult = await contextProvider.getContextForDiff(diff, gitRootPath, undefined, AnalysisMode.Comprehensive);
        const { snippets, parsedDiff } = result;

        // Check for LSP definition snippets for `changedFunction`
        expect(snippetsContainText(snippets, '**Definition in `src/file1.ts:3`:**')).toBe(true);
        expect(snippetsContainText(snippets, 'export function changedFunction(param: string): void {')).toBe(true);

        // Check for LSP reference snippets for `changedFunction`
        expect(snippetsContainText(snippets, '**Reference in `src/dep.ts:1`:**')).toBe(true);
        expect(snippetsContainText(snippets, 'export function helper(): number { return 1; }')).toBe(true);


        // Check for embedding results
        expect(snippetsContainText(snippets, '### File: `src/utils/helpers.ts`')).toBe(true);
        expect(snippetsContainText(snippets, 'export function helperUtil() { /* ... */ }')).toBe(true);
        if (mockEmbeddingResults.length > 0) {
            expect(snippetsContainText(snippets, '### File:')).toBe(true);
        }

        // Verify parsedDiff structure and hunkId
        expect(parsedDiff).toBeInstanceOf(Array);
        expect(parsedDiff.length).toBeGreaterThan(0);
        const file1Diff = parsedDiff.find(pd => pd.filePath === 'src/file1.ts');
        expect(file1Diff).toBeDefined();
        expect(file1Diff?.hunks).toBeInstanceOf(Array);
        expect(file1Diff?.hunks.length).toBeGreaterThan(0);
        expect(file1Diff?.hunks[0].hunkId).toBe('src/file1.ts:1'); // Based on @@ -1,3 +1,5 @@

        // Verify snippet association with hunkId
        const lspDefSnippet = snippets.find(s => s.type === 'lsp-definition' && s.content.includes('changedFunction'));
        expect(lspDefSnippet).toBeDefined();
        expect(lspDefSnippet?.associatedHunkIdentifiers).toContain('src/file1.ts:1');


        // Verify mocks
        expect(mockCodeAnalysisService.findSymbols).toHaveBeenCalled();
        // It should have been called for both symbols in the diff
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.executeDefinitionProvider',
            expect.objectContaining({ fsPath: expect.stringContaining('file1.ts') }),
            expect.objectContaining({ line: 1, character: 17 }), // for anotherFunction
            expect.any(Object)
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.executeDefinitionProvider',
            expect.objectContaining({ fsPath: expect.stringContaining('file1.ts') }),
            expect.objectContaining({ line: 2, character: 17 }), // for changedFunction
            expect.any(Object)
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.executeReferenceProvider',
            expect.objectContaining({ fsPath: expect.stringContaining('file1.ts') }),
            expect.objectContaining({ line: 2, character: 17 }), // for changedFunction
            { includeDeclaration: false },
            expect.any(Object)
        );
        // The first argument (embeddingQueries) is dynamically generated based on the diff.
        // We'll check its type and that it contains expected substrings.
        const findRelevantCodeContextForChunksCalls = hoistedMocks.findRelevantCodeContextForChunks.mock.calls;
        expect(findRelevantCodeContextForChunksCalls.length).toBeGreaterThanOrEqual(1);
        const firstCallArgs = findRelevantCodeContextForChunksCalls[0];
        expect(firstCallArgs[0]).toEqual(expect.arrayContaining([
            expect.stringContaining('changedFunction'),
            expect.stringContaining('export function anotherFunction()')
        ]));
        expect(firstCallArgs[1]).toEqual(expect.objectContaining({ // SearchOptions
            limit: 25,
            minScore: 0.65,
        }));
        expect(firstCallArgs[2]).toEqual(expect.any(Function)); // ProgressCallback
        expect(firstCallArgs[3]).toBeUndefined(); // CancellationToken
        // Optionally, check if the first argument is an array of strings if it's not empty
        const calls = hoistedMocks.findRelevantCodeContextForChunks.mock.calls;
        if (calls.length > 0 && calls[0][0].length > 0) {
            expect(calls[0][0].every((item: any) => typeof item === 'string')).toBe(true);
        }
    });


    it('should handle cases where no symbols are found for LSP', async () => {
        const diff = `
diff --git a/src/file1.ts b/src/file1.ts
index 123..456 100644
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,1 +1,1 @@
 -old content
 +new content without clear symbols
`;
        const gitRootPath = '/mock/repo';
        vi.spyOn(mockCodeAnalysisService, 'findSymbols').mockResolvedValue([]); // No symbols

        const mockEmbeddingResults: SimilaritySearchResult[] = [{
            chunkId: 'emb1', fileId: 'f1', filePath: 'src/some_other_file.ts', content: 'embedding context', score: 0.9, startOffset: 0, endOffset: 10
        }];
        hoistedMocks.findRelevantCodeContextForChunks.mockResolvedValue(mockEmbeddingResults);

        const result = await contextProvider.getContextForDiff(diff, gitRootPath);
        const { snippets, parsedDiff } = result;

        // No LSP symbols, so no LSP-specific content like "**Definition in" is expected.
        expect(snippetsContainText(snippets, '**Definition in')).toBe(false);
        expect(snippetsContainText(snippets, '**Reference in')).toBe(false);
        // Embeddings are expected, so check for their content and file header.
        expect(snippetsContainText(snippets, '### File:')).toBe(true);
        expect(snippetsContainText(snippets, 'src/some_other_file.ts')).toBe(true);

        // Check parsedDiff
        expect(parsedDiff.length).toBeGreaterThan(0);
        expect(parsedDiff[0].hunks[0].hunkId).toBeDefined();


        // Check the call to findRelevantCodeContextForChunks
        const noSymbolsCalls = hoistedMocks.findRelevantCodeContextForChunks.mock.calls;
        expect(noSymbolsCalls.length).toBeGreaterThanOrEqual(1);
        const noSymbolsFirstCallArgs = noSymbolsCalls[0];
        expect(noSymbolsFirstCallArgs[0]).toEqual(expect.any(Array)); // Embedding queries (might be just the raw diff lines)
        expect(noSymbolsFirstCallArgs[1]).toEqual(expect.objectContaining({ // SearchOptions
            minScore: expect.any(Number), // Default or mode-specific minScore
            limit: expect.any(Number)     // Default or mode-specific limit
        }));
        expect(noSymbolsFirstCallArgs[2]).toEqual(expect.any(Function)); // ProgressCallback
        expect(noSymbolsFirstCallArgs[3]).toBeUndefined(); // CancellationToken

        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vscode.executeDefinitionProvider', expect.anything(), expect.anything(), expect.anything());
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('vscode.executeReferenceProvider', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    });

    it('should handle cases where LSP calls return no locations', async () => {
        const diff = `
diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,1 +1,1 @@
+export function newFunction() {}
`;
        const gitRootPath = '/mock/repo';
        vi.spyOn(mockCodeAnalysisService, 'findSymbols').mockResolvedValue([
            { symbolName: 'newFunction', symbolType: 'function', position: new vscode.Position(0, 17) }
        ]);
        vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([]); // LSP returns no locations

        const mockEmbeddingResults: SimilaritySearchResult[] = [{
            chunkId: 'emb1', fileId: 'f1', filePath: 'src/some_other_file.ts', content: 'embedding context', score: 0.9, startOffset: 0, endOffset: 10
        }];
        hoistedMocks.findRelevantCodeContextForChunks.mockResolvedValue(mockEmbeddingResults);

        const result = await contextProvider.getContextForDiff(diff, gitRootPath);
        const { snippets, parsedDiff } = result;

        // LSP calls return no locations, so no LSP-specific content expected
        expect(snippetsContainText(snippets, '**Definition in')).toBe(false);
        expect(snippetsContainText(snippets, '**Reference in')).toBe(false);
        expect(snippetsContainText(snippets, 'src/some_other_file.ts')).toBe(true);
        // Check if the embedding section header is present
        expect(snippetsContainText(snippets, '### File:')).toBe(true);

        // Check parsedDiff
        expect(parsedDiff.length).toBeGreaterThan(0);
        expect(parsedDiff[0].hunks[0].hunkId).toBeDefined();

        // Check the call to findRelevantCodeContextForChunks
        const noLspLocationsCalls = hoistedMocks.findRelevantCodeContextForChunks.mock.calls;
        expect(noLspLocationsCalls.length).toBeGreaterThanOrEqual(1);
        const noLspLocationsFirstCallArgs = noLspLocationsCalls[0];
        expect(noLspLocationsFirstCallArgs[0]).toEqual(expect.any(Array)); // Embedding queries
        expect(noLspLocationsFirstCallArgs[1]).toEqual(expect.objectContaining({ // SearchOptions
            minScore: expect.any(Number),
            limit: expect.any(Number)
        }));
        expect(noLspLocationsFirstCallArgs[2]).toEqual(expect.any(Function)); // ProgressCallback
        expect(noLspLocationsFirstCallArgs[3]).toBeUndefined(); // CancellationToken

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.executeDefinitionProvider', expect.anything(), expect.anything(), expect.anything());
    });


    it('should handle cancellation during LSP/embedding search', async () => {
        const diff = `diff --git a/src/file1.ts b/src/file1.ts\n--- a/src/file1.ts\n+++ b/src/file1.ts\n@@ -1,1 +1,1 @@\n+content`;
        const gitRootPath = '/mock/repo';
        const cancellationTokenSource = new vscode.CancellationTokenSource();

        vi.spyOn(mockCodeAnalysisService, 'findSymbols').mockResolvedValue([
            { symbolName: 'testFunc', symbolType: 'function', position: new vscode.Position(0, 0) }
        ]);

        vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (command, ...args) => {
            const tokenFromArgs = args.find(arg => arg && typeof arg.isCancellationRequested === 'boolean');
            if (tokenFromArgs?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            // Simulate some delay
            await new Promise(resolve => setTimeout(resolve, 10));
            if (command === 'vscode.executeDefinitionProvider') return [];
            return undefined;
        });

        hoistedMocks.findRelevantCodeContextForChunks.mockImplementation(async (chunks, opts, cb, token) => {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            await new Promise(resolve => setTimeout(resolve, 10));
            return [];
        });

        // Test cancellation after symbol extraction but before LSP/embedding
        cancellationTokenSource.cancel(); // Cancel immediately
        await expect(contextProvider.getContextForDiff(diff, gitRootPath, undefined, AnalysisMode.Comprehensive, undefined, cancellationTokenSource.token))
            .rejects.toThrow('Operation cancelled'); // This will be caught by the first check in getContextForDiff


        // Test cancellation during LSP (more involved to set up precisely, relying on internal checks)
        const cts2 = new vscode.CancellationTokenSource();
        const lspPromise = contextProvider.getContextForDiff(diff, gitRootPath, undefined, AnalysisMode.Comprehensive, undefined, cts2.token);
        setTimeout(() => cts2.cancel(), 5); // Cancel during the "LSP calls"
        // This error is thrown by a check in getContextForDiff *after* Promise.allSettled for LSP calls
        await expect(lspPromise).rejects.toThrow('Operation cancelled');


        // Test cancellation during embedding
        const cts3 = new vscode.CancellationTokenSource();
        vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([]); // Ensure LSP part finishes quickly
        const embeddingPromise = contextProvider.getContextForDiff(diff, gitRootPath, undefined, AnalysisMode.Comprehensive, undefined, cts3.token);
        setTimeout(() => cts3.cancel(), 5); // Cancel at 5ms (mock's internal delay is 10ms)
        // This error is thrown by a check in getContextForDiff *after* Promise.allSettled for embedding search
        await expect(embeddingPromise).rejects.toThrow('Operation cancelled');

    });

    it('should return fallback context if both LSP and embeddings yield no results', async () => {
        const diff = `diff --git a/src/file1.ts b/src/file1.ts\n--- a/src/file1.ts\n+++ b/src/file1.ts\n@@ -1,1 +1,1 @@\n+content`;
        const gitRootPath = '/mock/repo';

        vi.spyOn(mockCodeAnalysisService, 'findSymbols').mockResolvedValue([]); // No symbols
        vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([]); // No LSP results
        hoistedMocks.findRelevantCodeContextForChunks.mockResolvedValue([]); // No embedding results

        // Mock getFallbackContextSnippets to check if it's called
        const fallbackSnippets = [{ id: 'fallback-1', type: 'embedding', content: 'Fallback context triggered.', relevanceScore: 0.5, filePath: 'fallback.txt', startLine: 0 }];
        const fallbackSpy = vi.spyOn(contextProvider as any, 'getFallbackContextSnippets').mockResolvedValue(fallbackSnippets);

        const result = await contextProvider.getContextForDiff(diff, gitRootPath);
        const { snippets, parsedDiff } = result;


        expect(fallbackSpy).toHaveBeenCalled();
        expect(snippetsContainText(snippets, "Fallback context triggered.")).toBe(true);
        expect(snippets).toEqual(expect.arrayContaining(fallbackSnippets)); // Ensure the fallback snippets are returned

        // Check the call to findRelevantCodeContextForChunks (this might be called by fallback)
        // The fallback mechanism in ContextProvider calls findRelevantCodeContextForChunks
        // with file paths or parent directories as queries.
        const fallbackCalls = hoistedMocks.findRelevantCodeContextForChunks.mock.calls;
        // Depending on whether the primary embedding search ran (even if it yielded no results)
        // vs. only the fallback ran, the number of calls might vary.
        // We are interested in the call made by the fallback logic.
        // The mock for findRelevantCodeContextForChunks is reset in beforeEach,
        // but the test itself calls getContextForDiff which internally calls findRelevantCodeContextForChunks.
        // If the initial embedding search (before fallback) uses empty queries, it might not call the adapter.
        // The test setup: hoistedMocks.findRelevantCodeContextForChunks.mockResolvedValue([]);
        // This means the primary embedding search will "succeed" with no results.
        // Then, getFallbackContextSnippets is mocked directly to return fallbackSnippets.
        // Its actual implementation (which calls findRelevantCodeContextForChunks) is NOT run.
        // Therefore, findRelevantCodeContextForChunks is only called ONCE by the primary embedding search.

        expect(fallbackCalls.length).toBe(1); // Only the primary call

        const firstCallArgs = fallbackCalls[0]; // Args for the primary embedding call
        // The embeddingQueries for "+content" diff will be ["content"]
        expect(firstCallArgs[0]).toEqual(expect.arrayContaining(["content"]));
        expect(firstCallArgs[1]).toEqual(expect.objectContaining({ // SearchOptions for primary search
            minScore: expect.any(Number), // Default or mode-specific minScore
            limit: expect.any(Number)     // Default or mode-specific limit
        }));
        expect(firstCallArgs[2]).toEqual(expect.any(Function)); // ProgressCallback
        expect(firstCallArgs[3]).toBeUndefined(); // CancellationToken

        // Check parsedDiff even in fallback case
        expect(parsedDiff.length).toBeGreaterThan(0);
        expect(parsedDiff[0].hunks[0].hunkId).toBeDefined();
    });
});

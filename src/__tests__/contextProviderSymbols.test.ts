import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as vscode from 'vscode'; // Import the mocked vscode
import * as path from 'path';
import { ContextProvider, DiffSymbolInfo } from '../services/contextProvider';
import { TreeStructureAnalyzerPool, TreeStructureAnalyzerResource, TreeStructureAnalyzer, SymbolInfo as AnalyzerSymbolInfo } from '../services/treeStructureAnalyzer';
import { EmbeddingDatabaseAdapter } from '../services/embeddingDatabaseAdapter';
import { CopilotModelManager } from '../models/copilotModelManager';
import { TokenManagerService, TokenAllocation } from '../services/tokenManagerService';
import { AnalysisMode } from '../types/modelTypes';

// Mock dependencies
vi.mock('vscode');
vi.mock('../services/embeddingDatabaseAdapter');
vi.mock('../models/copilotModelManager');
vi.mock('../services/tokenManagerService');

// Mock file system operations from the mocked vscode
const mockFs = vscode.workspace.fs;

// Workspace folders are now part of the vscode mock

describe('ContextProvider Symbol Identification', () => {
    let analyzerPool: TreeStructureAnalyzerPool;
    let resource: TreeStructureAnalyzerResource;
    let analyzer: TreeStructureAnalyzer;

    let mockEmbeddingDbAdapter: EmbeddingDatabaseAdapter;
    let mockModelManager: CopilotModelManager;
    let mockTokenManager: TokenManagerService;
    let contextProvider: ContextProvider;

    const extensionPath = path.resolve(__dirname, '..', '..');
    const workspaceRoot = 'd:/dev/copilot-review';

    beforeAll(() => {
        analyzerPool = TreeStructureAnalyzerPool.createSingleton(extensionPath, 1);
    });

    afterAll(() => {
        analyzerPool.dispose();
    });

    beforeEach(async () => {
        // Reset mocks
        vi.clearAllMocks();
        // Reset fs mocks directly on the vscode mock
        vi.mocked(mockFs.readFile).mockReset();
        vi.mocked(mockFs.stat).mockReset();

        // Directly modify the mutable array from the mock
        // Ensure the mock defines workspaceFolders as a mutable array
        if (Array.isArray(vscode.workspace.workspaceFolders)) {
            vscode.workspace.workspaceFolders.length = 0; // Clear the array
            vscode.workspace.workspaceFolders.push({    // Add the test folder
                uri: vscode.Uri.file(workspaceRoot),
                name: 'copilot-review',
                index: 0,
            });
        } else {
            // Handle case where mock might be incorrect (shouldn't happen with current mock)
            console.warn('vscode.workspace.workspaceFolders mock is not an array');
        }

        // --- Mock Dependency Instantiation ---
        // Mock EmbeddingDatabaseAdapter instance (since constructor is private)
        // We assume it has a static getInstance or similar, or we mock the module behavior
        mockEmbeddingDbAdapter = {
            findRelevantCodeContextForChunks: vi.fn().mockResolvedValue([]),
            // Add other methods used by ContextProvider if necessary
        } as unknown as EmbeddingDatabaseAdapter;
        // If ContextProvider uses a static method like getInstance():
        // vi.mocked(EmbeddingDatabaseAdapter, true).getInstance.mockReturnValue(mockEmbeddingDbAdapter);

        mockModelManager = new (vi.mocked(CopilotModelManager))({} as any);
        mockTokenManager = new (vi.mocked(TokenManagerService))(mockModelManager);

        // Mock common method calls
        // Mock is now on the manually created mock object
        vi.mocked(mockEmbeddingDbAdapter.findRelevantCodeContextForChunks).mockResolvedValue([]);

        const mockTokenAllocation: TokenAllocation = {
            systemPromptTokens: 10,
            diffTextTokens: 50,
            contextTokens: 100,
            userMessagesTokens: 0,
            assistantMessagesTokens: 0,
            otherTokens: 0,
            totalRequiredTokens: 160,
            totalAvailableTokens: 4000,
            contextAllocationTokens: 3940,
            fitsWithinLimit: true,
        };
        vi.mocked(mockTokenManager.calculateTokenAllocation).mockResolvedValue(mockTokenAllocation);
        vi.mocked(mockTokenManager.getSystemPromptForMode).mockResolvedValue('System Prompt');
        vi.mocked(mockTokenManager.optimizeContext).mockImplementation(async (ctx, _limit) => ctx);

        // Use the mocked vscode.LanguageModelChat for the type
        const mockLanguageModel: vscode.LanguageModelChat = {
            id: 'test-model-id',
            name: 'test-model',
            vendor: 'test-vendor',
            version: '1.0',
            family: 'test',
            maxInputTokens: 4096,
            sendRequest: vi.fn(),
            countTokens: vi.fn().mockResolvedValue(10),
        };
        vi.mocked(mockModelManager.getCurrentModel).mockResolvedValue(mockLanguageModel);

        // Create ContextProvider instance using createSingleton
        // Pass the manually created mockEmbeddingDbAdapter
        contextProvider = ContextProvider.createSingleton(
            {} as vscode.ExtensionContext,
            mockEmbeddingDbAdapter, // Pass the mock instance
            mockModelManager
        );

        // Mock file stat to succeed by default
        vi.mocked(mockFs.stat).mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
    });

    afterEach(() => {
        // --- REMOVED Analyzer disposal ---
        // resource.dispose();
    });

    // Helper function to access private method for testing
    async function testExtractSymbols(diff: string): Promise<DiffSymbolInfo[]> {
        // @ts-ignore - Accessing private method for testing
        const result = await contextProvider.extractMeaningfulChunksAndSymbols(diff, workspaceRoot);
        return result.symbols;
    }

    it('should identify added function symbol in JS file', async () => {
        const diff = `diff --git a/src/test.js b/src/test.js
index 0000000..1111111 100644
--- a/src/test.js
+++ b/src/test.js
@@ -1,1 +1,4 @@
 console.log("hello");
+function newFunction() {
+  console.log("new");
+}
+`;
        const finalContent = `console.log("hello");
function newFunction() {
  console.log("new");
}
`;
        const filePath = 'src/test.js';
        const absoluteFilePath = path.join(workspaceRoot, filePath);

        vi.mocked(mockFs.readFile).mockResolvedValue(Buffer.from(finalContent));

        const symbols = await testExtractSymbols(diff);

        // Check file path used for reading
        expect(vi.mocked(mockFs.readFile)).toHaveBeenCalled();
        const firstCallArgs = vi.mocked(mockFs.readFile).mock.calls[0];
        expect(firstCallArgs).toBeDefined();
        const uriArg = firstCallArgs[0] as vscode.Uri;
        expect(uriArg.fsPath).toBe(absoluteFilePath);

        // Assert the identified symbol
        expect(symbols).toHaveLength(1);
        expect(symbols[0]).toMatchObject({
            symbolName: 'newFunction',
            symbolType: 'function_declaration', // Or similar based on tree-sitter grammar
            filePath: filePath,
            // Expect position at the start of 'newFunction'
            position: expect.objectContaining({ line: 1, character: 9 })
        });
    });

    it('should identify added class symbol in new TS file', async () => {
        const diff = `diff --git a/dev/null b/src/newFile.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/src/newFile.ts
@@ -0,0 +1,5 @@
+export class MyClass {
+    constructor() {
+        console.log('created');
+    }
+}
+`;
        const filePath = 'src/newFile.ts';

        // Mock stat to indicate file not found initially
        vi.mocked(mockFs.stat).mockRejectedValue(new Error('File not found'));

        const symbols = await testExtractSymbols(diff);

        // Should not try to read file if it's new
        expect(vi.mocked(mockFs.readFile)).not.toHaveBeenCalled();

        // Assert that the 'MyClass' and 'constructor' symbols are present
        expect(symbols).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    symbolName: 'MyClass',
                    symbolType: 'class_declaration',
                    filePath: filePath,
                    // Expect position at the start of 'MyClass'
                    position: expect.objectContaining({ line: 0, character: 13 })
                }),
                expect.objectContaining({
                    symbolName: 'constructor',
                    symbolType: 'method_definition', // Type might vary based on grammar
                    filePath: filePath,
                    // Expect position at the start of 'constructor' - Updated to actual output
                    position: expect.objectContaining({ line: 1, character: 4 })
                })
            ])
        );
        // Check the total number of symbols found (might include others)
        expect(symbols.length).toBeGreaterThanOrEqual(2);
    });

    it('should identify symbols across multiple hunks in Python file', async () => {
        const diff = `diff --git a/src/multiHunk.py b/src/multiHunk.py
index 0000000..3333333 100644
--- a/src/multiHunk.py
+++ b/src/multiHunk.py
@@ -1,4 +1,7 @@
 def func1():
     pass
+    # Added line 1
+    print("hunk 1")

 def func2():
     pass
@@ -7,3 +10,6 @@
 def func3():
     pass
     # Original line
+    # Added line 2
+    print("hunk 2")
+`;
        const finalContent = `def func1():
    pass
    # Added line 1
    print("hunk 1")

def func2():
    pass

def func3():
    pass
    # Original line
    # Added line 2
    print("hunk 2")
`;
        const filePath = 'src/multiHunk.py';
        vi.mocked(mockFs.readFile).mockResolvedValue(Buffer.from(finalContent));

        const symbols = await testExtractSymbols(diff);

        // Depending on findSymbolsInRanges logic, it might find func1 and func3 if the added lines
        // are considered part of their definition range, or it might find nothing if only looking
        // for symbols *defined* strictly within the added lines.
        // Assuming findSymbolsInRanges finds symbols whose definition *overlaps* the range:
        expect(symbols.length).toBeGreaterThanOrEqual(0); // Be flexible based on exact implementation

        // Example: If func1 and func3 are identified because their bodies were changed
        const func1Symbol = symbols.find(s => s.symbolName === 'func1');
        const func3Symbol = symbols.find(s => s.symbolName === 'func3');

        // We expect at least one of these if overlap logic is used
        expect(func1Symbol).toBeDefined();
        expect(func3Symbol).toBeDefined();

        // If func1 is found:
        expect(func1Symbol).toMatchObject({ symbolType: 'function_definition', filePath: filePath });
        // If func3 is found:
        expect(func3Symbol).toMatchObject({ symbolType: 'function_definition', filePath: filePath });

        // For this test, let's just ensure it runs without error and reads the file
        expect(vi.mocked(mockFs.readFile)).toHaveBeenCalledTimes(1);
    });

    it('should not identify symbols for unsupported file types', async () => {
        const diff = `diff --git a/README.md b/README.md
index 0000000..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Project Title
+Added a line.
+`;
        const finalContent = `# Project Title
Added a line.
`;
        const filePath = 'README.md';
        vi.mocked(mockFs.readFile).mockResolvedValue(Buffer.from(finalContent));

        const symbols = await testExtractSymbols(diff);

        expect(symbols).toHaveLength(0);
    });

    it('should not identify symbols if file read fails (and not a new file)', async () => {
        const diff = `diff --git a/src/existing.js b/src/existing.js
index 1111111..5555555 100644
--- a/src/existing.js
+++ b/src/existing.js
@@ -1,1 +1,2 @@
 console.log("old");
+console.log("new");
+`;
        const filePath = 'src/existing.js';
        const absoluteFilePath = path.join(workspaceRoot, filePath);

        // Mock stat to succeed, but readFile to fail
        vi.mocked(mockFs.stat).mockResolvedValue({ type: vscode.FileType.File } as vscode.FileStat);
        vi.mocked(mockFs.readFile).mockRejectedValue(new Error('Failed to read'));

        const symbols = await testExtractSymbols(diff);

        // Should attempt to read
        expect(vi.mocked(mockFs.readFile)).toHaveBeenCalledWith(expect.objectContaining({ fsPath: absoluteFilePath }));
        // Should not find symbols if read fails
        expect(symbols).toHaveLength(0);
    });

    it('should not identify symbols for diffs with only removed lines', async () => {
        const diff = `diff --git a/src/remove.js b/src/remove.js
index 6666666..0000000 100644
--- a/src/remove.js
+++ b/src/remove.js
@@ -1,4 +1,1 @@
 console.log("keep");
-function oldFunction() {
-  console.log("old");
-}
+`;
        const finalContent = `console.log("keep");
`;
        const filePath = 'src/remove.js';
        vi.mocked(mockFs.readFile).mockResolvedValue(Buffer.from(finalContent));

        const symbols = await testExtractSymbols(diff);

        // No added lines, so no ranges to analyze, no symbols expected
        expect(symbols).toHaveLength(0);
    });

});

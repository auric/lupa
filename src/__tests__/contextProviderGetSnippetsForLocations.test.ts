import * as vscode from 'vscode';
import { vi, describe, it, expect, beforeEach, afterEach, vitest, Mocked } from 'vitest';
import { ContextProvider } from '../services/contextProvider';
import { EmbeddingDatabaseAdapter } from '../services/embeddingDatabaseAdapter';
import { CopilotModelManager } from '../models/copilotModelManager';
import { TokenManagerService } from '../services/tokenManagerService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { CodeAnalysisService } from '../services/codeAnalysisService';

// Mock VS Code APIs
vi.mock('vscode', async () => ({
    ...await vi.importActual('vscode'),
    workspace: {
        openTextDocument: vi.fn(),
        asRelativePath: vi.fn((uriOrPath: vscode.Uri | string) => {
            let path = '';
            if (typeof uriOrPath === 'string') {
                path = uriOrPath;
            } else {
                path = uriOrPath.fsPath;
            }
            // Corrected path transformation to match test expectations
            return path.replace(/\\/g, '/').replace(/^c:\/mock\/workspace\//i, 'mock/workspace/');
        }),
        fs: {
            readFile: vi.fn(),
            stat: vi.fn(),
        },
        workspaceFolders: [{ uri: { fsPath: 'c:/mock/workspace' } }],
    },
    Uri: {
        file: vi.fn(path => ({ fsPath: path, toString: () => `file://${path}` })),
    },
    Position: vi.fn((line, character) => ({ line, character })),
    Range: vi.fn((start, end) => ({ start, end })),
    CancellationTokenSource: vi.fn(() => ({
        token: { isCancellationRequested: false, onCancellationRequested: vi.fn() },
        cancel: vi.fn(),
        dispose: vi.fn()
    })),
    commands: {
        executeCommand: vi.fn()
    },
    FileType: {
        File: 1,
        Directory: 2,
        SymbolicLink: 64,
        Unknown: 0,
    },
    ExtensionMode: {
        Test: 1,
        Development: 2,
        Production: 3,
    }
}));

// Mock services
vi.mock('../services/embeddingDatabaseAdapter');
vi.mock('../models/copilotModelManager');
vi.mock('../services/tokenManagerService');
vi.mock('../services/workspaceSettingsService');
vi.mock('../services/codeAnalysisService');


describe('ContextProvider', () => {
    let contextProvider: ContextProvider;
    let mockEmbeddingDatabaseAdapter: Mocked<EmbeddingDatabaseAdapter>;
    let mockCopilotModelManager: Mocked<CopilotModelManager>;
    let mockTokenManagerService: Mocked<TokenManagerService>;
    let mockExtensionContext: vscode.ExtensionContext;
    let mockWorkspaceSettingsService: Mocked<WorkspaceSettingsService>;
    let mockCodeAnalysisService: Mocked<CodeAnalysisService>;


    beforeEach(() => {
        mockExtensionContext = {
            extensionPath: '/mock/extension/path',
            subscriptions: [],
            // Add other properties VS Code expects on an ExtensionContext
            workspaceState: { get: vi.fn(), update: vi.fn(), keys: vi.fn() },
            globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(), setKeysForSync: vi.fn() },
            secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() },
            extensionUri: vscode.Uri.file('/mock/extension/path'),
            storageUri: vscode.Uri.file('/mock/storage/path'),
            globalStorageUri: vscode.Uri.file('/mock/globalStorage/path'),
            logUri: vscode.Uri.file('/mock/log/path'),
            extensionMode: vscode.ExtensionMode.Test,
            extension: { id: 'test.extension', extensionPath: '/mock/extension/path', isActive: true, packageJSON: {}, extensionKind: vscode.ExtensionKind.Workspace, exports: {} },
            environmentVariableCollection: { persistent: false, replace: vi.fn(), append: vi.fn(), prepend: vi.fn(), get: vi.fn(), delete: vi.fn(), clear: vi.fn(), [Symbol.iterator]: vi.fn() }
        } as unknown as vscode.ExtensionContext;

        mockEmbeddingDatabaseAdapter = new (EmbeddingDatabaseAdapter as any)(mockExtensionContext) as Mocked<EmbeddingDatabaseAdapter>;
        mockWorkspaceSettingsService = new WorkspaceSettingsService(mockExtensionContext) as Mocked<WorkspaceSettingsService>;
        mockCopilotModelManager = new CopilotModelManager(mockWorkspaceSettingsService) as Mocked<CopilotModelManager>;
        mockTokenManagerService = new TokenManagerService(mockCopilotModelManager) as Mocked<TokenManagerService>;
        mockCodeAnalysisService = new (CodeAnalysisService as any)() as Mocked<CodeAnalysisService>;


        // Setup default mocks for CopilotModelManager and TokenManagerService if needed
        if (mockCopilotModelManager.getCurrentModel) { // Check if method exists before mocking
            vi.mocked(mockCopilotModelManager.getCurrentModel).mockResolvedValue({
                name: 'gpt-4',
                maxInputTokens: 8192,
                family: 'openai'
            } as any);
        }

        if (mockTokenManagerService.calculateTokenAllocation) {
            vi.mocked(mockTokenManagerService.calculateTokenAllocation).mockResolvedValue({
                systemPromptTokens: 10,
                diffTextTokens: 20,
                contextTokens: 100,
                totalAvailableTokens: 8192,
                totalRequiredTokens: 130,
                contextAllocationTokens: 8000,
                fitsWithinLimit: true,
            } as any);
        }
        if (mockTokenManagerService.getSystemPromptForMode) {
            vi.mocked(mockTokenManagerService.getSystemPromptForMode).mockResolvedValue("System prompt");
        }


        // Use the actual createSingleton for ContextProvider
        contextProvider = ContextProvider.createSingleton(
            mockExtensionContext,
            mockEmbeddingDatabaseAdapter,
            mockCopilotModelManager,
            mockCodeAnalysisService
        );

        // Reset vscode mocks
        vi.mocked(vscode.workspace.openTextDocument).mockReset();
        // Ensure asRelativePath is mocked as a function
        if (!vi.isMockFunction(vscode.workspace.asRelativePath)) {
            (vscode.workspace as any).asRelativePath = vi.fn();
        }
        vi.mocked(vscode.workspace.asRelativePath).mockImplementation((uriOrPath: vscode.Uri | string) => {
            let path = '';
            if (typeof uriOrPath === 'string') {
                path = uriOrPath;
            } else {
                path = uriOrPath.fsPath;
            }
            // Corrected path transformation to match test expectations
            return path.replace(/\\/g, '/').replace(/^c:\/mock\/workspace\//i, 'mock/workspace/');
        });

        // Mock console.error to check for error logging
        vitest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        if (ContextProvider.getInstance()) {
            ContextProvider.getInstance().dispose(); // Clean up singleton
        }
        vi.restoreAllMocks();
    });

    describe('getSnippetsForLocations', () => {
        it('should return empty array if no locations provided', async () => {
            const snippets = await contextProvider.getSnippetsForLocations([], 3);
            expect(snippets).toEqual([]);
        });

        it('should retrieve and format snippets for given locations', async () => {
            const locations: vscode.Location[] = [
                {
                    uri: vscode.Uri.file('c:/mock/workspace/file1.ts'),
                    range: new vscode.Range(new vscode.Position(10, 0), new vscode.Position(12, 10)),
                },
            ];
            const mockDocument = {
                uri: vscode.Uri.file('c:/mock/workspace/file1.ts'),
                lineAt: vi.fn(line => ({ text: `Line ${line + 1} content` })),
                lineCount: 20,
                languageId: 'typescript',
                fileName: 'file1.ts'
            };
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            const snippets = await contextProvider.getSnippetsForLocations(locations, 2);

            expect(snippets).toHaveLength(1);
            expect(snippets[0]).toContain('**Context in `mock/workspace/file1.ts:11`:**');
            expect(snippets[0]).toContain('```typescript');
            // Lines 10-12 are target, contextLines = 2 => 8-14 (0-indexed) => 9-15 (1-indexed)
            // Line 9 content (index 8)
            // Line 10 content (index 9)
            // Line 11 content (index 10)
            // Line 12 content (index 11)
            // Line 13 content (index 12)
            // Line 14 content (index 13)
            // Line 15 content (index 14)
            expect(mockDocument.lineAt).toHaveBeenCalledWith(8); // 10 - 2
            expect(mockDocument.lineAt).toHaveBeenCalledWith(14); // 12 + 2
            expect(snippets[0]).toContain('   9: Line 9 content');
            expect(snippets[0]).toContain('  15: Line 15 content');
            expect(snippets[0]).toContain('```');
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(locations[0].uri);
        });

        it('should handle contextLines at the beginning of the file', async () => {
            const locations: vscode.Location[] = [
                {
                    uri: vscode.Uri.file('c:/mock/workspace/file2.ts'),
                    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 5)),
                },
            ];
            const mockDocument = {
                uri: vscode.Uri.file('c:/mock/workspace/file2.ts'),
                lineAt: vi.fn(line => ({ text: `Line ${line + 1}` })),
                lineCount: 5,
                languageId: 'typescript',
                fileName: 'file2.ts'
            };
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            const snippets = await contextProvider.getSnippetsForLocations(locations, 2);

            expect(snippets).toHaveLength(1);
            // Target lines 0-1, contextLines = 2 => 0 - 2 (max 0) to 1 + 2 (max 4) => lines 0-3
            expect(mockDocument.lineAt).toHaveBeenCalledWith(0);
            expect(mockDocument.lineAt).toHaveBeenCalledWith(3); // 1 + 2
            expect(snippets[0]).toContain('   1: Line 1');
            expect(snippets[0]).toContain('   4: Line 4');
        });

        it('should handle contextLines at the end of the file', async () => {
            const locations: vscode.Location[] = [
                {
                    uri: vscode.Uri.file('c:/mock/workspace/file3.ts'),
                    range: new vscode.Range(new vscode.Position(8, 0), new vscode.Position(9, 5)), // Lines 9-10
                },
            ];
            const mockDocument = {
                uri: vscode.Uri.file('c:/mock/workspace/file3.ts'),
                lineAt: vi.fn(line => ({ text: `Line ${line + 1}` })),
                lineCount: 10, // Lines 1-10 (0-9 indexed)
                languageId: 'typescript',
                fileName: 'file3.ts'
            };
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            const snippets = await contextProvider.getSnippetsForLocations(locations, 2);

            expect(snippets).toHaveLength(1);
            // Target lines 8-9, contextLines = 2 => 8 - 2 (line 6) to 9 + 2 (line 11, max 9) => lines 6-9
            expect(mockDocument.lineAt).toHaveBeenCalledWith(6); // 8 - 2
            expect(mockDocument.lineAt).toHaveBeenCalledWith(9); // min(9, 9 + 2)
            expect(snippets[0]).toContain('   7: Line 7');
            expect(snippets[0]).toContain('  10: Line 10');
        });

        it('should use cache for identical locations', async () => {
            const location: vscode.Location = {
                uri: vscode.Uri.file('c:/mock/workspace/file4.ts'),
                range: new vscode.Range(new vscode.Position(5, 0), new vscode.Position(6, 0)),
            };
            const locations = [location, location]; // Same location twice
            const mockDocument = {
                uri: vscode.Uri.file('c:/mock/workspace/file4.ts'),
                lineAt: vi.fn(line => ({ text: `Line ${line + 1}` })),
                lineCount: 10,
                languageId: 'typescript',
                fileName: 'file4.ts'
            };
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            const snippets = await contextProvider.getSnippetsForLocations(locations, 1);

            expect(snippets).toHaveLength(2);
            expect(snippets[0]).toEqual(snippets[1]); // Should be identical due to cache
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1); // Called only once
        });

        it('should handle file reading errors gracefully', async () => {
            const locations: vscode.Location[] = [
                {
                    uri: vscode.Uri.file('c:/mock/workspace/errorfile.ts'),
                    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)),
                },
            ];
            vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(new Error('File read error'));

            const snippets = await contextProvider.getSnippetsForLocations(locations, 2);
            expect(snippets).toEqual([]); // No snippet if error occurs
            expect(console.error).toHaveBeenCalledWith(
                expect.stringContaining('Error reading snippet for c:/mock/workspace/errorfile.ts: {}')
            );
        });

        it('should respect cancellation token during location iteration', async () => {
            const locations: vscode.Location[] = [
                { uri: vscode.Uri.file('c:/mock/workspace/fileA.ts'), range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)) },
                { uri: vscode.Uri.file('c:/mock/workspace/fileB.ts'), range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)) },
            ];
            const mockDocument = {
                uri: vscode.Uri.file('c:/mock/workspace/fileA.ts'),
                lineAt: vi.fn(() => ({ text: 'line content' })),
                lineCount: 1, languageId: 'typescript', fileName: 'fileA.ts'
            };
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            const cancellationTokenSource = new vscode.CancellationTokenSource();
            // Correct way to spy on a getter
            const isCancellationRequestedGetter = vitest.spyOn(cancellationTokenSource.token, 'isCancellationRequested', 'get');
            // Location 1 (fileA) - process fully
            isCancellationRequestedGetter.mockReturnValueOnce(false); // Call 1: Outer loop check for fileA
            isCancellationRequestedGetter.mockReturnValueOnce(false); // Call 2: Inner loop line reading check for fileA (1 line in snippet)
            isCancellationRequestedGetter.mockReturnValueOnce(false); // Call 3: Post-inner loop check B for fileA

            // Location 2 (fileB) - cancel at outer loop check
            isCancellationRequestedGetter.mockReturnValueOnce(true);  // Call 4: Outer loop check for fileB


            const snippets = await contextProvider.getSnippetsForLocations(locations, 1, cancellationTokenSource.token);
            expect(snippets).toHaveLength(1); // Only first snippet processed
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1);
        });

        it('should respect cancellation token during line reading', async () => {
            const locations: vscode.Location[] = [
                { uri: vscode.Uri.file('c:/mock/workspace/fileC.ts'), range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(2, 0)) }, // 3 lines target
            ];
            const mockDocument = {
                uri: vscode.Uri.file('c:/mock/workspace/fileC.ts'),
                lineAt: vi.fn(() => ({ text: 'line content' })),
                lineCount: 5, languageId: 'typescript', fileName: 'fileC.ts'
            };
            vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(mockDocument as any);

            const cancellationTokenSource = new vscode.CancellationTokenSource();

            // Simulate cancellation after the first line is read
            let callCount = 0;
            const isCancellationRequestedGetter = vitest.spyOn(cancellationTokenSource.token, 'isCancellationRequested', 'get');
            isCancellationRequestedGetter.mockImplementation(() => {
                callCount++;
                // Allow first location loop, first line read, then cancel
                return callCount > 2;
            });

            const snippets = await contextProvider.getSnippetsForLocations(locations, 0, cancellationTokenSource.token); // contextLines = 0
            expect(snippets).toHaveLength(0); // Snippet not added if cancelled during line reading
            expect(mockDocument.lineAt).toHaveBeenCalledTimes(1); // Only first line read
        });
    });
});

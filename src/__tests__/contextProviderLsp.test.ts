import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ContextProvider } from '../services/contextProvider';
import { EmbeddingDatabaseAdapter } from '../services/embeddingDatabaseAdapter';
import { CopilotModelManager } from '../models/copilotModelManager';
import { TreeStructureAnalyzerResource } from '../services/treeStructureAnalyzer';

// Mock VS Code APIs
vi.mock('vscode', async () => {
    const commands = {
        executeCommand: vi.fn(),
    };
    const workspace = {
        workspaceFolders: [{ uri: { fsPath: 'd:\\dev\\copilot-review' } }],
        fs: {
            stat: vi.fn(),
            readFile: vi.fn(),
        },
        openTextDocument: vi.fn(uriOrPath => Promise.resolve({ uri: vscode.Uri.file(uriOrPath) })), // Mock openTextDocument
    };
    const Uri = {
        file: (path: string) => ({
            fsPath: path,
            path: path,
            scheme: 'file',
            authority: '',
            fragment: '',
            query: '',
            // Add other necessary Uri properties/methods if needed
            with: vi.fn(),
            toString: vi.fn(() => `file://${path}`),
        }),
    };
    const Position = vi.fn((line, character) => ({ line, character }));
    const Range = vi.fn((start, end) => ({ start, end }));
    const Location = vi.fn((uri, rangeOrPosition) => ({ uri, range: rangeOrPosition }));
    const FileType = {
        File: 1,
        Directory: 2,
        SymbolicLink: 64,
        Unknown: 0,
    };
    const actualVscode = await vi.importActual<typeof vscode>('vscode');
    return {
        ...actualVscode,
        commands,
        workspace,
        Uri,
        Position,
        Range,
        Location,
        FileType,
        // Mock other VS Code components if needed
    };
});

// Mock other dependencies
vi.mock('../services/embeddingDatabaseAdapter');
vi.mock('../models/copilotModelManager');
vi.mock('../services/tokenManagerService');
vi.mock('../services/treeStructureAnalyzer', () => {
    const mockAnalyzerInstance = {
        getFileLanguage: vi.fn().mockReturnValue({ language: 'typescript', variant: undefined }),
        findSymbolsInRanges: vi.fn().mockResolvedValue([]), // Used by extractMeaningfulChunksAndSymbols
        findFunctions: vi.fn().mockResolvedValue([]),       // Used by extractMeaningfulChunksAndSymbols
        findClasses: vi.fn().mockResolvedValue([]),         // Used by extractMeaningfulChunksAndSymbols
        dispose: vi.fn(),
    };
    return {
        TreeStructureAnalyzerResource: {
            create: vi.fn().mockResolvedValue({
                instance: mockAnalyzerInstance,
                dispose: vi.fn(),
            }),
        },
        // SymbolInfo: vi.fn(), // If it were a class
    };
});

describe('ContextProvider LSP Methods', () => {
    let contextProvider: ContextProvider;
    let mockContext: vscode.ExtensionContext;
    let mockEmbeddingDbAdapter: EmbeddingDatabaseAdapter;
    let mockModelManager: CopilotModelManager;

    beforeEach(() => {
        // Reset mocks before each test
        vi.clearAllMocks();

        mockContext = { subscriptions: [] } as any; // Mock ExtensionContext

        // Mock the getInstance methods for singletons
        mockEmbeddingDbAdapter = {
            findRelevantCodeContextForChunks: vi.fn().mockResolvedValue([]),
            // Add other methods used by ContextProvider if necessary
        } as unknown as jest.Mocked<EmbeddingDatabaseAdapter>;
        vi.spyOn(EmbeddingDatabaseAdapter, 'getInstance').mockReturnValue(mockEmbeddingDbAdapter);

        // Assume CopilotModelManager is instantiated directly or mock its methods if needed
        mockModelManager = {
            getCurrentModel: vi.fn().mockResolvedValue({ maxInputTokens: 8000, family: 'unknown', name: 'mock-model' }),
            // Add other methods used by ContextProvider/TokenManagerService if necessary
        } as unknown as jest.Mocked<CopilotModelManager>;
        // If CopilotModelManager *is* a singleton with getInstance, uncomment the next line
        // vi.spyOn(CopilotModelManager, 'getInstance').mockReturnValue(mockModelManager);

        // Create the ContextProvider instance using the mocked dependencies
        // We need to bypass the private constructor check for testing the singleton creation
        // One way is to mock the constructor or use 'as any' carefully
        // Or, rely on createSingleton which should use the mocked getInstance
        contextProvider = ContextProvider.createSingleton(mockContext, mockEmbeddingDbAdapter, mockModelManager);

        // Mock executeCommand responses
        vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, ...args) => {
            const uri = args[0] as vscode.Uri;
            const position = args[1] as vscode.Position;
            let token: vscode.CancellationToken | undefined;

            // Extract token based on command
            if (command === 'vscode.executeDefinitionProvider') {
                token = args[3] as vscode.CancellationToken;
            } else if (command === 'vscode.executeReferenceProvider') {
                token = args[4] as vscode.CancellationToken;
            }

            // Simulate cancellation check
            if (token?.isCancellationRequested) {
                console.log(`Mock executeCommand cancelled for ${command}`);
                // Simulate cancellation by returning undefined or throwing, depending on typical API behavior.
                // Returning undefined aligns with the post-call check in the tested methods.
                return undefined;
            }

            // Original mock logic if not cancelled
            if (command === 'vscode.executeDefinitionProvider') {
                if (uri.fsPath === 'd:\\dev\\copilot-review\\src\\test.ts' && position.line === 5) {
                    return [new vscode.Location(vscode.Uri.file('d:\\dev\\copilot-review\\src\\definition.ts'), new vscode.Position(10, 4))];
                }
                return []; // Default: Not found
            }
            if (command === 'vscode.executeReferenceProvider') {
                if (uri.fsPath === 'd:\\dev\\copilot-review\\src\\test.ts' && position.line === 5) {
                    return [
                        new vscode.Location(vscode.Uri.file('d:\\dev\\copilot-review\\src\\ref1.ts'), new vscode.Position(20, 8)),
                        new vscode.Location(vscode.Uri.file('d:\\dev\\copilot-review\\src\\ref2.ts'), new vscode.Position(30, 12)),
                    ];
                }
                return []; // Default: Not found
            }
            return undefined;
        });
    });

    afterEach(() => {
        contextProvider.dispose(); // Clean up singleton instance
    });

    describe('findSymbolDefinition', () => {
        it('should return definition location when found', async () => {
            const filePath = 'd:\\dev\\copilot-review\\src\\test.ts';
            const position = new vscode.Position(5, 10);
            const expectedUri = vscode.Uri.file('d:\\dev\\copilot-review\\src\\definition.ts');
            const expectedPosition = new vscode.Position(10, 4);

            const locations = await contextProvider.findSymbolDefinition(filePath, position);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeDefinitionProvider',
                expect.objectContaining({ fsPath: filePath }),
                position,
                expect.anything() // CancellationToken
            );
            expect(locations).toBeDefined();
            expect(locations).toHaveLength(1);
            expect(locations![0].uri.fsPath).toBe(expectedUri.fsPath);
            expect(locations![0].range).toEqual(expectedPosition); // executeDefinitionProvider returns Location with Position or Range
        });

        it('should return undefined when no definition is found', async () => {
            const filePath = 'd:\\dev\\copilot-review\\src\\other.ts';
            const position = new vscode.Position(1, 1);

            const locations = await contextProvider.findSymbolDefinition(filePath, position);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeDefinitionProvider',
                expect.objectContaining({ fsPath: filePath }),
                position,
                expect.anything() // CancellationToken
            );
            expect(locations).toBeUndefined();
        });

        it('should return undefined on LSP error', async () => {
            vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('LSP Error'));
            const filePath = 'd:\\dev\\copilot-review\\src\\test.ts';
            const position = new vscode.Position(5, 10);

            const locations = await contextProvider.findSymbolDefinition(filePath, position);

            expect(locations).toBeUndefined();
        });

        it('should respect cancellation token', async () => {
            const filePath = 'd:\\dev\\copilot-review\\src\\test.ts';
            const position = new vscode.Position(5, 10);
            const cts = new vscode.CancellationTokenSource();
            cts.cancel(); // Cancel immediately

            const locations = await contextProvider.findSymbolDefinition(filePath, position, cts.token);

            // Check if the command was still called (it might be, depending on timing)
            // but the result should be undefined due to the cancellation check
            expect(locations).toBeUndefined();
        });
    });

    describe('findSymbolReferences', () => {
        it('should return reference locations when found', async () => {
            const filePath = 'd:\\dev\\copilot-review\\src\\test.ts';
            const position = new vscode.Position(5, 10);
            const expectedUri1 = vscode.Uri.file('d:\\dev\\copilot-review\\src\\ref1.ts');
            const expectedPosition1 = new vscode.Position(20, 8);
            const expectedUri2 = vscode.Uri.file('d:\\dev\\copilot-review\\src\\ref2.ts');
            const expectedPosition2 = new vscode.Position(30, 12);

            const locations = await contextProvider.findSymbolReferences(filePath, position, false);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeReferenceProvider',
                expect.objectContaining({ fsPath: filePath }),
                position,
                { includeDeclaration: false },
                expect.anything() // CancellationToken
            );
            expect(locations).toBeDefined();
            expect(locations).toHaveLength(2);
            expect(locations![0].uri.fsPath).toBe(expectedUri1.fsPath);
            expect(locations![0].range).toEqual(expectedPosition1);
            expect(locations![1].uri.fsPath).toBe(expectedUri2.fsPath);
            expect(locations![1].range).toEqual(expectedPosition2);
        });

        it('should return undefined when no references are found', async () => {
            const filePath = 'd:\\dev\\copilot-review\\src\\other.ts';
            const position = new vscode.Position(1, 1);

            const locations = await contextProvider.findSymbolReferences(filePath, position);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeReferenceProvider',
                expect.objectContaining({ fsPath: filePath }),
                position,
                { includeDeclaration: false },
                expect.anything() // CancellationToken
            );
            expect(locations).toBeUndefined();
        });

        it('should pass includeDeclaration context correctly', async () => {
            const filePath = 'd:\\dev\\copilot-review\\src\\test.ts';
            const position = new vscode.Position(5, 10);

            await contextProvider.findSymbolReferences(filePath, position, true); // includeDeclaration = true

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'vscode.executeReferenceProvider',
                expect.objectContaining({ fsPath: filePath }),
                position,
                { includeDeclaration: true }, // Verify context
                expect.anything() // CancellationToken
            );
        });

        it('should return undefined on LSP error', async () => {
            vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('LSP Error'));
            const filePath = 'd:\\dev\\copilot-review\\src\\test.ts';
            const position = new vscode.Position(5, 10);

            const locations = await contextProvider.findSymbolReferences(filePath, position);

            expect(locations).toBeUndefined();
        });

        it('should respect cancellation token', async () => {
            const filePath = 'd:\\dev\\copilot-review\\src\\test.ts';
            const position = new vscode.Position(5, 10);
            const cts = new vscode.CancellationTokenSource();
            cts.cancel(); // Cancel immediately

            const locations = await contextProvider.findSymbolReferences(filePath, position, false, cts.token);

            expect(locations).toBeUndefined();
        });
    });
});

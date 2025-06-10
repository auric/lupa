import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingService, type IndexingServiceOptions } from '../services/indexingService';
import type { FileToProcess, ProcessingResult, EmbeddingGenerationOutput } from '../types/indexingTypes';
import { StatusBarService, StatusBarState, StatusBarMessageType } from '../services/statusBarService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

// Use vi.hoisted for variables that need to be accessed in mocks
const mocks = vi.hoisted(() => {
    const mockStatusBarItem = {
        text: '',
        tooltip: '',
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn()
    };

    const mockStatusBarInstance = {
        statusBarItem: mockStatusBarItem,
        setState: vi.fn(),
        showTemporaryMessage: vi.fn(),
        clearTemporaryMessage: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn()
    };

    const mockWorkspaceSettingsInstance = {
        getSelectedEmbeddingModel: vi.fn().mockReturnValue(undefined),
        setSelectedEmbeddingModel: vi.fn(),
        updateLastIndexingTimestamp: vi.fn(),
        getSetting: vi.fn(),
        setSetting: vi.fn(),
        clearWorkspaceSettings: vi.fn(),
        resetAllSettings: vi.fn(),
        dispose: vi.fn()
    };

    // Piscina mocks are removed as IndexingService no longer uses it directly,
    // and EmbeddingGenerationService (which uses Piscina) will be mocked.

    // Mocks for EmbeddingGenerationService
    const mockGenerateEmbeddingsForChunks = vi.fn();
    const mockInitializeEmbeddingGeneration = vi.fn().mockResolvedValue(undefined);
    const mockDisposeEmbeddingGeneration = vi.fn().mockResolvedValue(undefined);
    const MockEmbeddingGenerationService = vi.fn().mockImplementation(() => ({
        initialize: mockInitializeEmbeddingGeneration,
        generateEmbeddingsForChunks: mockGenerateEmbeddingsForChunks,
        dispose: mockDisposeEmbeddingGeneration,
    }));

    return {
        mockStatusBarItem,
        mockStatusBarInstance,
        mockWorkspaceSettingsInstance,
        mockGenerateEmbeddingsForChunks,
        mockInitializeEmbeddingGeneration,
        mockDisposeEmbeddingGeneration,
        MockEmbeddingGenerationService
    };
});

// Mock EmbeddingGenerationService
vi.mock('../services/embeddingGenerationService', () => ({
    EmbeddingGenerationService: mocks.MockEmbeddingGenerationService,
}));

// Mock the StatusBarService module
vi.mock('../services/statusBarService', () => {
    return {
        StatusBarService: {
            getInstance: vi.fn(() => mocks.mockStatusBarInstance),
            reset: vi.fn(),
            MAIN_STATUS_BAR_ID: 'prAnalyzer.main'
        },
        StatusBarMessageType: {
            Info: 'info',
            Warning: 'warning',
            Error: 'error',
            Working: 'working'
        },
        StatusBarState: {
            Ready: 'ready',
            Indexing: 'indexing',
            Analyzing: 'analyzing',
            Error: 'error',
            Inactive: 'inactive'
        }
    };
});

// Mock WorkspaceSettingsService
vi.mock('../services/workspaceSettingsService', () => {
    return {
        WorkspaceSettingsService: vi.fn().mockImplementation(() => mocks.mockWorkspaceSettingsInstance)
    };
});

// Mock vscode module
vi.mock('vscode', () => ({
    Uri: {
        // Retain fsPath for compatibility if other parts of the codebase expect it (e.g. real CodeChunkingService)
        file: vi.fn((path: string) => ({ path: path, fsPath: path, scheme: 'file' }))
    },
    CancellationTokenSource: vi.fn().mockImplementation(() => ({
        token: {
            onCancellationRequested: vi.fn(),
            isCancellationRequested: false
        },
        cancel: vi.fn()
    }))
}));

// Mock fs exists check for worker script path
vi.mock('fs', () => {
    return {
        ...vi.importActual('fs'),
        existsSync: vi.fn().mockReturnValue(true)
    };
});

// Mock os module
vi.mock('os', () => {
    const actual = vi.importActual('os');
    return {
        ...actual,
        cpus: vi.fn(() => {
            return [
                { model: 'Test CPU', speed: 2400 },
                { model: 'Test CPU', speed: 2400 },
                { model: 'Test CPU', speed: 2400 },
                { model: 'Test CPU', speed: 2400 }
            ];
        }),
        totalmem: vi.fn().mockImplementation(() => 16 * 1024 * 1024 * 1024),
        freemem: vi.fn().mockImplementation(() => 8 * 1024 * 1024 * 1024),
        availableParallelism: vi.fn().mockReturnValue(4)
    };
});

// REMOVE Piscina mock: IndexingService no longer uses Piscina directly.
// EmbeddingGenerationService (which uses Piscina) is mocked.
// vi.mock('piscina', () => {
// return {
// default: mocks.mockPiscinaConstructor
// };
// });

describe('IndexingService', () => {
    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let statusBarServiceInstance: any;
    let extensionPath: string;
    let workspaceSettingsService: WorkspaceSettingsService;
    let defaultIndexingOptions: IndexingServiceOptions;

    beforeEach(async () => { // Make beforeEach async
        // Reset all mocks
        vi.clearAllMocks();

        // Ensure CancellationTokenSource is re-mocked for fresh state
        vi.mocked(vscode.CancellationTokenSource).mockImplementation(() => {
            const listeners: Array<(e: any) => any> = [];
            let isCancelled = false;

            const token: vscode.CancellationToken = {
                get isCancellationRequested() { return isCancelled; },
                onCancellationRequested: vi.fn((listener: (e: any) => any) => {
                    listeners.push(listener);
                    return {
                        dispose: vi.fn(() => {
                            const index = listeners.indexOf(listener);
                            if (index !== -1) {
                                listeners.splice(index, 1);
                            }
                        })
                    };
                })
            };

            return {
                token: token,
                cancel: vi.fn(() => {
                    isCancelled = true;
                    // Create a copy of listeners array before iteration
                    [...listeners].forEach(listener => listener(undefined)); // Pass undefined or a specific event if needed
                }),
                dispose: vi.fn()
            } as unknown as vscode.CancellationTokenSource;
        });

        // Redefine mock behaviors for services used by IndexingService or its real children
        mocks.mockWorkspaceSettingsInstance.getSelectedEmbeddingModel.mockReturnValue(undefined);
        mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp.mockImplementation(() => { });

        // Reset EmbeddingGenerationService mocks
        mocks.MockEmbeddingGenerationService.mockImplementation(() => ({
            initialize: mocks.mockInitializeEmbeddingGeneration.mockResolvedValue(undefined),
            generateEmbeddingsForChunks: mocks.mockGenerateEmbeddingsForChunks,
            dispose: mocks.mockDisposeEmbeddingGeneration.mockResolvedValue(undefined),
        }));

        StatusBarService.reset(); // Ensure StatusBarService is reset
        statusBarServiceInstance = StatusBarService.getInstance();

        extensionPath = path.resolve(__dirname, '..', '..');

        context = {
            globalStorageUri: vscode.Uri.file(path.join(extensionPath, 'tmp', 'global')),
            storageUri: vscode.Uri.file(path.join(extensionPath, 'tmp', 'workspace')),
            extensionPath: extensionPath,
            workspaceState: {
                update: vi.fn(),
                get: vi.fn()
            },
            subscriptions: [],
            asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath)
        } as unknown as vscode.ExtensionContext;

        // workspaceSettingsService is already mocked globally, so we can use the mock directly
        // or instantiate if needed, but here we'll use the global mock instance.
        workspaceSettingsService = mocks.mockWorkspaceSettingsInstance as unknown as WorkspaceSettingsService;

        defaultIndexingOptions = {
            modelBasePath: path.join(extensionPath, 'models'), // For EGS (mocked)
            modelName: 'Xenova/all-MiniLM-L6-v2', // For CCS (real) & EGS (mocked)
            contextLength: 256, // For CCS (real)
            extensionPath, // For CCS (real) & EGS (mocked)
            embeddingOptions: {
                pooling: 'mean',
                normalize: true
            },
            maxConcurrentEmbeddingTasks: 2, // For EGS (mocked)
        };

        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            defaultIndexingOptions
        );
        // Initialize the service, which will initialize real CodeChunkingService and mocked EmbeddingGenerationService
        await indexingService.initialize();
    });

    afterEach(async () => {
        if (indexingService) {
            await indexingService.dispose();
        }
    });

    // This test needs to be adapted as IndexingService no longer directly initializes a Piscina pool.
    // It initializes CodeChunkingService (real) and EmbeddingGenerationService (mocked).
    it('should initialize its dependent services (real CodeChunkingService and mocked EmbeddingGenerationService)', () => {
        // Check that EmbeddingGenerationService's initialize (mocked) was called by IndexingService.initialize()
        expect(mocks.mockInitializeEmbeddingGeneration).toHaveBeenCalledTimes(1);

        // CodeChunkingService is real. Its initialize method should have been called.
        // We can't easily check a call on a real method without making CodeChunkingService itself a spy
        // or checking a side effect of its initialization.
        // For now, successful operation in other tests will imply its initialization worked.
        // The constructor of IndexingService creates CodeChunkingService.
        // IndexingService.initialize calls codeChunkingService.initialize().
        // We expect no errors from this process.
    });

    // This test needs to be adapted.
    // "Piscina" is an internal detail of the old IndexingService or the (now mocked) EmbeddingGenerationService.
    // We test that IndexingService uses CodeChunkingService (real) and EmbeddingGenerationService (mocked).
    it('should process files using real CodeChunkingService and mocked EmbeddingGenerationService', async () => {
        // File data for CodeChunkingService (real)
        const file1: FileToProcess = { id: 'file1', path: 'testFile.js', content: 'console.log("hello");' };
        const file2: FileToProcess = { id: 'file2', path: 'anotherTest.ts', content: 'let greeting: string = "world";' };
        const filesToProcess: FileToProcess[] = [file1, file2];

        // Mocked output from EmbeddingGenerationService.generateEmbeddingsForChunks
        const mockEmbeddingOutput1: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'file1', filePath: file1.path, chunkIndexInFile: 0, text: 'console.log("hello");', offsetInFile: 0 },
            embedding: new Float32Array([0.1, 0.2, 0.3]),
        }];
        const mockEmbeddingOutput2: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'file2', filePath: file2.path, chunkIndexInFile: 0, text: 'let greeting: string = "world";', offsetInFile: 0 },
            embedding: new Float32Array([0.4, 0.5, 0.6]),
        }];

        mocks.mockGenerateEmbeddingsForChunks
            .mockResolvedValueOnce(mockEmbeddingOutput1) // For file1's chunks
            .mockResolvedValueOnce(mockEmbeddingOutput2); // For file2's chunks

        // Process files
        const results = await indexingService.processFiles(filesToProcess);

        // Verify results
        expect(results.size).toBe(2);
        const resultFile1 = results.get('file1');
        const resultFile2 = results.get('file2');

        expect(resultFile1).toBeDefined();
        expect(resultFile1?.success).toBe(true);
        expect(resultFile1?.embeddings[0]).toEqual(new Float32Array([0.1, 0.2, 0.3]));

        expect(resultFile2).toBeDefined();
        expect(resultFile2?.success).toBe(true);
        expect(resultFile2?.embeddings[0]).toEqual(new Float32Array([0.4, 0.5, 0.6]));

        // Verify EmbeddingGenerationService was called correctly
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledTimes(2);
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenNthCalledWith(
            1,
            expect.arrayContaining([
                expect.objectContaining({ fileId: 'file1', filePath: file1.path, text: expect.any(String) })
            ]),
            expect.any(AbortSignal)
        );
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenNthCalledWith(
            2,
            expect.arrayContaining([
                expect.objectContaining({ fileId: 'file2', filePath: file2.path, text: expect.any(String) })
            ]),
            expect.any(AbortSignal)
        );

        // Verify updateLastIndexingTimestamp was called
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should handle empty file list', async () => {
        const results = await indexingService.processFiles([]);
        expect(results.size).toBe(0);
        expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();
    });

    it('should handle EmbeddingGenerationService errors', async () => {
        const fileWithError: FileToProcess = { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' };
        const mockEmbeddingErrorOutput: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'file1', filePath: fileWithError.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 },
            embedding: null,
            error: 'Embedding generation failed for this chunk'
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValueOnce(mockEmbeddingErrorOutput);

        const results = await indexingService.processFiles([fileWithError]);

        expect(results.size).toBe(1);
        const resultFile1 = results.get('file1');
        expect(resultFile1).toBeDefined();
        expect(resultFile1?.success).toBe(false);
        expect(resultFile1?.error).toContain('Embedding generation failed for this chunk');
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledTimes(1);
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).not.toHaveBeenCalled();
    });

    it('should use StatusBarService for status updates', async () => {
        const fileForStatus: FileToProcess = { id: 'test', path: '/test.js', content: 'test content' };
        const mockEmbeddingOutputStatus: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'test', filePath: fileForStatus.path, chunkIndexInFile: 0, text: 'test content', offsetInFile: 0 },
            embedding: new Float32Array([0.1, 0.2]),
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValue(mockEmbeddingOutputStatus);

        const setStateSpy = vi.spyOn(statusBarServiceInstance, 'setState');
        const showTemporaryMessageSpy = vi.spyOn(statusBarServiceInstance, 'showTemporaryMessage');

        await indexingService.processFiles([fileForStatus]);

        expect(showTemporaryMessageSpy).toHaveBeenCalledWith(
            expect.stringContaining('Preparing files 1/1'),
            expect.any(Number),
            StatusBarMessageType.Working
        );
        expect(showTemporaryMessageSpy).toHaveBeenCalledWith(
            expect.stringContaining('Embeddings 1/1 files'),
            expect.any(Number),
            StatusBarMessageType.Working
        );
        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Ready, 'Indexing complete');
    });

    it('should update workspace settings after successful processing', async () => {
        const fileForSettingUpdate: FileToProcess = { id: 'test', path: '/test.js', content: 'test content' };
        const mockEmbeddingOutputSettings: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'test', filePath: fileForSettingUpdate.path, chunkIndexInFile: 0, text: 'test content', offsetInFile: 0 },
            embedding: new Float32Array([0.1, 0.2]),
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValue(mockEmbeddingOutputSettings);

        await indexingService.processFiles([fileForSettingUpdate]);

        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should handle cancellation correctly', async () => {
        const fileToCancel: FileToProcess = { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' };
        mocks.mockGenerateEmbeddingsForChunks.mockImplementation(async (_chunks, signal) => {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    return reject(new Error('Operation aborted by signal in EGS mock'));
                }
                signal?.onCancellationRequested(() => reject(new Error('Operation aborted by signal in EGS mock')));
                setTimeout(() => resolve([{
                    originalChunkInfo: { fileId: 'file1', filePath: fileToCancel.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 },
                    embedding: new Float32Array([0.1])
                }]), 200);
            });
        });

        const tokenSource = new vscode.CancellationTokenSource();
        const processPromise = indexingService.processFiles([fileToCancel], tokenSource.token);

        tokenSource.cancel();

        const result = await processPromise;
        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(1);
        const resultFile1 = result.get('file1');
        expect(resultFile1).toBeDefined();
        expect(resultFile1?.success).toBe(false);
        expect(resultFile1?.error).toMatch(/Operation cancelled|Operation aborted/i);

        if (mocks.mockGenerateEmbeddingsForChunks.mock.calls.length > 0) {
            const signalArg = mocks.mockGenerateEmbeddingsForChunks.mock.calls[0][1] as AbortSignal;
            expect(signalArg.aborted).toBe(true);
        }
    });

    it('should call dispose on its services during disposal', async () => {
        const codeChunkingServiceInstance = (indexingService as any).codeChunkingService;
        const disposeChunkerSpy = vi.spyOn(codeChunkingServiceInstance, 'dispose');

        await indexingService.dispose();

        expect(mocks.mockDisposeEmbeddingGeneration).toHaveBeenCalledTimes(1);
        expect(disposeChunkerSpy).toHaveBeenCalledTimes(1);
    });

    it('should support progress reporting', async () => {
        const fileProgress1: FileToProcess = { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' };
        const fileProgress2: FileToProcess = { id: 'f2', path: '/path/to/f2.js', content: 'const y = 2;' };
        const filesForProgress: FileToProcess[] = [fileProgress1, fileProgress2];

        const mockEmbeddingOutputP1: EmbeddingGenerationOutput[] = [{ originalChunkInfo: { fileId: 'f1', filePath: fileProgress1.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 }, embedding: new Float32Array([0.1]) }];
        const mockEmbeddingOutputP2: EmbeddingGenerationOutput[] = [{ originalChunkInfo: { fileId: 'f2', filePath: fileProgress2.path, chunkIndexInFile: 0, text: 'const y = 2;', offsetInFile: 0 }, embedding: new Float32Array([0.2]) }];

        mocks.mockGenerateEmbeddingsForChunks
            .mockResolvedValueOnce(mockEmbeddingOutputP1)
            .mockResolvedValueOnce(mockEmbeddingOutputP2);

        const progressCallback = vi.fn();
        await indexingService.processFiles(filesForProgress, undefined, progressCallback);

        // Verify progress for chunking phase
        expect(progressCallback).toHaveBeenCalledWith(1, 2, 'chunking', 1, 2);
        expect(progressCallback).toHaveBeenCalledWith(2, 2, 'chunking', 2, 2);

        // Verify progress for embedding phase
        // After file1 embeddings (assuming 1 chunk for file1)
        const progressArgsEmbeddingFile1 = progressCallback.mock.calls.find(call => call[2] === 'embedding' && call[4] === 2 && call[3] === 1); // filesEmbeddingsCompletedCount === 1
        expect(progressArgsEmbeddingFile1).toEqual([
            1, // embeddingsProcessedCount for file1
            expect.any(Number), // totalChunksGeneratedCount (will be at least 1, likely 2 if both chunked)
            'embedding',
            1, // filesEmbeddingsCompletedCount
            2  // pendingFileEmbeddings.length (total files that went to embedding)
        ]);
        // After file2 embeddings (assuming 1 chunk for file2, total 2 chunks)
        const progressArgsEmbeddingFile2 = progressCallback.mock.calls.find(call => call[2] === 'embedding' && call[4] === 2 && call[3] === 2); // filesEmbeddingsCompletedCount === 2
        expect(progressArgsEmbeddingFile2).toEqual([
            2, // embeddingsProcessedCount for file1 + file2
            expect.any(Number), // totalChunksGeneratedCount (will be 2)
            'embedding',
            2, // filesEmbeddingsCompletedCount
            2  // pendingFileEmbeddings.length
        ]);
    });

    it('should support batch completion callback', async () => {
        const fileForBatch: FileToProcess = { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' };
        const mockEmbeddingOutputBatch: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'f1', filePath: fileForBatch.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 },
            embedding: new Float32Array([0.1])
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValue(mockEmbeddingOutputBatch);

        const batchCompletedCallback = vi.fn().mockResolvedValue(undefined);
        await indexingService.processFiles([fileForBatch], undefined, undefined, batchCompletedCallback);

        expect(batchCompletedCallback).toHaveBeenCalledWith(
            expect.any(Map)
        );
        const resultsMap = batchCompletedCallback.mock.calls[0][0] as Map<string, ProcessingResult>;
        expect(resultsMap.get('f1')?.success).toBe(true);
    });
});

describe('IndexingService Configuration', () => {
    let context: vscode.ExtensionContext;
    let workspaceSettingsService: WorkspaceSettingsService;
    let extensionPath: string;

    beforeEach(() => {
        vi.clearAllMocks();
        StatusBarService.reset();

        extensionPath = path.resolve(__dirname, '..', '..');

        context = {
            globalStorageUri: vscode.Uri.file(path.join(extensionPath, 'tmp', 'global')),
            storageUri: vscode.Uri.file(path.join(extensionPath, 'tmp', 'workspace')),
            extensionPath: extensionPath,
            workspaceState: {
                update: vi.fn(),
                get: vi.fn()
            },
            subscriptions: [],
            asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath)
        } as unknown as vscode.ExtensionContext;

        workspaceSettingsService = mocks.mockWorkspaceSettingsInstance as unknown as WorkspaceSettingsService;
    });

    it('should throw error when model name is not provided', () => {
        expect(() => {
            new IndexingService(
                context,
                workspaceSettingsService,
                // @ts-ignore - force invalid input for testing
                { modelName: '' }
            );
        }).toThrow('Model name must be provided');
    });

    it('should throw error when context length is not provided', () => {
        expect(() => {
            new IndexingService(
                context,
                workspaceSettingsService,
                {
                    modelBasePath: '/test',
                    modelName: 'test-model',
                    // @ts-ignore - force invalid input for testing
                    contextLength: undefined
                }
            );
        }).toThrow('Context length must be provided');
    });
});

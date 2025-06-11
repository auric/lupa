import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingService, type IndexingServiceOptions } from '../services/indexingService';
import type { FileToProcess, ProcessingResult, EmbeddingGenerationOutput, YieldedProcessingOutput } from '../types/indexingTypes';
import { StatusBarService, StatusBarState, StatusBarMessageType } from '../services/statusBarService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import type { DetailedChunkingResult, EmbeddingOptions } from '../types/embeddingTypes';

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
        getCurrentState: vi.fn(() => StatusBarState.Ready),
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

    // Mocks for EmbeddingGenerationService
    const mockGenerateEmbeddingsForChunks = vi.fn();
    const mockInitializeEmbeddingGeneration = vi.fn().mockResolvedValue(undefined);
    const mockDisposeEmbeddingGeneration = vi.fn().mockResolvedValue(undefined);
    const MockEmbeddingGenerationService = vi.fn().mockImplementation(() => ({
        initialize: mockInitializeEmbeddingGeneration,
        generateEmbeddingsForChunks: mockGenerateEmbeddingsForChunks,
        dispose: mockDisposeEmbeddingGeneration,
    }));

    // Mocks for CodeChunkingService
    const mockChunkFile = vi.fn();
    const mockInitializeCodeChunking = vi.fn().mockResolvedValue(undefined);
    const mockDisposeCodeChunking = vi.fn().mockResolvedValue(undefined);
    const MockCodeChunkingService = vi.fn().mockImplementation(() => ({
        initialize: mockInitializeCodeChunking,
        chunkFile: mockChunkFile,
        dispose: mockDisposeCodeChunking,
    }));

    return {
        mockStatusBarItem,
        mockStatusBarInstance,
        mockWorkspaceSettingsInstance,
        mockGenerateEmbeddingsForChunks,
        mockInitializeEmbeddingGeneration,
        mockDisposeEmbeddingGeneration,
        MockEmbeddingGenerationService,
        mockChunkFile,
        mockInitializeCodeChunking,
        mockDisposeCodeChunking,
        MockCodeChunkingService
    };
});

// Mock EmbeddingGenerationService
vi.mock('../services/embeddingGenerationService', () => ({
    EmbeddingGenerationService: mocks.MockEmbeddingGenerationService,
}));

// Mock CodeChunkingService
vi.mock('../services/codeChunkingService', () => ({
    CodeChunkingService: mocks.MockCodeChunkingService,
}));

// Mock the StatusBarService module
vi.mock('../services/statusBarService', () => {
    return {
        StatusBarService: {
            getInstance: vi.fn(() => mocks.mockStatusBarInstance),
            reset: vi.fn(),
            getCurrentState: vi.fn(() => StatusBarState.Ready),
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

    // Helper function to collect all yielded values and the final return value from the generator
    async function collectAndReturn<T, TReturn>(
        generator: AsyncGenerator<T, TReturn, undefined>
    ): Promise<{ yielded: T[], returned: TReturn }> {
        const yielded: T[] = [];
        let result = await generator.next();
        while (!result.done) {
            yielded.push(result.value);
            result = await generator.next();
        }
        return { yielded, returned: result.value };
    }


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

        // Redefine mock behaviors for services used by IndexingService
        mocks.mockWorkspaceSettingsInstance.getSelectedEmbeddingModel.mockReturnValue(undefined);
        mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp.mockImplementation(() => { });

        // Reset EmbeddingGenerationService mocks
        mocks.MockEmbeddingGenerationService.mockImplementation(() => ({
            initialize: mocks.mockInitializeEmbeddingGeneration.mockResolvedValue(undefined),
            generateEmbeddingsForChunks: mocks.mockGenerateEmbeddingsForChunks,
            dispose: mocks.mockDisposeEmbeddingGeneration.mockResolvedValue(undefined),
        }));

        // Reset CodeChunkingService mocks
        mocks.MockCodeChunkingService.mockImplementation(() => ({
            initialize: mocks.mockInitializeCodeChunking.mockResolvedValue(undefined),
            chunkFile: mocks.mockChunkFile,
            dispose: mocks.mockDisposeCodeChunking.mockResolvedValue(undefined),
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

        workspaceSettingsService = mocks.mockWorkspaceSettingsInstance as unknown as WorkspaceSettingsService;

        defaultIndexingOptions = {
            modelBasePath: path.join(extensionPath, 'models'),
            modelName: 'Xenova/all-MiniLM-L6-v2',
            contextLength: 256,
            extensionPath,
            embeddingOptions: {
                pooling: 'mean',
                normalize: true
            },
            maxConcurrentEmbeddingTasks: 2,
        };

        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            defaultIndexingOptions
        );
        await indexingService.initialize();
    });

    afterEach(async () => {
        if (indexingService) {
            await indexingService.dispose();
        }
    });

    it('should initialize its dependent services (mocked CodeChunkingService and mocked EmbeddingGenerationService)', () => {
        expect(mocks.mockInitializeEmbeddingGeneration).toHaveBeenCalledTimes(1);
        expect(mocks.mockInitializeCodeChunking).toHaveBeenCalledTimes(1);
    });

    it('should process files using mocked CodeChunkingService and mocked EmbeddingGenerationService', async () => {
        const file1: FileToProcess = { id: 'file1', path: 'testFile.js', content: 'console.log("hello");' };
        const file2: FileToProcess = { id: 'file2', path: 'anotherTest.ts', content: 'let greeting: string = "world";' };
        const filesToProcess: FileToProcess[] = [file1, file2];

        // Mock CodeChunkingService output
        const mockChunkingResult1: DetailedChunkingResult = {
            chunks: ['console.log("hello");'],
            offsets: [0],
            metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] }
        };
        const mockChunkingResult2: DetailedChunkingResult = {
            chunks: ['let greeting: string = "world";'],
            offsets: [0],
            metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] }
        };
        mocks.mockChunkFile
            .mockResolvedValueOnce(mockChunkingResult1)
            .mockResolvedValueOnce(mockChunkingResult2);

        // Mocked output from EmbeddingGenerationService.generateEmbeddingsForChunks
        const mockEmbeddingOutput1: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'file1', filePath: file1.path, chunkIndexInFile: 0, text: 'console.log("hello");', offsetInFile: 0 },
            embedding: Array.from([0.1, 0.2, 0.3]),
        }];
        const mockEmbeddingOutput2: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'file2', filePath: file2.path, chunkIndexInFile: 0, text: 'let greeting: string = "world";', offsetInFile: 0 },
            embedding: Array.from([0.4, 0.5, 0.6]),
        }];

        mocks.mockGenerateEmbeddingsForChunks
            .mockResolvedValueOnce(mockEmbeddingOutput1)
            .mockResolvedValueOnce(mockEmbeddingOutput2);

        const generator = indexingService.processFilesGenerator(filesToProcess);
        const { yielded, returned: results } = await collectAndReturn(generator);

        // Verify yielded results - they should be in the order of processing
        expect(yielded.length).toBe(2);

        // File 1 result
        expect(yielded[0].filePath).toBe(file1.path);
        expect(yielded[0].result.success).toBe(true);
        expect(yielded[0].result.embeddings[0]).toEqual(Array.from([0.1, 0.2, 0.3]));

        // File 2 result
        expect(yielded[1].filePath).toBe(file2.path);
        expect(yielded[1].result.success).toBe(true);
        expect(yielded[1].result.embeddings[0]).toEqual(Array.from([0.4, 0.5, 0.6]));

        // Verify final returned results map
        expect(results.size).toBe(2);
        const resultFile1 = results.get('file1');
        const resultFile2 = results.get('file2');

        expect(resultFile1).toBeDefined();
        expect(resultFile1?.success).toBe(true);
        expect(resultFile1?.embeddings[0]).toEqual(Array.from([0.1, 0.2, 0.3]));
        expect(resultFile1?.chunkOffsets).toEqual(mockChunkingResult1.offsets);

        expect(resultFile2).toBeDefined();
        expect(resultFile2?.success).toBe(true);
        expect(resultFile2?.embeddings[0]).toEqual(Array.from([0.4, 0.5, 0.6]));
        expect(resultFile2?.chunkOffsets).toEqual(mockChunkingResult2.offsets);

        // Verify CodeChunkingService was called correctly
        expect(mocks.mockChunkFile).toHaveBeenCalledTimes(2);
        expect(mocks.mockChunkFile).toHaveBeenNthCalledWith(
            1,
            file1,
            defaultIndexingOptions.embeddingOptions,
            expect.any(AbortSignal)
        );
        expect(mocks.mockChunkFile).toHaveBeenNthCalledWith(
            2,
            file2,
            defaultIndexingOptions.embeddingOptions,
            expect.any(AbortSignal)
        );


        // Verify EmbeddingGenerationService was called correctly
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledTimes(2);
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenNthCalledWith(
            1,
            expect.arrayContaining([
                expect.objectContaining({ fileId: 'file1', filePath: file1.path, text: mockChunkingResult1.chunks[0] })
            ]),
            expect.any(AbortSignal)
        );
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenNthCalledWith(
            2,
            expect.arrayContaining([
                expect.objectContaining({ fileId: 'file2', filePath: file2.path, text: mockChunkingResult2.chunks[0] })
            ]),
            expect.any(AbortSignal)
        );

        // Verify updateLastIndexingTimestamp was called
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should handle empty file list with processFilesGenerator', async () => {
        const generator = indexingService.processFilesGenerator([]);
        const { yielded, returned: results } = await collectAndReturn(generator);

        expect(yielded.length).toBe(0);
        expect(results.size).toBe(0);
        expect(mocks.mockChunkFile).not.toHaveBeenCalled();
        expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();
    });

    it('should handle EmbeddingGenerationService errors with processFilesGenerator', async () => {
        const fileWithError: FileToProcess = { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' };
        const mockChunkingResult: DetailedChunkingResult = {
            chunks: ['const x = 1;'], offsets: [0],
            metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] }
        };
        mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResult);

        const mockEmbeddingErrorOutput: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'file1', filePath: fileWithError.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 },
            embedding: null,
            error: 'Embedding generation failed for this chunk'
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValueOnce(mockEmbeddingErrorOutput);

        const generator = indexingService.processFilesGenerator([fileWithError]);
        const { yielded, returned: results } = await collectAndReturn(generator);


        expect(yielded.length).toBe(1);
        expect(yielded[0].filePath).toBe(fileWithError.path);
        expect(yielded[0].result.success).toBe(false);
        expect(yielded[0].result.error).toContain('Embedding generation failed for this chunk');


        expect(results.size).toBe(1);
        const resultFile1 = results.get('file1');
        expect(resultFile1).toBeDefined();
        expect(resultFile1?.success).toBe(false);
        expect(resultFile1?.error).toContain('Embedding generation failed for this chunk');
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledTimes(1);
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).not.toHaveBeenCalled();
    });

    it('should use StatusBarService for status updates with processFilesGenerator', async () => {
        const fileForStatus: FileToProcess = { id: 'test', path: '/test.js', content: 'test content' };
        const mockChunkingResultStatus: DetailedChunkingResult = {
            chunks: ['test content'], offsets: [0],
            metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] }
        };
        mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResultStatus);

        const mockEmbeddingOutputStatus: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'test', filePath: fileForStatus.path, chunkIndexInFile: 0, text: 'test content', offsetInFile: 0 },
            embedding: Array.from([0.1, 0.2]),
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValue(mockEmbeddingOutputStatus);

        const setStateSpy = vi.spyOn(statusBarServiceInstance, 'setState');
        const showTemporaryMessageSpy = vi.spyOn(statusBarServiceInstance, 'showTemporaryMessage');

        const generator = indexingService.processFilesGenerator([fileForStatus]);
        await collectAndReturn(generator); // Consume the generator

        // Verify status updates for sequential processing
        // Initial "Preparing"
        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Indexing, 'Preparing 1 files...');

        // During processing of the first (and only) file
        // This will be called twice for each file (before and after _processSingleFileSequentially)
        // For a single file, it might show "Processing file 0/1" then "Processing file 1/1"
        // then "Embeddings 0/1" then "Embeddings 1/1"
        expect(showTemporaryMessageSpy).toHaveBeenCalledWith(
            expect.stringMatching(/Indexing: Processing file (0|1)\/1 \(\d+%\)/),
            expect.any(Number),
            StatusBarMessageType.Working
        );
        // After chunking, before embedding (if chunks > 0)
        expect(showTemporaryMessageSpy).toHaveBeenCalledWith(
            expect.stringMatching(/Indexing: Processing file (0|1)\/1 \(\d+%\)/),
            expect.any(Number),
            StatusBarMessageType.Working
        );

        // Final "Ready" state
        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Ready, 'Indexing complete');
    });

    it('should update workspace settings after successful processing with processFilesGenerator', async () => {
        const fileForSettingUpdate: FileToProcess = { id: 'test', path: '/test.js', content: 'test content' };
        const mockChunkingResultSettings: DetailedChunkingResult = {
            chunks: ['test content'], offsets: [0],
            metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] }
        };
        mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResultSettings);

        const mockEmbeddingOutputSettings: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'test', filePath: fileForSettingUpdate.path, chunkIndexInFile: 0, text: 'test content', offsetInFile: 0 },
            embedding: Array.from([0.1, 0.2]),
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValue(mockEmbeddingOutputSettings);

        const generator = indexingService.processFilesGenerator([fileForSettingUpdate]);
        await collectAndReturn(generator); // Consume the generator

        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should handle cancellation correctly with processFilesGenerator', async () => {
        const fileToCancel: FileToProcess = { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' };
        const mockChunkingResultCancel: DetailedChunkingResult = {
            chunks: ['const x = 1;'], offsets: [0],
            metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] }
        };
        mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResultCancel);

        // Mock EGS to respect cancellation signal immediately
        mocks.mockGenerateEmbeddingsForChunks.mockImplementation(async (_chunks, signal) => {
            if (signal?.aborted) {
                throw new Error('Operation aborted by signal in EGS mock');
            }
            // Simulate a delay during which cancellation can occur
            await new Promise(resolve => setTimeout(resolve, 100));
            if (signal?.aborted) { // Check again after delay
                throw new Error('Operation aborted by signal in EGS mock after delay');
            }
            return [{
                originalChunkInfo: { fileId: 'file1', filePath: fileToCancel.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 },
                embedding: Array.from([0.1])
            }];
        });

        const tokenSource = new vscode.CancellationTokenSource();
        const generator = indexingService.processFilesGenerator([fileToCancel], tokenSource.token);

        // Schedule cancellation to occur during the EGS phase
        setTimeout(() => {
            tokenSource.cancel();
        }, 20); // Short delay, assuming chunking is faster

        const { yielded, returned: finalResults } = await collectAndReturn(generator);

        expect(yielded.length).toBe(1); // Should yield one result (the cancelled one)
        const yieldedResult = yielded[0].result;
        expect(yieldedResult.success).toBe(false);
        expect(yieldedResult.error).toMatch(/Operation cancelled|Operation aborted by signal in EGS mock/i);


        expect(finalResults.size).toBe(1);
        const resultFile1 = finalResults.get('file1');
        expect(resultFile1).toBeDefined();
        expect(resultFile1?.success).toBe(false);
        expect(resultFile1?.error).toMatch(/Operation cancelled|Operation aborted by signal in EGS mock/i);

        // EGS should have been called, and its signal should be aborted
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledTimes(1);
        const egsSignal = mocks.mockGenerateEmbeddingsForChunks.mock.calls[0][1] as AbortSignal;
        expect(egsSignal.aborted).toBe(true);

        // CCS should have completed successfully before cancellation hit EGS
        expect(mocks.mockChunkFile).toHaveBeenCalledTimes(1);
        const ccsSignal = mocks.mockChunkFile.mock.calls[0][2] as AbortSignal;
        expect(ccsSignal.aborted).toBe(false); // Assuming cancellation hits during EGS
    });


    it('should correctly handle cancellation with multiple files, stopping subsequent processing', async () => {
        const file1: FileToProcess = { id: 'f1-cancel', path: 'file1.js', content: 'content1' };
        const file2: FileToProcess = { id: 'f2-cancel', path: 'file2.js', content: 'content2' }; // Should not be processed
        const filesToProcess = [file1, file2];

        const mockChunkingResult1: DetailedChunkingResult = { chunks: ['content1'], offsets: [0], metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] } };
        mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResult1); // For file1

        mocks.mockGenerateEmbeddingsForChunks.mockImplementation(async (_chunks, signal) => {
            // Simulate work for file1's embeddings, then get cancelled
            await new Promise(resolve => setTimeout(resolve, 50));
            if (signal?.aborted) {
                throw new Error('EGS aborted for file1');
            }
            return [{ originalChunkInfo: { fileId: 'f1-cancel', filePath: 'file1.js', chunkIndexInFile: 0, text: 'content1', offsetInFile: 0 }, embedding: Array.from([0.1]) }];
        });

        const tokenSource = new vscode.CancellationTokenSource();
        const generator = indexingService.processFilesGenerator(filesToProcess, tokenSource.token);

        setTimeout(() => tokenSource.cancel(), 25); // Cancel during file1's EGS phase

        const { yielded, returned: finalResults } = await collectAndReturn(generator);

        expect(yielded.length).toBe(2); // file1 (cancelled), file2 (cancelled before start)

        const yieldedFile1 = yielded.find(y => y.filePath === file1.path);
        expect(yieldedFile1?.result.success).toBe(false);
        expect(yieldedFile1?.result.error).toMatch(/EGS aborted for file1|Operation cancelled/i);

        const yieldedFile2 = yielded.find(y => y.filePath === file2.path);
        expect(yieldedFile2?.result.success).toBe(false);
        expect(yieldedFile2?.result.error).toContain('Operation cancelled before processing could start for this file');


        expect(finalResults.size).toBe(2);
        expect(finalResults.get('f1-cancel')?.success).toBe(false);
        expect(finalResults.get('f1-cancel')?.error).toMatch(/EGS aborted for file1|Operation cancelled/i);
        expect(finalResults.get('f2-cancel')?.success).toBe(false);
        expect(finalResults.get('f2-cancel')?.error).toContain('Operation cancelled before processing could start for this file');


        expect(mocks.mockChunkFile).toHaveBeenCalledTimes(1); // Only for file1
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledTimes(1); // Only for file1
    });


    it('should call dispose on its services during disposal', async () => {
        // Spying on the mock's methods directly
        await indexingService.dispose();

        expect(mocks.mockDisposeEmbeddingGeneration).toHaveBeenCalledTimes(1);
        expect(mocks.mockDisposeCodeChunking).toHaveBeenCalledTimes(1);
    });

    // Progress reporting and batch completion callbacks are removed from processFilesGenerator directly.
    // Progress is now primarily via StatusBarService updates.
    // The generator yields results per file and returns a final map.
    // We will test these aspects instead.

    it('should yield results for each file processed by processFilesGenerator', async () => {
        const fileProgress1: FileToProcess = { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' };
        const fileProgress2: FileToProcess = { id: 'f2', path: '/path/to/f2.js', content: 'const y = 2;' };
        const filesForProgress: FileToProcess[] = [fileProgress1, fileProgress2];

        const mockChunkingResultP1: DetailedChunkingResult = { chunks: ['const x = 1;'], offsets: [0], metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] } };
        const mockChunkingResultP2: DetailedChunkingResult = { chunks: ['const y = 2;'], offsets: [0], metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] } };
        mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResultP1).mockResolvedValueOnce(mockChunkingResultP2);

        const mockEmbeddingOutputP1: EmbeddingGenerationOutput[] = [{ originalChunkInfo: { fileId: 'f1', filePath: fileProgress1.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 }, embedding: Array.from([0.1]) }];
        const mockEmbeddingOutputP2: EmbeddingGenerationOutput[] = [{ originalChunkInfo: { fileId: 'f2', filePath: fileProgress2.path, chunkIndexInFile: 0, text: 'const y = 2;', offsetInFile: 0 }, embedding: Array.from([0.2]) }];

        mocks.mockGenerateEmbeddingsForChunks
            .mockResolvedValueOnce(mockEmbeddingOutputP1)
            .mockResolvedValueOnce(mockEmbeddingOutputP2);

        const generator = indexingService.processFilesGenerator(filesForProgress);
        const { yielded, returned: finalMap } = await collectAndReturn(generator);

        expect(yielded.length).toBe(2);
        // Check order and content of yielded results
        expect(yielded[0].filePath).toBe(fileProgress1.path);
        expect(yielded[0].result.success).toBe(true);
        expect(yielded[0].result.embeddings[0]).toEqual(Array.from([0.1]));

        expect(yielded[1].filePath).toBe(fileProgress2.path);
        expect(yielded[1].result.success).toBe(true);
        expect(yielded[1].result.embeddings[0]).toEqual(Array.from([0.2]));

        expect(finalMap.size).toBe(2);
        expect(finalMap.get('f1')?.success).toBe(true);
        expect(finalMap.get('f2')?.success).toBe(true);
    });

    // The concept of a single "batchCompletedCallback" is replaced by the generator's final return value.
    // We'll test that the final map contains all results.
    it('should return a final map of all processing results from processFilesGenerator', async () => {
        const fileForBatch: FileToProcess = { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' };
        const mockChunkingResultBatch: DetailedChunkingResult = { chunks: ['const x = 1;'], offsets: [0], metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] } };
        mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResultBatch);

        const mockEmbeddingOutputBatch: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'f1', filePath: fileForBatch.path, chunkIndexInFile: 0, text: 'const x = 1;', offsetInFile: 0 },
            embedding: Array.from([0.1])
        }];
        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValue(mockEmbeddingOutputBatch);

        const generator = indexingService.processFilesGenerator([fileForBatch]);
        const { returned: resultsMap } = await collectAndReturn(generator);

        expect(resultsMap).toBeInstanceOf(Map);
        expect(resultsMap.size).toBe(1);
        expect(resultsMap.get('f1')?.success).toBe(true);
        expect(resultsMap.get('f1')?.embeddings[0]).toEqual(Array.from([0.1]));
    });

    it('should handle errors from CodeChunkingService.chunkFile', async () => {
        const fileToFailChunking: FileToProcess = { id: 'failChunk', path: '/path/to/failChunk.js', content: 'content' };
        mocks.mockChunkFile.mockRejectedValueOnce(new Error('Chunking failed miserably'));

        const generator = indexingService.processFilesGenerator([fileToFailChunking]);
        const { yielded, returned: results } = await collectAndReturn(generator);

        expect(yielded.length).toBe(1);
        expect(yielded[0].filePath).toBe(fileToFailChunking.path);
        expect(yielded[0].result.success).toBe(false);
        expect(yielded[0].result.error).toContain('Chunking failed miserably');

        expect(results.size).toBe(1);
        const result = results.get('failChunk');
        expect(result?.success).toBe(false);
        expect(result?.error).toContain('Chunking failed miserably');
        expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).not.toHaveBeenCalled();
    });

    it('should handle CodeChunkingService.chunkFile returning null', async () => {
        const fileWithNullChunks: FileToProcess = { id: 'nullChunk', path: '/path/to/nullChunk.js', content: 'content' };
        mocks.mockChunkFile.mockResolvedValueOnce(null as unknown as DetailedChunkingResult); // Simulate null return

        const generator = indexingService.processFilesGenerator([fileWithNullChunks]);
        const { yielded, returned: results } = await collectAndReturn(generator);

        expect(yielded.length).toBe(1);
        expect(yielded[0].filePath).toBe(fileWithNullChunks.path);
        // As per current _processSingleFileSequentially, null from chunkFile is an error if it was unexpected
        // If it means "chunking critically failed or was cancelled by signal"
        expect(yielded[0].result.success).toBe(true); // Or false depending on interpretation. Current code: true + error
        expect(yielded[0].result.error).toContain('File processing error: chunking critically failed or was cancelled by signal');


        expect(results.size).toBe(1);
        const result = results.get('nullChunk');
        expect(result?.success).toBe(true); // Or false
        expect(result?.error).toContain('File processing error: chunking critically failed or was cancelled by signal');
        expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();
    });

    it('should handle CodeChunkingService.chunkFile returning empty chunks array (file yields no chunks)', async () => {
        const fileWithEmptyChunks: FileToProcess = { id: 'emptyChunk', path: '/path/to/emptyChunk.js', content: 'content' };
        const emptyChunkingResult: DetailedChunkingResult = {
            chunks: [], offsets: [],
            metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] }
        };
        mocks.mockChunkFile.mockResolvedValueOnce(emptyChunkingResult);

        const generator = indexingService.processFilesGenerator([fileWithEmptyChunks]);
        const { yielded, returned: results } = await collectAndReturn(generator);

        expect(yielded.length).toBe(1);
        expect(yielded[0].filePath).toBe(fileWithEmptyChunks.path);
        expect(yielded[0].result.success).toBe(true); // Success, no error, but no embeddings
        expect(yielded[0].result.embeddings).toEqual([]);
        expect(yielded[0].result.error).toBeUndefined();


        expect(results.size).toBe(1);
        const result = results.get('emptyChunk');
        expect(result?.success).toBe(true);
        expect(result?.embeddings).toEqual([]);
        expect(result?.error).toBeUndefined();
        expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();
        // updateLastIndexingTimestamp should still be called if all files processed (even if some had no chunks that were not errors)
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should handle cancellation during chunking phase', async () => {
        const fileToCancelChunking: FileToProcess = { id: 'cancelChunk', path: '/path/to/cancelChunk.js', content: 'content' };
        mocks.mockChunkFile.mockImplementation(async (_file, _options, signal) => {
            return new Promise((_resolve, reject) => {
                if (signal?.aborted) {
                    return reject(new Error('Chunking aborted by signal'));
                }
                signal?.onCancellationRequested(() => reject(new Error('Chunking aborted by signal')));
                // Simulate some delay before cancellation hits
                setTimeout(() => reject(new Error('Chunking should have been cancelled')), 200);
            });
        });

        const tokenSource = new vscode.CancellationTokenSource();
        const generator = indexingService.processFilesGenerator([fileToCancelChunking], tokenSource.token);

        setTimeout(() => tokenSource.cancel(), 50); // Cancel shortly after starting

        const { yielded, returned: results } = await collectAndReturn(generator);

        expect(yielded.length).toBe(1); // Should yield the failure
        expect(yielded[0].filePath).toBe(fileToCancelChunking.path);
        expect(yielded[0].result.success).toBe(false);
        // The error message depends on how _processSingleFileSequentially handles errors from chunkFile when signal is aborted
        // It might be "Chunking failed: Chunking aborted by signal" or "Operation cancelled during chunking"
        expect(yielded[0].result.error).toMatch(/Chunking failed: Chunking aborted by signal|Operation cancelled during chunking/i);


        expect(results.size).toBe(1);
        const result = results.get('cancelChunk');
        expect(result?.success).toBe(false);
        expect(result?.error).toMatch(/Chunking failed: Chunking aborted by signal|Operation cancelled during chunking/i);
        expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();

        // Check if the AbortSignal passed to CCS was indeed aborted
        expect(mocks.mockChunkFile).toHaveBeenCalledTimes(1);
        const signalArgCCS = mocks.mockChunkFile.mock.calls[0][2] as AbortSignal;
        expect(signalArgCCS.aborted).toBe(true);
    });

    it('should handle mixed success and chunking failure for multiple files (sequential processing)', async () => {
        const successFile: FileToProcess = { id: 'successFile', path: '/path/to/success.js', content: 'console.log("yay")' };
        const chunkFailFile: FileToProcess = { id: 'chunkFailFile', path: '/path/to/chunkfail.js', content: 'problematic content' };
        const filesToProcess = [successFile, chunkFailFile];

        // Mock for successFile
        const mockChunkingResultSuccess: DetailedChunkingResult = {
            chunks: ['console.log("yay")'], offsets: [0],
            metadata: { parentStructureIds: [null], structureOrders: [null], isOversizedFlags: [false], structureTypes: [null] }
        };
        const mockEmbeddingOutputSuccess: EmbeddingGenerationOutput[] = [{
            originalChunkInfo: { fileId: 'successFile', filePath: successFile.path, chunkIndexInFile: 0, text: 'console.log("yay")', offsetInFile: 0 },
            embedding: Array.from([0.7, 0.8, 0.9]),
        }];

        mocks.mockChunkFile
            .mockResolvedValueOnce(mockChunkingResultSuccess) // For successFile
            .mockRejectedValueOnce(new Error('Chunking failed for second file')); // For chunkFailFile

        mocks.mockGenerateEmbeddingsForChunks.mockResolvedValueOnce(mockEmbeddingOutputSuccess); // For successFile

        const generator = indexingService.processFilesGenerator(filesToProcess);
        const { yielded, returned: results } = await collectAndReturn(generator);

        expect(yielded.length).toBe(2);

        // First file (success)
        expect(yielded[0].filePath).toBe(successFile.path);
        expect(yielded[0].result.success).toBe(true);
        expect(yielded[0].result.embeddings[0]).toEqual(Array.from([0.7, 0.8, 0.9]));

        // Second file (chunking failure)
        expect(yielded[1].filePath).toBe(chunkFailFile.path);
        expect(yielded[1].result.success).toBe(false);
        expect(yielded[1].result.error).toContain('Chunking failed for second file');


        expect(results.size).toBe(2);
        const successResult = results.get('successFile');
        expect(successResult?.success).toBe(true);
        expect(successResult?.embeddings[0]).toEqual(Array.from([0.7, 0.8, 0.9]));

        const failResult = results.get('chunkFailFile');
        expect(failResult?.success).toBe(false);
        expect(failResult?.error).toContain('Chunking failed for second file');

        // Verify sequential calls
        expect(mocks.mockChunkFile).toHaveBeenNthCalledWith(1, successFile, expect.any(Object), expect.any(AbortSignal));
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenNthCalledWith(1, expect.any(Array), expect.any(AbortSignal)); // For successFile
        expect(mocks.mockChunkFile).toHaveBeenNthCalledWith(2, chunkFailFile, expect.any(Object), expect.any(AbortSignal));
        expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledTimes(1); // Only for the first, successful file

        // updateLastIndexingTimestamp should not be called if any file processing fails
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).not.toHaveBeenCalled();
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

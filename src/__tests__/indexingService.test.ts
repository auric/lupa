import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingService, type IndexingServiceOptions, ChunkingError, EmbeddingError } from '../services/indexingService';
import type { FileToProcess, ProcessingResult, EmbeddingGenerationOutput } from '../types/indexingTypes';
import { StatusBarService } from '../services/statusBarService';
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
        showProgress: vi.fn(),
        hideProgress: vi.fn(),
        showTemporaryMessage: vi.fn(),
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
            MAIN_STATUS_BAR_ID: 'prAnalyzer.main'
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
vi.mock('vscode', async () => ({
    ...await vi.importActual<typeof import('vscode')>('vscode'),
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
vi.mock('os', async () => {
    const actual = await vi.importActual('os');
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

describe('IndexingService - Single File Processing', () => {
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

    describe('processFile()', () => {
        it('should successfully process a single file', async () => {
            const file: FileToProcess = {
                id: 'file1',
                path: 'testFile.js',
                content: 'console.log("hello");'
            };

            // Mock chunking service
            const mockChunkingResult: DetailedChunkingResult = {
                chunks: ['console.log("hello");'],
                offsets: [0],
                metadata: {
                    parentStructureIds: [null],
                    structureOrders: [null],
                    isOversizedFlags: [false],
                    structureTypes: [null]
                }
            };
            mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResult);

            // Mock embedding service
            const mockEmbeddingOutput: EmbeddingGenerationOutput[] = [{
                originalChunkInfo: {
                    fileId: 'file1',
                    filePath: file.path,
                    chunkIndexInFile: 0,
                    text: 'console.log("hello");',
                    offsetInFile: 0
                },
                embedding: [0.1, 0.2, 0.3],
            }];
            mocks.mockGenerateEmbeddingsForChunks.mockResolvedValueOnce(mockEmbeddingOutput);

            // Test the simplified API
            const result = await indexingService.processFile(file);

            // Verify result
            expect(result.success).toBe(true);
            expect(result.fileId).toBe(file.id);
            expect(result.filePath).toBe(file.path);
            expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
            expect(result.chunkOffsets).toEqual([0]);
            expect(result.error).toBeUndefined();

            // Verify service calls
            expect(mocks.mockChunkFile).toHaveBeenCalledWith(
                file,
                defaultIndexingOptions.embeddingOptions,
                expect.any(AbortSignal)
            );
            expect(mocks.mockGenerateEmbeddingsForChunks).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        fileId: 'file1',
                        filePath: file.path,
                        text: 'console.log("hello");'
                    })
                ]),
                expect.any(AbortSignal)
            );
        });

        it('should handle files with no chunks (empty file)', async () => {
            const file: FileToProcess = {
                id: 'empty',
                path: 'empty.js',
                content: ''
            };

            const emptyChunkingResult: DetailedChunkingResult = {
                chunks: [],
                offsets: [],
                metadata: {
                    parentStructureIds: [],
                    structureOrders: [],
                    isOversizedFlags: [],
                    structureTypes: []
                }
            };
            mocks.mockChunkFile.mockResolvedValueOnce(emptyChunkingResult);

            const result = await indexingService.processFile(file);

            expect(result.success).toBe(true);
            expect(result.embeddings).toEqual([]);
            expect(result.error).toBeUndefined();
            expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();
        });

        it('should handle chunking errors gracefully', async () => {
            const file: FileToProcess = {
                id: 'fail',
                path: 'fail.js',
                content: 'problematic content'
            };

            mocks.mockChunkFile.mockRejectedValueOnce(new Error('Chunking failed'));

            const result = await indexingService.processFile(file);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Chunking failed');
            expect(result.embeddings).toEqual([]);
            expect(mocks.mockGenerateEmbeddingsForChunks).not.toHaveBeenCalled();
        });

        it('should handle embedding errors gracefully', async () => {
            const file: FileToProcess = {
                id: 'embed-fail',
                path: 'embed-fail.js',
                content: 'const x = 1;'
            };

            const mockChunkingResult: DetailedChunkingResult = {
                chunks: ['const x = 1;'],
                offsets: [0],
                metadata: {
                    parentStructureIds: [null],
                    structureOrders: [null],
                    isOversizedFlags: [false],
                    structureTypes: [null]
                }
            };
            mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResult);

            mocks.mockGenerateEmbeddingsForChunks.mockRejectedValueOnce(
                new Error('Embedding generation failed')
            );

            const result = await indexingService.processFile(file);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Embedding generation failed');
            expect(result.embeddings).toEqual([]);
        });

        it('should handle partial embedding failures', async () => {
            const file: FileToProcess = {
                id: 'partial-fail',
                path: 'partial-fail.js',
                content: 'multi-chunk content'
            };

            const mockChunkingResult: DetailedChunkingResult = {
                chunks: ['chunk1', 'chunk2'],
                offsets: [0, 10],
                metadata: {
                    parentStructureIds: [null, null],
                    structureOrders: [null, null],
                    isOversizedFlags: [false, false],
                    structureTypes: [null, null]
                }
            };
            mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResult);

            const mockEmbeddingOutput: EmbeddingGenerationOutput[] = [
                {
                    originalChunkInfo: {
                        fileId: 'partial-fail',
                        filePath: file.path,
                        chunkIndexInFile: 0,
                        text: 'chunk1',
                        offsetInFile: 0
                    },
                    embedding: [0.1, 0.2],
                },
                {
                    originalChunkInfo: {
                        fileId: 'partial-fail',
                        filePath: file.path,
                        chunkIndexInFile: 1,
                        text: 'chunk2',
                        offsetInFile: 10
                    },
                    embedding: null,
                    error: 'Embedding failed for chunk'
                }
            ];
            mocks.mockGenerateEmbeddingsForChunks.mockResolvedValueOnce(mockEmbeddingOutput);

            const result = await indexingService.processFile(file);

            expect(result.success).toBe(true); // Partial success
            expect(result.embeddings).toEqual([[0.1, 0.2]]); // Only successful embedding
            expect(result.error).toBeUndefined();
        });

        it('should handle cancellation during processing', async () => {
            const file: FileToProcess = {
                id: 'cancel',
                path: 'cancel.js',
                content: 'content'
            };

            const tokenSource = new vscode.CancellationTokenSource();

            mocks.mockChunkFile.mockImplementation(async () => {
                // Simulate cancellation during chunking
                tokenSource.cancel();
                throw new Error('Operation cancelled');
            });

            const result = await indexingService.processFile(file, tokenSource.token);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Operation cancelled during chunking');
        });
    });

    describe('error handling', () => {
        it('should throw ChunkingError for chunking failures', async () => {
            const file: FileToProcess = { id: 'test', path: 'test.js', content: 'test' };

            mocks.mockChunkFile.mockRejectedValueOnce(new Error('Chunking error'));

            const result = await indexingService.processFile(file);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Chunking failed: Chunking error');
        });

        it('should throw EmbeddingError for embedding failures', async () => {
            const file: FileToProcess = { id: 'test', path: 'test.js', content: 'test' };

            const mockChunkingResult: DetailedChunkingResult = {
                chunks: ['test'],
                offsets: [0],
                metadata: {
                    parentStructureIds: [null],
                    structureOrders: [null],
                    isOversizedFlags: [false],
                    structureTypes: [null]
                }
            };
            mocks.mockChunkFile.mockResolvedValueOnce(mockChunkingResult);

            mocks.mockGenerateEmbeddingsForChunks.mockRejectedValueOnce(
                new Error('Embedding error')
            );

            const result = await indexingService.processFile(file);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Embedding generation failed: Embedding error');
        });
    });


    describe('service lifecycle', () => {
        it('should initialize dependent services correctly', async () => {
            expect(mocks.mockInitializeCodeChunking).toHaveBeenCalledTimes(1);
            expect(mocks.mockInitializeEmbeddingGeneration).toHaveBeenCalledTimes(1);
        });

        it('should dispose dependent services correctly', async () => {
            await indexingService.dispose();

            expect(mocks.mockDisposeCodeChunking).toHaveBeenCalledTimes(1);
            expect(mocks.mockDisposeEmbeddingGeneration).toHaveBeenCalledTimes(1);
        });

        it('should validate initialization before processing', async () => {
            const uninitializedService = new IndexingService(
                context,
                workspaceSettingsService,
                defaultIndexingOptions
            );
            // Don't call initialize() on purpose

            const file: FileToProcess = { id: 'test', path: 'test.js', content: 'test' };

            await expect(uninitializedService.processFile(file))
                .rejects.toThrow('IndexingService or its dependent services are not properly initialized');
        });
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

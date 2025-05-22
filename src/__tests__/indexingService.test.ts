import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingService } from '../services/indexingService';
import { FileToProcess, ProcessingResult } from '../workers/asyncIndexingProcessor'
import { StatusBarService, StatusBarState } from '../services/statusBarService';
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

    const mockPiscinaInstance = {
        run: vi.fn(),
        destroy: vi.fn().mockResolvedValue(undefined)
    };

    const mockPiscinaConstructor = vi.fn().mockImplementation(() => mockPiscinaInstance);

    return {
        mockStatusBarItem,
        mockStatusBarInstance,
        mockWorkspaceSettingsInstance,
        mockPiscinaInstance,
        mockPiscinaConstructor
    };
});

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
        file: vi.fn((path: string) => ({ path, scheme: 'file' }))
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

// Mock Piscina
vi.mock('piscina', () => {
    return {
        default: mocks.mockPiscinaConstructor
    };
});

describe('IndexingService', () => {
    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let statusBarServiceInstance: any;
    let extensionPath: string;
    let workspaceSettingsService: WorkspaceSettingsService;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

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
            } as unknown as vscode.CancellationTokenSource; // Cast to assure TS it's a CancellationTokenSource
        });

        // Redefine mock behaviors after clearMocks
        mocks.mockPiscinaConstructor.mockImplementation(() => mocks.mockPiscinaInstance);
        mocks.mockPiscinaInstance.run.mockImplementation(vi.fn());
        mocks.mockPiscinaInstance.destroy.mockResolvedValue(undefined);
        mocks.mockWorkspaceSettingsInstance.getSelectedEmbeddingModel.mockReturnValue(undefined);
        mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp.mockImplementation(() => { });

        // Reset StatusBarService instance
        StatusBarService.reset();
        statusBarServiceInstance = StatusBarService.getInstance();

        // Set up the extension path to the actual project root
        extensionPath = path.resolve(__dirname, '..', '..');

        // Mock context
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

        // Create service instances using the mocked constructor
        workspaceSettingsService = mocks.mockWorkspaceSettingsInstance as unknown as WorkspaceSettingsService;

        // Create IndexingService with required options
        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            {
                modelBasePath: path.join(extensionPath, 'models'),
                modelName: 'Xenova/all-MiniLM-L6-v2',
                contextLength: 256,
                maxConcurrentTasks: 2
            }
        );
    });

    afterEach(async () => {
        try {
            await indexingService.dispose();
        } catch (e) {
            console.error('Error during cleanup:', e);
        }
    });

    it('should initialize Piscina pool correctly', () => {
        // Verify Piscina was initialized with correct parameters
        expect(mocks.mockPiscinaConstructor).toHaveBeenCalledWith({
            filename: path.join(extensionPath, 'dist', 'workers', 'asyncIndexingProcessor.js'),
            maxThreads: 2,
            workerData: {
                modelBasePath: path.join(extensionPath, 'models'),
                modelName: 'Xenova/all-MiniLM-L6-v2',
                contextLength: 256,
                embeddingOptions: {
                    pooling: 'mean',
                    normalize: true
                }
            }
        });
    });

    it('should process files successfully with Piscina', async () => {
        // Setup mock successful responses
        const mockResults: ProcessingResult[] = [
            {
                fileId: 'file1',
                embeddings: [new Float32Array([0.1, 0.2, 0.3])],
                chunkOffsets: [0],
                metadata: {
                    parentStructureIds: [],
                    structureOrders: [],
                    isOversizedFlags: [],
                    structureTypes: []
                },
                success: true
            },
            {
                fileId: 'file2',
                embeddings: [new Float32Array([0.4, 0.5, 0.6])],
                chunkOffsets: [0],
                metadata: {
                    parentStructureIds: [],
                    structureOrders: [],
                    isOversizedFlags: [],
                    structureTypes: []
                },
                success: true
            }
        ];

        // Mock Piscina run method to return successful results
        mocks.mockPiscinaInstance.run
            .mockResolvedValueOnce(mockResults[0])
            .mockResolvedValueOnce(mockResults[1]);

        const files: FileToProcess[] = [
            { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' },
            { id: 'file2', path: '/path/to/file2.js', content: 'const y = 2;' }
        ];

        // Process files
        const results = await indexingService.processFiles(files);

        // Verify results
        expect(results.size).toBe(2);
        expect(results.get('file1')).toBeDefined();
        expect(results.get('file2')).toBeDefined();
        expect(results.get('file1')?.success).toBe(true);
        expect(results.get('file2')?.success).toBe(true);

        // Verify Piscina was called correctly
        expect(mocks.mockPiscinaInstance.run).toHaveBeenCalledTimes(2);
        expect(mocks.mockPiscinaInstance.run).toHaveBeenCalledWith(
            { file: files[0] },
            { signal: expect.any(AbortSignal) }
        );
        expect(mocks.mockPiscinaInstance.run).toHaveBeenCalledWith(
            { file: files[1] },
            { signal: expect.any(AbortSignal) }
        );

        // Verify updateLastIndexingTimestamp was called
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should handle empty file list', async () => {
        const results = await indexingService.processFiles([]);
        expect(results.size).toBe(0);
        expect(mocks.mockPiscinaInstance.run).not.toHaveBeenCalled();
    });

    it('should handle Piscina worker errors', async () => {
        // Mock Piscina to throw an error
        mocks.mockPiscinaInstance.run.mockRejectedValue(new Error('Worker failed'));

        const files: FileToProcess[] = [
            { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' }
        ];

        const results = await indexingService.processFiles(files);

        // Should still return a result map, but with error result
        expect(results.size).toBe(0); // Failed results are not included in final map
        expect(mocks.mockPiscinaInstance.run).toHaveBeenCalled();

        // Even with errors, updateLastIndexingTimestamp should still be called
        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should use StatusBarService for status updates', async () => {
        const mockResult: ProcessingResult = {
            fileId: 'test',
            embeddings: [new Float32Array([0.1, 0.2])],
            chunkOffsets: [0],
            metadata: {
                parentStructureIds: [],
                structureOrders: [],
                isOversizedFlags: [],
                structureTypes: []
            },
            success: true
        };

        mocks.mockPiscinaInstance.run.mockResolvedValue(mockResult);

        const setStateSpy = vi.spyOn(statusBarServiceInstance, 'setState');
        const showTemporaryMessageSpy = vi.spyOn(statusBarServiceInstance, 'showTemporaryMessage');

        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Indexing, '1 files');
        expect(showTemporaryMessageSpy).toHaveBeenCalled();
    });

    it('should update workspace settings after processing', async () => {
        const mockResult: ProcessingResult = {
            fileId: 'test',
            embeddings: [new Float32Array([0.1, 0.2])],
            chunkOffsets: [0],
            metadata: {
                parentStructureIds: [],
                structureOrders: [],
                isOversizedFlags: [],
                structureTypes: []
            },
            success: true
        };

        mocks.mockPiscinaInstance.run.mockResolvedValue(mockResult);

        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        expect(mocks.mockWorkspaceSettingsInstance.updateLastIndexingTimestamp).toHaveBeenCalled();
    });

    it('should handle cancellation correctly', async () => {
        // Mock Piscina to simulate long-running task that gets cancelled
        mocks.mockPiscinaInstance.run.mockImplementation(() =>
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Operation was cancelled')), 100);
            })
        );

        const files = [
            { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' }
        ];

        const tokenSource = new vscode.CancellationTokenSource();
        const processPromise = indexingService.processFiles(files, tokenSource.token);

        // Cancel immediately
        tokenSource.cancel();

        // The IndexingService handles cancellation gracefully and returns an empty Map
        // rather than throwing an error
        const result = await processPromise;
        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0); // Should be empty since the task was cancelled/failed
    });

    it('should call destroy on Piscina during disposal', async () => {
        await indexingService.dispose();
        expect(mocks.mockPiscinaInstance.destroy).toHaveBeenCalled();
    });

    it('should support progress reporting', async () => {
        const mockResults: ProcessingResult[] = [
            {
                fileId: 'f1',
                embeddings: [new Float32Array([0.1])],
                chunkOffsets: [0],
                metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
                success: true
            },
            {
                fileId: 'f2',
                embeddings: [new Float32Array([0.2])],
                chunkOffsets: [0],
                metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
                success: true
            }
        ];

        // Mock progressive resolution
        let resolveCount = 0;
        mocks.mockPiscinaInstance.run.mockImplementation(() => {
            return Promise.resolve(mockResults[resolveCount++]);
        });

        const progressCallback = vi.fn();

        const files: FileToProcess[] = [
            { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' },
            { id: 'f2', path: '/path/to/f2.js', content: 'const y = 2;' }
        ];

        await indexingService.processFiles(files, undefined, progressCallback);

        // Verify progress was reported
        expect(progressCallback).toHaveBeenCalledWith(1, 2);
        expect(progressCallback).toHaveBeenCalledWith(2, 2);
    });

    it('should support batch completion callback', async () => {
        const mockResults: ProcessingResult[] = [
            {
                fileId: 'f1',
                embeddings: [new Float32Array([0.1])],
                chunkOffsets: [0],
                metadata: { parentStructureIds: [], structureOrders: [], isOversizedFlags: [], structureTypes: [] },
                success: true
            }
        ];

        mocks.mockPiscinaInstance.run.mockResolvedValue(mockResults[0]);

        const batchCompletedCallback = vi.fn().mockResolvedValue(undefined);

        const files: FileToProcess[] = [
            { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' }
        ];

        await indexingService.processFiles(files, undefined, undefined, batchCompletedCallback);

        // Verify batch callback was called
        expect(batchCompletedCallback).toHaveBeenCalledWith(
            expect.any(Map)
        );
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

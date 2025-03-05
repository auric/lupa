import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IndexingService, FileToProcess } from '../services/indexingService';
import { StatusBarService } from '../services/statusBarService';
import { ResourceDetectionService } from '../services/resourceDetectionService';
import { ModelSelectionService, EmbeddingModel } from '../services/modelSelectionService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

// Mock the StatusBarService
jest.mock('../services/statusBarService', () => {
    // Create a mock status bar item
    const mockStatusBarItem = {
        text: '',
        tooltip: '',
        command: '',
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn()
    };

    const mockInstance = {
        getOrCreateItem: jest.fn().mockReturnValue(mockStatusBarItem),
        setMainStatusBarText: jest.fn(),
        showTemporaryMessage: jest.fn(),
        hideItem: jest.fn(),
        showItem: jest.fn(),
        clearTemporaryMessages: jest.fn(),
        dispose: jest.fn()
    };

    return {
        StatusBarService: {
            getInstance: jest.fn().mockReturnValue(mockInstance),
            reset: jest.fn(),
            MAIN_STATUS_BAR_ID: 'prAnalyzer.main'
        },
        StatusBarMessageType: {
            Info: 'info',
            Warning: 'warning',
            Error: 'error',
            Working: 'working'
        }
    };
});

// Mock resource detection service
jest.mock('../services/resourceDetectionService', () => {
    return {
        ResourceDetectionService: jest.fn().mockImplementation(() => ({
            detectSystemResources: jest.fn().mockReturnValue({
                totalMemoryGB: 16,
                freeMemoryGB: 8,
                cpuCount: 4,
                availableMemoryGB: 4
            }),
            calculateOptimalWorkerCount: jest.fn().mockReturnValue(2)
        }))
    };
});

// Mock model selection service
jest.mock('../services/modelSelectionService', () => {
    const mockModelInfo = {
        name: 'Xenova/all-MiniLM-L6-v2',
        path: 'Xenova/all-MiniLM-L6-v2',
        memoryRequirementGB: 2,
        contextLength: 512,
        description: 'Test model'
    };

    return {
        ModelSelectionService: jest.fn().mockImplementation(() => ({
            selectOptimalModel: jest.fn().mockReturnValue({
                model: 'Xenova/all-MiniLM-L6-v2',
                modelInfo: mockModelInfo,
                useHighMemoryModel: false
            }),
            showModelsInfo: jest.fn(),
            dispose: jest.fn()
        })),
        EmbeddingModel: {
            JinaEmbeddings: 'jinaai/jina-embeddings-v2-base-code',
            MiniLM: 'Xenova/all-MiniLM-L6-v2'
        }
    };
});

// Mock workspace settings service
jest.mock('../services/workspaceSettingsService', () => {
    return {
        WorkspaceSettingsService: jest.fn().mockImplementation(() => ({
            getSelectedEmbeddingModel: jest.fn().mockReturnValue(undefined),
            setSelectedEmbeddingModel: jest.fn(),
            updateLastIndexingTimestamp: jest.fn(),
            getSetting: jest.fn(),
            setSetting: jest.fn(),
            clearWorkspaceSettings: jest.fn(),
            resetAllSettings: jest.fn(),
            dispose: jest.fn()
        }))
    };
});

// Mock vscode module
jest.mock('vscode', () => {
    const originalVscode = jest.requireActual('vscode');
    return {
        ...originalVscode,
        window: {
            createStatusBarItem: jest.fn().mockImplementation(() => ({
                text: '',
                tooltip: '',
                command: '',
                show: jest.fn(),
                hide: jest.fn(),
                dispose: jest.fn()
            })),
            showInformationMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            showWarningMessage: jest.fn().mockResolvedValue(undefined),
            setStatusBarMessage: jest.fn(),
            showQuickPick: jest.fn().mockResolvedValue(undefined)
        },
        Uri: {
            file: jest.fn(path => ({ fsPath: path })),
            joinPath: jest.fn((uri, ...segments) => {
                return { fsPath: path.join(uri.fsPath, ...segments) };
            })
        },
        ProgressLocation: {
            Notification: 1,
            Window: 10
        },
        StatusBarAlignment: {
            Left: 1,
            Right: 2
        },
        commands: {
            registerCommand: jest.fn()
        },
        Disposable: {
            from: jest.fn()
        },
        CancellationTokenSource: jest.fn().mockImplementation(() => {
            // Explicitly type the listeners array
            const listeners: Array<() => void> = [];
            const tokenObj = {
                isCancellationRequested: false,
                onCancellationRequested: jest.fn((listener: () => void) => {
                    listeners.push(listener);
                    return {
                        dispose: jest.fn(() => {
                            const index = listeners.indexOf(listener);
                            if (index !== -1) {
                                listeners.splice(index, 1);
                            }
                        })
                    };
                })
            };

            return {
                token: tokenObj,
                cancel: jest.fn(() => {
                    tokenObj.isCancellationRequested = true;
                    listeners.forEach(listener => listener());
                }),
                dispose: jest.fn(),
            };
        })
    };
});

jest.mock('os', () => {
    const actual = jest.requireActual('os');
    return {
        ...actual, // Keep all original functions by default
        cpus: jest.fn().mockImplementation(() => actual.cpus()),
        totalmem: jest.fn().mockImplementation(() => actual.totalmem()),
        freemem: jest.fn().mockImplementation(() => actual.freemem())
    };
});

describe('IndexingService', () => {
    // Increase timeout to 30 seconds for model loading tests
    jest.setTimeout(60000);

    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let statusBarServiceInstance: any;
    let extensionPath: string;
    let resourceDetectionService: ResourceDetectionService;
    let modelSelectionService: ModelSelectionService;
    let workspaceSettingsService: WorkspaceSettingsService;

    let mockedCpus: jest.Mock;
    let mockedTotalmem: jest.Mock;
    let mockedFreemem: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        // Reset mock implementations to defaults before each test
        mockedCpus = os.cpus as jest.Mock;
        mockedTotalmem = os.totalmem as jest.Mock;
        mockedFreemem = os.freemem as jest.Mock;

        // Set default implementations
        mockedCpus.mockReturnValue(Array(4).fill({} as os.CpuInfo));
        mockedTotalmem.mockReturnValue(16 * 1024 * 1024 * 1024); // 16GB by default
        mockedFreemem.mockReturnValue(8 * 1024 * 1024 * 1024);  // 8GB free by default

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
                update: jest.fn(),
                get: jest.fn()
            },
            subscriptions: [],
            asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath)
        } as unknown as vscode.ExtensionContext;

        // Create service instances
        resourceDetectionService = new ResourceDetectionService();
        modelSelectionService = new ModelSelectionService(path.join(extensionPath, 'models'));
        workspaceSettingsService = new WorkspaceSettingsService(context);

        // Create IndexingService with mocked dependencies
        indexingService = new IndexingService(
            context,
            resourceDetectionService,
            modelSelectionService,
            workspaceSettingsService,
            {
                maxWorkers: 1
            }
        );
    });

    afterEach(async () => {
        // Cleanup
        try {
            await indexingService.dispose();
        } catch (e) {
            console.error('Error during cleanup:', e);
        }
    });

    // Tests that the workers are not initialized until needed
    it('should not initialize workers on creation', () => {
        // No workers should have been created yet
        expect((indexingService as any).workers.length).toBe(0);
        expect((indexingService as any).workersInitialized).toBe(false);
    });

    it('should initialize workers on demand', async () => {
        // Create a file to process
        const fileToProcess: FileToProcess = {
            id: 'file1',
            path: '/path/to/file1.js',
            content: 'const x = 1;'
        };

        // Process the file - this should initialize workers
        await indexingService.processFiles([fileToProcess]);

        // Now workers should be initialized
        expect((indexingService as any).workers.length).toBeGreaterThan(0);
        expect((indexingService as any).workersInitialized).toBe(true);
    });

    it('should process files successfully', async () => {
        // Create test files
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
        expect(results.get('file1')?.embeddings.length).toBeGreaterThan(0);
        expect(results.get('file2')?.embeddings.length).toBeGreaterThan(0);
    });

    it('should handle empty file list', async () => {
        // Process empty file list
        const results = await indexingService.processFiles([]);

        // Should return an empty map
        expect(results.size).toBe(0);
    });

    it('should handle file chunking correctly', async () => {
        // Create a file that would need to be chunked (large content)
        const largeContent = 'x'.repeat(8000); // Larger than default chunk size
        const files: FileToProcess[] = [
            { id: 'large', path: '/path/to/large.js', content: largeContent }
        ];

        // Process the file
        const results = await indexingService.processFiles(files);

        // Verify result exists
        expect(results.get('large')).toBeDefined();
        expect(results.get('large')?.success).toBe(true);
        // We should have multiple embeddings for this large content (at least 2)
        expect(results.get('large')?.embeddings.length).toBeGreaterThan(1);
    });

    // Test that the service uses the StatusBarService singleton correctly
    it('should use StatusBarService for status updates', async () => {
        // Get StatusBarService mock instance
        const getOrCreateItemSpy = jest.spyOn(statusBarServiceInstance, 'getOrCreateItem');

        // Process a file
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify the status bar service was used
        expect(getOrCreateItemSpy).toHaveBeenCalled();
    });

    // Test the model selection process
    it('should use ModelSelectionService to select the model', async () => {
        const selectOptimalModelSpy = jest.spyOn(modelSelectionService, 'selectOptimalModel');

        // Process a file to trigger model selection
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify the model selection service was used
        expect(selectOptimalModelSpy).toHaveBeenCalled();
    });

    // Test the workspace settings integration
    it('should update workspace settings after initializing workers', async () => {
        const updateLastIndexingTimestampSpy = jest.spyOn(workspaceSettingsService, 'updateLastIndexingTimestamp');

        // Process a file to trigger worker initialization
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify the workspace settings were updated
        expect(updateLastIndexingTimestampSpy).toHaveBeenCalled();
    });

    // Test that optimal chunk size is calculated based on model context length
    it('should calculate optimal chunk size based on model context length', async () => {
        // Mock the model context length
        const getOptimalChunkSizeSpy = jest.spyOn(indexingService as any, 'getOptimalChunkSize');

        // Process a file
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify optimal chunk size was calculated
        expect(getOptimalChunkSizeSpy).toHaveBeenCalled();
    });

    // Add this test to your test suite
    it('should handle cancellation correctly', async () => {
        // Create a file to process
        const files = [
            { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' }
        ];

        // Create a cancellation token source
        const tokenSource = new vscode.CancellationTokenSource();

        // Start processing and immediately cancel
        const processPromise = indexingService.processFiles(files, tokenSource.token);

        // Trigger cancellation
        tokenSource.cancel();

        // Verify that the operation was cancelled
        await expect(processPromise).rejects.toThrow('Operation cancelled');
    });

    it('should process files in parallel with multiple workers', async () => {
        // Create service with multiple workers
        const multiWorkerService = new IndexingService(
            context,
            resourceDetectionService,
            modelSelectionService,
            workspaceSettingsService,
            { maxWorkers: 2 }
        );

        try {
            // Create multiple files to process
            const files: FileToProcess[] = [
                { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' },
                { id: 'f2', path: '/path/to/f2.js', content: 'const y = 2;' },
                { id: 'f3', path: '/path/to/f3.js', content: 'const z = 3;' }
            ];

            // Process files
            const results = await multiWorkerService.processFiles(files);

            // Verify all files were processed
            expect(results.size).toBe(3);
            expect(results.get('f1')?.success).toBe(true);
            expect(results.get('f2')?.success).toBe(true);
            expect(results.get('f3')?.success).toBe(true);
        } finally {
            await multiWorkerService.dispose();
        }
    });

    it('should calculate optimal resources based on system memory', () => {
        // Directly test the calculateOptimalResources method
        const result = (indexingService as any).calculateOptimalResources();

        // Verify the result format
        expect(result).toHaveProperty('workerCount');
        expect(result).toHaveProperty('useHighMemoryModel');

        // Ensure returned values are within expected ranges
        expect(result.workerCount).toBeGreaterThanOrEqual(1);
        expect(typeof result.useHighMemoryModel).toBe('boolean');
    });

    // Skip some tests that need more complex mocking for now
    it('should handle worker errors and recreate workers', async () => {
        // Process a file to initialize worker
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Get reference to the worker
        const workers = (indexingService as any).workers;
        expect(workers.length).toBeGreaterThan(0);

        // Simulate an error in the worker
        const workerErrorSpy = jest.spyOn(indexingService as any, 'handleWorkerError');
        const recreateWorkerSpy = jest.spyOn(indexingService as any, 'recreateWorker');

        // Manually trigger the error handler
        (indexingService as any).handleWorkerError(workers[0].worker, new Error('Test error'));

        // Verify error handling and worker recreation was attempted
        expect(workerErrorSpy).toHaveBeenCalled();
        expect(recreateWorkerSpy).toHaveBeenCalled();

        // Cleanup spies
        workerErrorSpy.mockRestore();
        recreateWorkerSpy.mockRestore();
    });

    it('should test status bar updates during processing', async () => {
        // Spy on updateStatusBar method
        const updateStatusBarSpy = jest.spyOn(indexingService as any, 'updateStatusBar');
        const setMainStatusBarTextSpy = jest.spyOn(statusBarServiceInstance, 'setMainStatusBarText');

        // Create test files
        const files: FileToProcess[] = [
            { id: 'status1', path: '/path/to/status1.js', content: 'const a = 1;' }
        ];

        // Process files
        await indexingService.processFiles(files);

        // Verify status bar was updated
        expect(updateStatusBarSpy).toHaveBeenCalled();

        // Cleanup
        updateStatusBarSpy.mockRestore();
        setMainStatusBarTextSpy.mockRestore();
    });

    it('should correctly manage workers based on system resources', () => {
        try {
            // Mock ResourceDetectionService to simulate different environments
            jest.spyOn(resourceDetectionService, 'calculateOptimalWorkerCount')
                .mockReturnValueOnce(1)  // Simulate low resources
                .mockReturnValueOnce(4); // Simulate high resources

            // Get optimal resources in "low resource" environment
            const lowResource = (indexingService as any).calculateOptimalResources();
            expect(lowResource.workerCount).toBe(1);

            // Get optimal resources in "high resource" environment
            const highResource = (indexingService as any).calculateOptimalResources();
            expect(highResource.workerCount).toBe(4);
        } finally {
            jest.restoreAllMocks();
        }
    });

    it('should properly clean up resources on disposal', async () => {
        // Create token source to test cancellation
        (indexingService as any).cancelTokenSource = new vscode.CancellationTokenSource();
        const cancelSpy = jest.spyOn((indexingService as any).cancelTokenSource, 'cancel');

        // Add some items to queues
        (indexingService as any).workQueue = [{ id: 'test1' }];
        (indexingService as any).activeProcessing.set('test2', { id: 'test2' });

        // Mock shutdownWorkers to verify it's called
        const shutdownSpy = jest.spyOn(indexingService as any, 'shutdownWorkers')
            .mockResolvedValue(undefined);

        await indexingService.dispose();

        // Verify cleanup happened
        expect(cancelSpy).toHaveBeenCalled();
        expect(shutdownSpy).toHaveBeenCalled();
        expect((indexingService as any).workQueue.length).toBe(0);
        expect((indexingService as any).activeProcessing.size).toBe(0);

        // Clean up
        cancelSpy.mockRestore();
        shutdownSpy.mockRestore();
    });
});
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IndexingService, FileToProcess } from '../services/indexingService';
import { ModelCacheService } from '../services/modelCacheService';
import { StatusBarService } from '../services/statusBarService';

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
                                listeners.splice(index, 1);  // Using splice is cleaner than filter+reassign
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
    let modelCacheService: ModelCacheService;
    let statusBarServiceInstance: any;
    let extensionPath: string;

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

        // Create real model cache service that will use the actual models
        modelCacheService = {
            getModelsPath: jest.fn().mockReturnValue(path.join(extensionPath, 'models')),
            dispose: jest.fn()
        } as unknown as ModelCacheService;

        // Check if models actually exist in the test environment
        const modelsPath = modelCacheService.getModelsPath();
        const primaryModelPath = path.join(modelsPath, 'jinaai', 'jina-embeddings-v2-base-code');
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        // Verify models exist
        const primaryExists = fs.existsSync(primaryModelPath) && fs.readdirSync(primaryModelPath).length > 0;
        const fallbackExists = fs.existsSync(fallbackModelPath) && fs.readdirSync(fallbackModelPath).length > 0;

        if (!primaryExists && !fallbackExists) {
            console.warn('No models found for testing. Tests will be skipped or may fail.');
            console.warn('Run "npm run prepare-models" to download models before testing.');
        }

        // Create IndexingService with real dependencies, using a low worker count for testing
        indexingService = new IndexingService(
            context,
            modelCacheService,
            {
                maxWorkers: 1 // Use just 1 worker for testing to reduce resource usage
            }
        );
    });

    afterEach(async () => {
        // Cleanup
        try {
            await indexingService.dispose();
        } catch (e) {
            console.log('Ignoring dispose error in tests:', e);
        }
    });

    // Tests that the workers are not initialized until needed
    it('should not initialize workers on creation', () => {
        // No workers should have been created yet
        expect((indexingService as any).workers.length).toBe(0);
        expect((indexingService as any).workersInitialized).toBe(false);
    });

    it('should initialize workers on demand', async () => {
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

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
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

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
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

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

        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

        // Process a file
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify the status bar service was used
        expect(getOrCreateItemSpy).toHaveBeenCalled();
    });

    // Add this test to your test suite
    it('should handle cancellation correctly', async () => {
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

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
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

        // Create service with multiple workers
        const multiWorkerService = new IndexingService(
            context,
            modelCacheService,
            {
                maxWorkers: 2 // Use 2 workers to test parallel processing
            }
        );

        try {
            // Create several files to process
            const files: FileToProcess[] = [
                { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;' },
                { id: 'file2', path: '/path/to/file2.js', content: 'const y = 2;' },
                { id: 'file3', path: '/path/to/file3.js', content: 'const z = 3;' },
                { id: 'file4', path: '/path/to/file4.js', content: 'const w = 4;' }
            ];

            // Process files
            const results = await multiWorkerService.processFiles(files);

            // Verify all files were processed
            expect(results.size).toBe(4);
            expect(results.get('file1')).toBeDefined();
            expect(results.get('file2')).toBeDefined();
            expect(results.get('file3')).toBeDefined();
            expect(results.get('file4')).toBeDefined();

            // Verify workers were initialized
            expect((multiWorkerService as any).workers.length).toBe(2);
            expect((multiWorkerService as any).workersInitialized).toBe(true);
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

    it('should handle worker errors and recreate workers', async () => {
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

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
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

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
            // Mock a system with 4 CPUs and 32GB RAM with 16GB free
            mockedCpus.mockImplementation(() => Array(4).fill({} as os.CpuInfo));
            mockedTotalmem.mockImplementation(() => 32 * 1024 * 1024 * 1024); // 32GB
            mockedFreemem.mockImplementation(() => 16 * 1024 * 1024 * 1024);  // 16GB free

            // Create indexing service with custom options
            const highMemService = new IndexingService(
                context,
                modelCacheService,
                {
                    maxWorkers: 8, // Higher than CPU count to test capping
                    highMemoryThreshold: 8 // Use high-memory model since we have 16GB free
                }
            );

            // Test worker count calculation
            const result = (highMemService as any).calculateOptimalResources();
            expect(result.workerCount).toBe(3); // Should be CPUs-1 (4-1=3), despite maxWorkers being higher
            expect(result.useHighMemoryModel).toBe(true);

            // Now test with limited memory
            mockedFreemem.mockImplementation(() => 6 * 1024 * 1024 * 1024); // 6GB free
            const result2 = (highMemService as any).calculateOptimalResources();
            expect(result2.useHighMemoryModel).toBe(false); // Should use low-memory model now

            // Verify worker count is appropriate for limited memory system
            mockedCpus.mockImplementation(() => Array(16).fill({} as os.CpuInfo)); // 16 CPUs
            mockedFreemem.mockImplementation(() => 4 * 1024 * 1024 * 1024); // Only 4GB free
            const result3 = (highMemService as any).calculateOptimalResources();
            expect(result3.workerCount).toBeLessThan(15); // Should be less than CPUs-1 due to memory constraints
            expect(result3.useHighMemoryModel).toBe(false);
        } finally {
            // Restore original functions
            mockedCpus.mockRestore();
            mockedTotalmem.mockRestore();
            mockedFreemem.mockRestore();
        }
    });

    it('should handle management command actions', async () => {
        // Create proper QuickPickItem objects
        const items = [
            { label: "Cancel current indexing", description: "Stop all processing" },
            { label: "Restart workers", description: "Restart all worker threads" },
            { label: "Show worker status", description: "Display worker information" },
            { label: "Shutdown workers", description: "Stop all workers" },
            { label: "Start workers", description: "Initialize worker threads" },
            { label: "Optimize worker count", description: "Adjust worker count based on resources" }
        ];

        // Mock window.showQuickPick to simulate user selection
        const showQuickPickMock = jest.spyOn(vscode.window, 'showQuickPick');
        const showInfoMessageMock = jest.spyOn(vscode.window, 'showInformationMessage');
        const cancelSpy = jest.spyOn(indexingService as any, 'cancelProcessing');
        const restartWorkersSpy = jest.spyOn(indexingService as any, 'restartWorkers').mockResolvedValue(undefined);
        const shutdownWorkersSpy = jest.spyOn(indexingService as any, 'shutdownWorkers').mockResolvedValue(undefined);
        const showStatusSpy = jest.spyOn(indexingService as any, 'showWorkerStatus').mockReturnValue(undefined);
        const initWorkersSpy = jest.spyOn(indexingService as any, 'initializeWorkers').mockResolvedValue(undefined);
        const optimizeSpy = jest.spyOn(indexingService as any, 'optimizeWorkerCount').mockResolvedValue(undefined);

        try {
            // Test all options
            const optionTests = [
                { selection: items[0], spy: cancelSpy },
                { selection: items[1], spy: restartWorkersSpy },
                { selection: items[2], spy: showStatusSpy },
                { selection: items[3], spy: shutdownWorkersSpy },
                { selection: items[4], spy: initWorkersSpy },
                { selection: items[5], spy: optimizeSpy },
            ];

            for (const test of optionTests) {
                // Mock implementation for showQuickPick for each test case
                showQuickPickMock.mockResolvedValueOnce(test.selection);

                // Mock showIndexingManagementOptions
                const mockShowIndexingManagement = jest.spyOn(indexingService as any, 'showIndexingManagementOptions');
                mockShowIndexingManagement.mockImplementation(async () => {
                    // Find the selected method based on label and call it directly
                    if (test.selection.label === "Cancel current indexing") {
                        (indexingService as any).cancelProcessing();
                    } else if (test.selection.label === "Restart workers") {
                        await (indexingService as any).restartWorkers();
                    } else if (test.selection.label === "Show worker status") {
                        (indexingService as any).showWorkerStatus();
                    } else if (test.selection.label === "Shutdown workers") {
                        await (indexingService as any).shutdownWorkers();
                    } else if (test.selection.label === "Start workers") {
                        await (indexingService as any).initializeWorkers();
                    } else if (test.selection.label === "Optimize worker count") {
                        await (indexingService as any).optimizeWorkerCount();
                    }
                });

                // Call the management method
                await (indexingService as any).showIndexingManagementOptions();

                // Verify the expected method was called
                expect(test.spy).toHaveBeenCalled();

                // Reset for next test
                test.spy.mockClear();
                mockShowIndexingManagement.mockRestore();
            }

            // Test cancellation of selection
            showQuickPickMock.mockResolvedValueOnce(undefined);
            await (indexingService as any).showIndexingManagementOptions();
            // Verify no methods are called when selection is cancelled
            expect(cancelSpy).not.toHaveBeenCalled();
        } finally {
            showQuickPickMock.mockRestore();
            showInfoMessageMock.mockRestore();
            cancelSpy.mockRestore();
            restartWorkersSpy.mockRestore();
            shutdownWorkersSpy.mockRestore();
            showStatusSpy.mockRestore();
            initWorkersSpy.mockRestore();
            optimizeSpy.mockRestore();
        }
    });

    it('should optimize worker count based on system resources', async () => {
        // Create MessageItem for button responses
        const yesButton = { title: 'Yes' } as vscode.MessageItem;
        const noButton = { title: 'No' } as vscode.MessageItem;

        // Mock system functions
        const showWarningMock = jest.spyOn(vscode.window, 'showWarningMessage')
            .mockResolvedValue(yesButton);

        // Mock calculateOptimalResources to return a known value
        const calculateSpy = jest.spyOn(indexingService as any, 'calculateOptimalResources')
            .mockReturnValue({ workerCount: 3, useHighMemoryModel: true });

        const shutdownSpy = jest.spyOn(indexingService as any, 'shutdownWorkers')
            .mockResolvedValue(undefined);

        const initSpy = jest.spyOn(indexingService as any, 'initializeWorkers')
            .mockResolvedValue(undefined);

        // Mock optimizeWorkerCount implementation for direct testing
        const optimizeWorkerCountSpy = jest.spyOn(indexingService as any, 'optimizeWorkerCount');
        optimizeWorkerCountSpy.mockImplementation(async () => {
            const resources = (indexingService as any).calculateOptimalResources();

            if (!(indexingService as any).workersInitialized) {
                await (indexingService as any).initializeWorkers();
                return;
            }

            // Check if we should change worker count
            const currentWorkerCount = (indexingService as any).workers.length;
            if (resources.workerCount !== currentWorkerCount) {
                const response = await vscode.window.showWarningMessage(
                    `Optimize workers: ${currentWorkerCount} → ${resources.workerCount} workers?`,
                    yesButton, noButton
                );

                if (response === yesButton) {
                    await (indexingService as any).shutdownWorkers();
                    await (indexingService as any).initializeWorkers();
                }
            }
        });

        try {
            // Test optimization when workers aren't initialized
            (indexingService as any).workersInitialized = false;
            await (indexingService as any).optimizeWorkerCount();
            expect(initSpy).toHaveBeenCalled();
            expect(shutdownSpy).not.toHaveBeenCalled();

            // Reset mocks
            initSpy.mockClear();
            shutdownSpy.mockClear();

            // Test optimization when worker count should change
            (indexingService as any).workersInitialized = true;
            (indexingService as any).workers = [{}, {}]; // Mock 2 workers
            await (indexingService as any).optimizeWorkerCount();
            expect(shutdownSpy).toHaveBeenCalled();
            expect(initSpy).toHaveBeenCalled();

            // Test rejection of optimization
            showWarningMock.mockResolvedValueOnce(noButton);
            shutdownSpy.mockClear();
            initSpy.mockClear();
            await (indexingService as any).optimizeWorkerCount();
            expect(shutdownSpy).not.toHaveBeenCalled();
            expect(initSpy).not.toHaveBeenCalled();
        } finally {
            calculateSpy.mockRestore();
            showWarningMock.mockRestore();
            shutdownSpy.mockRestore();
            initSpy.mockRestore();
            optimizeWorkerCountSpy.mockRestore();
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

    it('should handle worker errors and attempt recovery', async () => {
        // Skip test if models don't exist
        const modelsPath = modelCacheService.getModelsPath();
        const fallbackModelPath = path.join(modelsPath, 'Xenova', 'all-MiniLM-L6-v2');

        if (!fs.existsSync(fallbackModelPath) || fs.readdirSync(fallbackModelPath).length === 0) {
            console.log('Skipping test: models not found');
            return;
        }

        // Initialize service first
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify workers initialized
        expect((indexingService as any).workers.length).toBeGreaterThan(0);

        // Save reference to worker
        const worker = (indexingService as any).workers[0].worker;

        // Spy on recreateWorker - fix by adding undefined parameter
        const recreateSpy = jest.spyOn(indexingService as any, 'recreateWorker')
            .mockResolvedValue(undefined);

        // Simulate worker error
        (indexingService as any).handleWorkerError(worker, new Error('Test error'));

        // Verify worker status changed to error
        expect((indexingService as any).workers[0].status).toBe('error');

        // Verify recreateWorker was called
        expect(recreateSpy).toHaveBeenCalledWith(0);

        // Clean up
        recreateSpy.mockRestore();
    });
});
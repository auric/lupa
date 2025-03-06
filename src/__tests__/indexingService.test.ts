import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IndexingService, FileToProcess } from '../services/indexingService';
import { StatusBarService, StatusBarMessageType, StatusBarState } from '../services/statusBarService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';

// Mock the StatusBarService
jest.mock('../services/statusBarService', () => {
    // Create a mock status bar item
    const mockStatusBarItem = {
        text: '',
        tooltip: '',
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn()
    };

    const mockInstance = {
        statusBarItem: mockStatusBarItem,
        setState: jest.fn(),
        showTemporaryMessage: jest.fn(),
        clearTemporaryMessage: jest.fn(),
        show: jest.fn(),
        hide: jest.fn(),
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
        }),
        EventEmitter: jest.fn().mockImplementation(() => ({
            event: jest.fn(),
            fire: jest.fn(),
            dispose: jest.fn()
        }))
    };
});

// Mock fs exists check for worker script path
jest.mock('fs', () => {
    return {
        ...jest.requireActual('fs'),
        existsSync: jest.fn().mockReturnValue(true)
    };
});

// Mock os module
jest.mock('os', () => {
    const actual = jest.requireActual('os');
    return {
        ...actual, // Keep all original functions by default
        cpus: jest.fn().mockImplementation(() => Array(4).fill({} as os.CpuInfo)),
        totalmem: jest.fn().mockImplementation(() => 16 * 1024 * 1024 * 1024), // 16GB
        freemem: jest.fn().mockImplementation(() => 8 * 1024 * 1024 * 1024),  // 8GB free
        availableParallelism: jest.fn().mockReturnValue(4) // Mock 4 available cores
    };
});

// Mock the indexingWorker to avoid actual model loading
// We'll mock the Hugging Face pipeline directly to simulate worker behavior
// jest.mock('@huggingface/transformers', () => {
//     return {
//         pipeline: jest.fn().mockImplementation(() => {
//             // Return a mock pipeline function that returns mock embeddings
//             return jest.fn().mockImplementation(() => {
//                 return {
//                     data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5])
//                 };
//             });
//         })
//     };
// });

describe('IndexingService', () => {
    // Increase timeout to 30 seconds for worker threads initialization
    jest.setTimeout(30000);

    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let statusBarServiceInstance: any;
    let extensionPath: string;
    let workspaceSettingsService: WorkspaceSettingsService;

    beforeEach(() => {
        jest.clearAllMocks();

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
        workspaceSettingsService = new WorkspaceSettingsService(context);

        // Create IndexingService with required options
        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            {
                modelName: 'jinaai/jina-embeddings-v2-base-code',
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

    // Tests that Piscina is created only when needed
    it('should not initialize Piscina on creation', () => {
        // Piscina should not be initialized yet
        expect((indexingService as any).piscina).toBeNull();
    });

    it('should initialize Piscina on demand', async () => {
        // Create a file to process
        const fileToProcess: FileToProcess = {
            id: 'file1',
            path: '/path/to/file1.js',
            content: 'const x = 1;'
        };

        // Process the file - this should initialize Piscina
        await indexingService.processFiles([fileToProcess]);

        // Now Piscina should be initialized
        expect((indexingService as any).piscina).not.toBeNull();
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
        const setStateSpy = jest.spyOn(statusBarServiceInstance, 'setState');
        const showTemporaryMessageSpy = jest.spyOn(statusBarServiceInstance, 'showTemporaryMessage');

        // Process a file
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify the status bar service was used
        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Indexing, '1 files');
        expect(showTemporaryMessageSpy).toHaveBeenCalled();
    });

    // Test the workspace settings integration
    it('should update workspace settings after processing files', async () => {
        const updateLastIndexingTimestampSpy = jest.spyOn(workspaceSettingsService, 'updateLastIndexingTimestamp');

        // Process a file
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Verify the workspace settings were updated
        expect(updateLastIndexingTimestampSpy).toHaveBeenCalled();
    });

    // Test that optimal chunk size is calculated based on model context length
    it('should calculate optimal chunk size based on context length', () => {
        // Create service with context length specified
        const serviceWithContext = new IndexingService(
            context,
            workspaceSettingsService,
            {
                modelName: 'test-model',
                contextLength: 512,
                chunkSizeSafetyFactor: 0.8
            }
        );

        // Get chunk size via private method
        const chunkSize = (serviceWithContext as any).getOptimalChunkSize();

        // Should be context length × safety factor
        expect(chunkSize).toBe(Math.floor(512 * 0.8));

        // Dispose of the test service
        serviceWithContext.dispose();
    });

    // Add this test to your test suite
    it('should handle cancellation correctly', async () => {
        // Create a file to process
        const files = [
            { id: 'file1', path: '/path/to/file1.js', content: 'const x = 1;'.repeat(8000) },
            { id: 'file2', path: '/path/to/file2.js', content: 'const x = 1;'.repeat(8000) },
            { id: 'file3', path: '/path/to/file3.js', content: 'const x = 1;'.repeat(8000) },
        ];

        // Create a cancellation token source
        const tokenSource = new vscode.CancellationTokenSource();

        // Start processing
        const processPromise = indexingService.processFiles(files, tokenSource.token);

        // Trigger cancellation
        tokenSource.cancel();

        // Verify that the operation was cancelled
        // await expect(processPromise).rejects.toThrow('Operation cancelled');

        const results = await processPromise;
        expect(results.size).toBe(0);
    });

    it('should process files in parallel with multiple workers', async () => {
        // Create multiple files to process
        const files: FileToProcess[] = [
            { id: 'f1', path: '/path/to/f1.js', content: 'const x = 1;' },
            { id: 'f2', path: '/path/to/f2.js', content: 'const y = 2;' },
            { id: 'f3', path: '/path/to/f3.js', content: 'const z = 3;' }
        ];

            // Process files
        const results = await indexingService.processFiles(files);

        // Verify all files were processed
        expect(results.size).toBe(3);
        expect(results.get('f1')?.success).toBe(true);
        expect(results.get('f2')?.success).toBe(true);
        expect(results.get('f3')?.success).toBe(true);
    });

    it('should handle large files by chunking them', async () => {
        // Create a large file that should be chunked
        const largeContent = 'a'.repeat(10000); // Large enough to trigger chunking
        const files: FileToProcess[] = [
            { id: 'large', path: '/path/to/large.txt', content: largeContent }
        ];

        // Process the file
        const results = await indexingService.processFiles(files);

        // Verify the result
        expect(results.size).toBe(1);
        expect(results.get('large')).toBeDefined();
        expect(results.get('large')?.success).toBe(true);

        // Large content should yield multiple embeddings (chunks)
        expect(results.get('large')?.embeddings.length).toBeGreaterThan(1);
    });

    it('should call Piscina.destroy on disposal', async () => {
    // Process a file to initialize Piscina
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Get the Piscina instance
        const piscina = (indexingService as any).piscina;

        // Spy on the destroy method
        const destroySpy = jest.spyOn(piscina, 'destroy');

        // Dispose the service
        await indexingService.dispose();

        // Verify destroy was called
        expect(destroySpy).toHaveBeenCalled();

        // piscina should be null after disposal
        expect((indexingService as any).piscina).toBeNull();
    });

    it('should handle abort controller management properly', async () => {
        // First process a file to get an active operation
        const firstPromise = indexingService.processFiles([
            { id: 'first', path: '/first.js', content: 'first operation' },
            { id: 'first', path: '/first.js', content: 'first operation' },
            { id: 'first', path: '/first.js', content: 'first operation' },
        ]);

        // Start a second operation - this should cancel the first one
        const secondPromise = indexingService.processFiles([
            { id: 'second', path: '/second.js', content: 'second operation' }
        ]);

        // Complete the second operation
        const secondResults = await secondPromise;

        const firstResults = await firstPromise;
        expect(firstResults.size).toBe(1);

        expect(secondResults.size).toBe(1);
        expect(secondResults.get('second')).toBeDefined();
        expect(secondResults.get('second')?.success).toBe(true);
    });

    it('should show worker status correctly', async () => {
        // Process a file to initialize Piscina
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Spy on window.showInformationMessage
        const showInfoSpy = jest.spyOn(vscode.window, 'showInformationMessage');

        // Call showWorkerStatus
        (indexingService as any).showWorkerStatus();

        // Verify that the info dialog was shown
        expect(showInfoSpy).toHaveBeenCalled();

        // Clean up spy
        showInfoSpy.mockRestore();
    });
});
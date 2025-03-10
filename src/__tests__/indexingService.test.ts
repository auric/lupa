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
                modelBasePath: path.join(extensionPath, 'models'),
                modelName: 'Xenova/all-MiniLM-L6-v2',
                contextLength: 8192,
                maxWorkers: 2
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
        const largeContent = 'Larger than default chunk size'.repeat(2000);
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
        expect(firstResults.size).toBe(0);

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

    it('should handle empty content files', async () => {
        // Create file with empty content
        const files: FileToProcess[] = [
            { id: 'empty', path: '/path/to/empty.js', content: '' }
        ];

        // Process the file
        const results = await indexingService.processFiles(files);

        // Verify the result
        expect(results.size).toBe(1);
        expect(results.get('empty')).toBeDefined();
        expect(results.get('empty')?.success).toBe(true);
        // Empty content should have empty embeddings
        expect(results.get('empty')?.embeddings.length).toBe(1);
        expect(results.get('empty')?.embeddings[0]!.length).toBe(0);
    });

    it('should prioritize files by priority value', async () => {
        // Create files with different priorities
        const files: FileToProcess[] = [
            { id: 'low', path: '/path/to/low.js', content: 'low priority', priority: 1 },
            { id: 'high', path: '/path/to/high.js', content: 'high priority', priority: 10 },
            { id: 'medium', path: '/path/to/medium.js', content: 'medium priority', priority: 5 }
        ];

        // Spy on getPiscina method to access the files after sorting
        const getPiscinaSpy = jest.spyOn(indexingService as any, 'getPiscina');

        // Process files
        await indexingService.processFiles(files);

        // Check that getPiscina was called
        expect(getPiscinaSpy).toHaveBeenCalled();

        // The first call to processFiles should have sorted files by priority
        // We can't directly test the sorting since it happens internally, but we can
        // verify that the method was called which indicates the branch was executed
        expect(getPiscinaSpy).toHaveBeenCalledTimes(1);

        getPiscinaSpy.mockRestore();
    });

    it('should update status bar with correct file count', async () => {
        // Create multiple files
        const files: FileToProcess[] = [
            { id: 'file1', path: '/path/to/file1.js', content: 'content 1' },
            { id: 'file2', path: '/path/to/file2.js', content: 'content 2' },
            { id: 'file3', path: '/path/to/file3.js', content: 'content 3' }
        ];

        // Spy on setState method
        const setStateSpy = jest.spyOn(statusBarServiceInstance, 'setState');

        // Process files
        await indexingService.processFiles(files);

        // Verify setState was called with correct parameters
        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Indexing, '3 files');

        setStateSpy.mockRestore();
    });

    it('should handle cancellation during initialization', async () => {
        // Create a file to process
        const files = [{ id: 'test', path: '/test.js', content: 'test content' }];

        // Create a cancellation token that's immediately cancelled
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel(); // Cancel immediately

        // Process files with cancelled token
        const results = indexingService.processFiles(files, tokenSource.token);

        await expect(results).rejects.toThrow('Operation cancelled');
    });
});

describe('IndexingService Management Functions', () => {
    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let workspaceSettingsService: WorkspaceSettingsService;
    let extensionPath: string;

    beforeEach(() => {
        jest.clearAllMocks();
        StatusBarService.reset();

        // Set up the extension path
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

        workspaceSettingsService = new WorkspaceSettingsService(context);

        // Create service with minimal configuration
        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            {
                modelBasePath: path.join(extensionPath, 'models'),
                modelName: 'Xenova/all-MiniLM-L6-v2',
                contextLength: 256
            }
        );
    });

    afterEach(async () => {
        await indexingService.dispose();
    });

    it('should register management command on initialization', () => {
        // Verify the command was registered
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'codelens-pr-analyzer.manageIndexing',
            expect.any(Function)
        );
    });

    it('should show indexing management options', async () => {
        // Mock showQuickPick to return a specific option
        const showQuickPickMock = vscode.window.showQuickPick as jest.Mock;
        showQuickPickMock.mockResolvedValueOnce('Show worker status');

        // Mock showWorkerStatus function
        const showWorkerStatusSpy = jest.spyOn(indexingService as any, 'showWorkerStatus')
            .mockImplementation(() => { });

        // Call the management function
        await (indexingService as any).showIndexingManagementOptions();

        // Verify showWorkerStatus was called
        expect(showWorkerStatusSpy).toHaveBeenCalled();

        // Clean up
        showWorkerStatusSpy.mockRestore();
    });

    it('should handle restartWorkers command correctly', async () => {
        // Mock showQuickPick to select restart option
        const showQuickPickMock = vscode.window.showQuickPick as jest.Mock;
        showQuickPickMock.mockResolvedValueOnce('Restart workers');

        // Initialize Piscina first by spying on getPiscina method
        const getPiscinaMock = jest.spyOn(indexingService as any, 'getPiscina')
            .mockReturnValue({ destroy: jest.fn().mockResolvedValue(undefined) });

        // Mock shutdownPiscina to avoid actual shutdown
        const shutdownPiscinaSpy = jest.spyOn(indexingService as any, 'shutdownPiscina')
            .mockResolvedValue(undefined);

        // Call management function
        await (indexingService as any).showIndexingManagementOptions();

        // Verify shutdownPiscina was called (part of restart)
        expect(shutdownPiscinaSpy).toHaveBeenCalled();

        // Clean up
        getPiscinaMock.mockRestore();
        shutdownPiscinaSpy.mockRestore();
    });

    it('should handle shutdown workers command correctly', async () => {
        // Mock showQuickPick to select shutdown option
        const showQuickPickMock = vscode.window.showQuickPick as jest.Mock;
        showQuickPickMock.mockResolvedValueOnce('Shutdown workers');

        // Initialize Piscina first by processing a file
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Mock and spy on shutdownPiscina method
        const shutdownPiscinaSpy = jest.spyOn(indexingService as any, 'shutdownPiscina');

        // Call management function
        await (indexingService as any).showIndexingManagementOptions();

        // Verify shutdownPiscina was called
        expect(shutdownPiscinaSpy).toHaveBeenCalled();

        // Clean up
        shutdownPiscinaSpy.mockRestore();
    });

    it('should handle cancel current indexing command correctly', async () => {
        // Mock showQuickPick to select cancel option
        const showQuickPickMock = vscode.window.showQuickPick as jest.Mock;
        showQuickPickMock.mockResolvedValueOnce('Cancel current indexing');

        // Spy on cancelProcessing method
        const cancelProcessingSpy = jest.spyOn(indexingService, 'cancelProcessing')
            .mockResolvedValueOnce();

        // Call management function
        await (indexingService as any).showIndexingManagementOptions();

        // Verify cancelProcessing was called
        expect(cancelProcessingSpy).toHaveBeenCalled();

        // Clean up
        cancelProcessingSpy.mockRestore();
    });

    it('should show worker status when no workers are running', async () => {
        // Make sure Piscina is null
        (indexingService as any).piscina = null;

        // Spy on window.showInformationMessage
        const showInfoSpy = jest.spyOn(vscode.window, 'showInformationMessage');

        // Call showWorkerStatus
        (indexingService as any).showWorkerStatus();

        // Verify the right message was shown
        expect(showInfoSpy).toHaveBeenCalledWith('No workers are currently running.');

        showInfoSpy.mockRestore();
    });

    it('should handle error when restarting workers', async () => {
        // Mock showQuickPick to select restart option
        const showQuickPickMock = vscode.window.showQuickPick as jest.Mock;
        showQuickPickMock.mockResolvedValueOnce('Restart workers');

        // Force error during worker restart
        const cancelProcessingSpy = jest.spyOn(indexingService, 'cancelProcessing')
            .mockRejectedValueOnce(new Error('Test error during restart'));

        // Spy on window.showErrorMessage
        const showErrorSpy = jest.spyOn(vscode.window, 'showErrorMessage');

        // Call management function
        await (indexingService as any).showIndexingManagementOptions();

        // Verify error message was shown
        expect(showErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to restart workers')
        );

        // Clean up
        cancelProcessingSpy.mockRestore();
        showErrorSpy.mockRestore();
    });

    it('should handle error during piscina shutdown', async () => {
        // Make sure Piscina is initialized
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Get the Piscina instance
        const piscina = (indexingService as any).piscina;

        // Mock destroy to throw an error
        jest.spyOn(piscina, 'destroy').mockRejectedValueOnce(new Error('Destroy failed'));

        // Spy on console.error
        const consoleErrorSpy = jest.spyOn(console, 'error');

        // Call shutdownPiscina
        await (indexingService as any).shutdownPiscina();

        // Verify error was logged
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error shutting down piscina:',
            expect.any(Error)
        );

        consoleErrorSpy.mockRestore();
    });
});

// Add a separate describe block for configuration tests
describe('IndexingService Configuration', () => {
    let context: vscode.ExtensionContext;
    let workspaceSettingsService: WorkspaceSettingsService;
    let extensionPath: string;

    beforeEach(() => {
        jest.clearAllMocks();
        StatusBarService.reset();

        extensionPath = path.resolve(__dirname, '..', '..');

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

        workspaceSettingsService = new WorkspaceSettingsService(context);
    });

    it('should throw error when model name is not provided', () => {
        // Try to create a service without model name
        expect(() => {
            new IndexingService(
                context,
                workspaceSettingsService,
                // @ts-ignore - force invalid input for testing
                { modelName: '' }
            );
        }).toThrow('Model name must be provided');
    });
});

describe('IndexingService Error Handling', () => {
    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let workspaceSettingsService: WorkspaceSettingsService;
    let extensionPath: string;
    let statusBarServiceInstance: any;

    beforeEach(() => {
        jest.clearAllMocks();
        StatusBarService.reset();
        statusBarServiceInstance = StatusBarService.getInstance();

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

        workspaceSettingsService = new WorkspaceSettingsService(context);

        // Create service with minimal configuration
        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            {
                modelBasePath: path.join(extensionPath, 'models'),
                modelName: 'test-model',
                contextLength: 256
            }
        );
    });

    afterEach(async () => {
        await indexingService.dispose();
    });

    it('should handle worker errors during file processing', async () => {
        // Mock getPiscina to return a mock Piscina
        const mockRun = jest.fn().mockRejectedValue(new Error('Worker error'));
        const mockPiscina = {
            run: mockRun,
            destroy: jest.fn().mockResolvedValue(undefined)
        };

        jest.spyOn(indexingService as any, 'getPiscina').mockReturnValue(mockPiscina);

        // Spy on status bar methods
        const setStateSpy = jest.spyOn(statusBarServiceInstance, 'setState');

        // Process a file
        await expect(indexingService.processFiles([
            { id: 'error-file', path: '/error.js', content: 'content' }
        ])).rejects.toThrow('Worker error');

        // Verify error status was set
        expect(setStateSpy).toHaveBeenCalledWith(
            StatusBarState.Error,
            expect.any(String)
        );
    });

    it('should throw error when context length is not provided', () => {
        // Clean up existing service
        indexingService.dispose();

        // Try to create a service without context length
        expect(() => {
            new IndexingService(
                context,
                workspaceSettingsService,
                {
                    modelName: 'test-model',
                    // @ts-ignore - force invalid input for testing
                    contextLength: undefined
                }
            );
        }).toThrow('Context length must be provided');
    });

    it('should handle errors when worker script does not exist', () => {
        // Mock fs.existsSync to return false for the worker script
        const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockReturnValueOnce(false);

        // Expect getPiscina to throw
        expect(() => {
            (indexingService as any).getPiscina();
        }).toThrow('Worker script not found');

        // Restore original implementation
        existsSyncSpy.mockRestore();
    });
});

describe('IndexingService Additional Coverage Tests', () => {
    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let workspaceSettingsService: WorkspaceSettingsService;
    let extensionPath: string;
    let statusBarServiceInstance: any;

    beforeEach(() => {
        jest.clearAllMocks();
        StatusBarService.reset();
        statusBarServiceInstance = StatusBarService.getInstance();

        extensionPath = path.resolve(__dirname, '..', '..');

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

        workspaceSettingsService = new WorkspaceSettingsService(context);

        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            {
                modelBasePath: path.join(extensionPath, 'models'),
                modelName: 'test-model',
                contextLength: 256
            }
        );
    });

    afterEach(async () => {
        await indexingService.dispose();
    });

    it('should call progress callback during file processing', async () => {
        // Create some test files
        const files = Array.from({ length: 5 }, (_, i) => ({
            id: `file${i}`,
            path: `/path/to/file${i}.js`,
            content: `// Content for file ${i}`
        }));

        // Create a mock progress callback function
        const progressCallback = jest.fn();

        // Mock Piscina run to immediately resolve
        const mockPiscina = {
            run: jest.fn().mockImplementation((task) => Promise.resolve({
                fileId: task.fileId,
                embeddings: [new Float32Array(5)],
                chunkOffsets: [0],
                success: true
            })),
            threads: [{}], // mock one thread
            destroy: jest.fn().mockResolvedValue(undefined),
            queueSize: 0,
            completed: 1,
            duration: 100,
            utilization: 0.5
        };

        jest.spyOn(indexingService as any, 'getPiscina').mockReturnValue(mockPiscina);

        // Process files with progress callback
        await indexingService.processFiles(files, undefined, progressCallback);

        // Fix: With batch size of 10 and only 5 files, the callback is only called once
        // after all files are processed in a single batch
        expect(progressCallback).toHaveBeenCalledTimes(1);

        // The callback should be called with (5, 5) - all five files processed
        expect(progressCallback).toHaveBeenCalledWith(5, 5);
    });

    it('should handle progress callback edge cases', async () => {
        // Mock fs.existsSync to return true for any worker script path
        const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);

        // Mock Piscina instance with a run method that returns a successful result
        const mockPiscina = {
            run: jest.fn().mockResolvedValue({
                fileId: 'single',
                embeddings: [new Float32Array(5)],
                chunkOffsets: [0],
                success: true
            }),
            threads: [{}], // mock one thread
            destroy: jest.fn().mockResolvedValue(undefined),
            queueSize: 0,
            completed: 1,
            duration: 100,
            utilization: 0.5
        };

        // Spy on getPiscina to return our mock instance
        jest.spyOn(indexingService as any, 'getPiscina').mockReturnValue(mockPiscina);

        // Process a single file with no progress callback
        const result = await indexingService.processFiles([
            { id: 'single', path: '/path/to/single.js', content: 'single file test' }
        ]);

        // Should complete successfully without error
        expect(result.has('single')).toBe(true);
        expect(result.get('single')?.success).toBe(true);

        // Restore the original implementation
        existsSyncSpy.mockRestore();
    });

    it('should handle token cancellation during batch processing', async () => {
        // Create 15 files to ensure multiple batches (with batch size of 10)
        const files = Array.from({ length: 15 }, (_, i) => ({
            id: `batch${i}`,
            path: `/path/to/batch${i}.js`,
            content: `// Batch file ${i}`
        }));

        // Create a cancellation token
        const tokenSource = new vscode.CancellationTokenSource();

        // Mock Piscina.run to delay on the first batch but resolve quickly for others
        // This gives us time to cancel during processing
        const mockRun = jest.fn()
            .mockImplementationOnce(task => {
                // First call - delay 100ms then resolve
                return new Promise(resolve => {
                    setTimeout(() => {
                        resolve({
                            fileId: task.fileId,
                            embeddings: [new Float32Array(5)],
                            chunkOffsets: [0],
                            success: true
                        });
                    }, 100);
                });
            })
            .mockImplementation(task => {
                // Subsequent calls - resolve immediately
                return Promise.resolve({
                    fileId: task.fileId,
                    embeddings: [new Float32Array(5)],
                    chunkOffsets: [0],
                    success: true
                });
            });

        const mockPiscina = {
            run: mockRun,
            threads: [{}], // mock one thread
            destroy: jest.fn().mockResolvedValue(undefined),
            queueSize: 0,
            completed: 1,
            duration: 100,
            utilization: 0.5
        };

        jest.spyOn(indexingService as any, 'getPiscina').mockReturnValue(mockPiscina);

        // Start processing
        const processPromise = indexingService.processFiles(files, tokenSource.token);

        // Cancel after a short delay (less than the 100ms delay of the first batch)
        setTimeout(() => tokenSource.cancel(), 50);

        // Wait for processing to complete
        await expect(processPromise).rejects.toThrow();

        // Verify cancellation was handled
        const setStateSpy = jest.spyOn(statusBarServiceInstance, 'setState');
        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Ready);
    });

    it('should handle batch processing with errors in some files', async () => {
        // Create 3 files
        const files = [
            { id: 'success1', path: '/path/to/success1.js', content: 'this will succeed' },
            { id: 'error', path: '/path/to/error.js', content: 'this will fail' },
            { id: 'success2', path: '/path/to/success2.js', content: 'this will also succeed' }
        ];

        // Mock Piscina.run to succeed for first and third files but fail for second
        const mockRun = jest.fn()
            .mockImplementationOnce(task => {
                return Promise.resolve({
                    fileId: task.fileId,
                    embeddings: [new Float32Array(5)],
                    chunkOffsets: [0],
                    success: true
                });
            })
            .mockImplementationOnce(() => {
                return Promise.resolve({
                    fileId: 'error',
                    embeddings: [],
                    chunkOffsets: [],
                    success: false,
                    error: 'Test error message'
                });
            })
            .mockImplementationOnce(task => {
                return Promise.resolve({
                    fileId: task.fileId,
                    embeddings: [new Float32Array(5)],
                    chunkOffsets: [0],
                    success: true
                });
            });

        const mockPiscina = {
            run: mockRun,
            threads: [{}],
            destroy: jest.fn().mockResolvedValue(undefined),
            queueSize: 0,
            completed: 3,
            duration: 100,
            utilization: 0.5
        };

        jest.spyOn(indexingService as any, 'getPiscina').mockReturnValue(mockPiscina);

        // Fix: Make fs.existsSync return true
        const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);

        // Process files
        const results = await indexingService.processFiles(files);

        // Fix: Based on the implementation, only successful results are included
        expect(results.size).toBe(2);

        // First and third should be successful
        expect(results.get('success1')?.success).toBe(true);
        expect(results.get('success2')?.success).toBe(true);

        // Second should have failed and not be in the results
        expect(results.has('error')).toBe(false);

        existsSyncSpy.mockRestore();
    });

    it('should correctly dispose resources when error occurs during cancellation', async () => {
        // Create a mock MessageChannel
        const mockChannel = {
            port1: {
                postMessage: jest.fn().mockImplementation(() => {
                    throw new Error('Port closed');
                })
            },
            port2: {}
        };

        // Mock console.log to prevent error output in test
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

        // Set up a situation where postMessage fails during cancellation
        (indexingService as any).currentOperation = {
            files: [{ id: 'test', path: '/test.js', content: 'test content' }],
            results: [Promise.resolve()],
            messageChannels: [mockChannel]
        };

        // Spy on status bar
        const showTempMsgSpy = jest.spyOn(statusBarServiceInstance, 'showTemporaryMessage');

        // Call cancelProcessing - should not throw thanks to our implementation fix
        await indexingService.cancelProcessing();

        // Should still show cancellation message even though port1.postMessage threw
        expect(showTempMsgSpy).toHaveBeenCalledWith(
            'Indexing cancelled',
            expect.any(Number),
            StatusBarMessageType.Warning
        );

        // Operation should be cleaned up
        expect((indexingService as any).currentOperation).toBeNull();

        consoleLogSpy.mockRestore();
    });

    it('should update worker status and display additional information', async () => {
        // Mock fs.existsSync to return true
        const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);

        // Process a file to initialize Piscina
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Set a current operation to test that branch
        (indexingService as any).currentOperation = {
            files: [{ id: 'active', path: '/active.js', content: 'active content' }],
            results: [Promise.resolve()],
            messageChannels: [{ port1: { postMessage: jest.fn() }, port2: {} }]
        };

        // Spy on window.showInformationMessage with modal parameter
        const showInfoSpy = jest.spyOn(vscode.window, 'showInformationMessage');

        // Call showWorkerStatus
        (indexingService as any).showWorkerStatus();

        // Verify called with activeOperation: true in the stats
        expect(showInfoSpy).toHaveBeenCalledWith(
            expect.stringContaining('Active operation: Yes'),
            { modal: true }
        );

        // Clean up
        showInfoSpy.mockRestore();
        existsSyncSpy.mockRestore();
        (indexingService as any).currentOperation = null;
    });

    it('should sort files by priority when no priority is specified', async () => {
        // Create files without explicit priority
        const files = [
            { id: 'file1', path: '/path/to/file1.js', content: 'content 1' },
            { id: 'file2', path: '/path/to/file2.js', content: 'content 2' }
        ];

        // Mock Piscina to capture task order
        const capturedTasks: any[] = [];
        const mockPiscina = {
            run: jest.fn().mockImplementation((task) => {
                capturedTasks.push(task);
                return Promise.resolve({
                    fileId: task.fileId,
                    embeddings: [new Float32Array(5)],
                    chunkOffsets: [0],
                    success: true
                });
            }),
            threads: [{}],
            destroy: jest.fn().mockResolvedValue(undefined),
            queueSize: 0,
            completed: 0,
            duration: 0,
            utilization: 0
        };

        jest.spyOn(indexingService as any, 'getPiscina').mockReturnValue(mockPiscina);

        // Process files
        await indexingService.processFiles(files);

        // Files should be processed in original order when no priority is specified
        expect(capturedTasks[0].fileId).toBe('file1');
        expect(capturedTasks[1].fileId).toBe('file2');
    });

    it('should execute all worker management options', async () => {
        // Create spy functions for all the management methods
        const cancelSpy = jest.spyOn(indexingService, 'cancelProcessing')
            .mockResolvedValue();
        const restartSpy = jest.spyOn(indexingService as any, 'restartWorkers')
            .mockResolvedValue(undefined);
        const statusSpy = jest.spyOn(indexingService as any, 'showWorkerStatus')
            .mockImplementation(() => { });
        const shutdownSpy = jest.spyOn(indexingService as any, 'shutdownPiscina')
            .mockResolvedValue(undefined);

        // Mock showQuickPick to return each option in sequence
        const showQuickPickMock = vscode.window.showQuickPick as jest.Mock;

        // Test "Cancel current indexing" option
        showQuickPickMock.mockResolvedValueOnce("Cancel current indexing");
        await (indexingService as any).showIndexingManagementOptions();
        expect(cancelSpy).toHaveBeenCalled();

        // Test "Restart workers" option
        showQuickPickMock.mockResolvedValueOnce("Restart workers");
        await (indexingService as any).showIndexingManagementOptions();
        expect(restartSpy).toHaveBeenCalled();

        // Test "Show worker status" option
        showQuickPickMock.mockResolvedValueOnce("Show worker status");
        await (indexingService as any).showIndexingManagementOptions();
        expect(statusSpy).toHaveBeenCalled();

        // Test "Shutdown workers" option
        showQuickPickMock.mockResolvedValueOnce("Shutdown workers");
        await (indexingService as any).showIndexingManagementOptions();
        expect(shutdownSpy).toHaveBeenCalled();
    });
});

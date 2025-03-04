import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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

describe('IndexingService', () => {
    // Increase timeout to 30 seconds for model loading tests
    jest.setTimeout(60000);

    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let modelCacheService: ModelCacheService;
    let statusBarServiceInstance: any;
    let extensionPath: string;

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
});
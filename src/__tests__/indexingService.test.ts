import { vi, describe, it, beforeEach, afterEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { IndexingService } from '../services/indexingService';
import { FileToProcess } from '../workers/asyncIndexingProcessor'
import { StatusBarService, StatusBarState } from '../services/statusBarService';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { TreeStructureAnalyzerPool } from '../services/treeStructureAnalyzer';

const mockStatusBarItem = {
    text: '',
    tooltip: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
};

// Create the mock instance OUTSIDE the vi.mock call
const mockStatusBarInstance = {
    statusBarItem: mockStatusBarItem,
    setState: vi.fn(),
    showTemporaryMessage: vi.fn(),
    clearTemporaryMessage: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
};

// Mock the StatusBarService module
vi.mock('../services/statusBarService', () => {
    return {
        StatusBarService: {
            getInstance: vi.fn(() => mockStatusBarInstance),
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

// Then update the mock to return our persistent instance
vi.mock('../services/workspaceSettingsService', () => {
    return {
        WorkspaceSettingsService: vi.fn().mockImplementation(() => mockWorkspaceSettingsInstance)
    };
});

// Mock vscode module
vi.mock('vscode');

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
        ...actual, // Keep all original functions by default
        cpus: vi.fn(() => {
            // Create a proper array of 4 items that won't be undefined
            return [
                { model: 'Test CPU', speed: 2400 },
                { model: 'Test CPU', speed: 2400 },
                { model: 'Test CPU', speed: 2400 },
                { model: 'Test CPU', speed: 2400 }
            ];
        }),
        totalmem: vi.fn().mockImplementation(() => 16 * 1024 * 1024 * 1024), // 16GB
        freemem: vi.fn().mockImplementation(() => 8 * 1024 * 1024 * 1024),  // 8GB free
        availableParallelism: vi.fn().mockReturnValue(4) // Mock 4 available cores
    };
});

describe('IndexingService', () => {
    // Increase timeout to 30 seconds for worker threads initialization
    vi.setConfig({ testTimeout: 30000 });

    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let statusBarServiceInstance: any;
    let extensionPath: string;
    let workspaceSettingsService: WorkspaceSettingsService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Reset StatusBarService instance
        StatusBarService.reset();
        statusBarServiceInstance = StatusBarService.getInstance();
        expect(statusBarServiceInstance).toBeDefined();
        expect(statusBarServiceInstance.showTemporaryMessage).toBeDefined();

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

        const maxConcurrentTasks = 2;
        TreeStructureAnalyzerPool.createSingleton(context.extensionPath, maxConcurrentTasks);

        // Create service instances
        workspaceSettingsService = mockWorkspaceSettingsInstance as unknown as WorkspaceSettingsService;

        // Create IndexingService with required options
        indexingService = new IndexingService(
            context,
            workspaceSettingsService,
            {
                modelBasePath: path.join(extensionPath, 'models'),
                modelName: 'Xenova/all-MiniLM-L6-v2',
                contextLength: 256,
                maxConcurrentTasks: maxConcurrentTasks
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
        const setStateSpy = vi.spyOn(statusBarServiceInstance, 'setState');
        const showTemporaryMessageSpy = vi.spyOn(statusBarServiceInstance, 'showTemporaryMessage');

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
        const updateLastIndexingTimestampSpy = vi.spyOn(workspaceSettingsService, 'updateLastIndexingTimestamp');

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

        await expect(processPromise).rejects.toThrow('Operation was cancelled');
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

    it('should call cancelProcessing on disposal', async () => {
        // Process a file to initialize Piscina
        await indexingService.processFiles([
            { id: 'test', path: '/test.js', content: 'test content' }
        ]);

        // Spy on the destroy method
        const destroySpy = vi.spyOn((indexingService as any), 'cancelProcessing');

        // Dispose the service
        await indexingService.dispose();

        // Verify destroy was called
        expect(destroySpy).toHaveBeenCalled();
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

        await expect(firstPromise).rejects.toThrow('Operation was cancelled');

        // Complete the second operation
        const secondResults = await secondPromise;

        expect(secondResults.size).toBe(1);
        expect(secondResults.get('second')).toBeDefined();
        expect(secondResults.get('second')?.success).toBe(true);
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

    it('should update status bar with correct file count', async () => {
        // Create multiple files
        const files: FileToProcess[] = [
            { id: 'file1', path: '/path/to/file1.js', content: 'content 1' },
            { id: 'file2', path: '/path/to/file2.js', content: 'content 2' },
            { id: 'file3', path: '/path/to/file3.js', content: 'content 3' }
        ];

        // Spy on setState method
        const setStateSpy = vi.spyOn(statusBarServiceInstance, 'setState');

        // Process files
        await indexingService.processFiles(files);

        // Verify setState was called with correct parameters
        expect(setStateSpy).toHaveBeenCalledWith(StatusBarState.Indexing, '3 files');

        setStateSpy.mockRestore();
    });
});

describe('IndexingService Management Functions', () => {
    let context: vscode.ExtensionContext;
    let indexingService: IndexingService;
    let workspaceSettingsService: WorkspaceSettingsService;
    let extensionPath: string;

    beforeEach(() => {
        vi.clearAllMocks();
        StatusBarService.reset();

        // Set up the extension path
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

    it('should handle cancel current indexing command correctly', async () => {
        // Mock showQuickPick to select cancel option
        const showQuickPickMock = vscode.window.showQuickPick as Mock;
        showQuickPickMock.mockResolvedValueOnce('Cancel current indexing');

        // Spy on cancelProcessing method
        const cancelProcessingSpy = vi.spyOn(indexingService, 'cancelProcessing')
            .mockResolvedValueOnce();

        // Call management function
        await (indexingService as any).showIndexingManagementOptions();

        // Verify cancelProcessing was called
        expect(cancelProcessingSpy).toHaveBeenCalled();

        // Clean up
        cancelProcessingSpy.mockRestore();
    });
});

// Add a separate describe block for configuration tests
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
        vi.clearAllMocks();
        StatusBarService.reset();
        statusBarServiceInstance = StatusBarService.getInstance();

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
});

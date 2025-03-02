import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Create proper type for mocked fs functions
type MockedFS = {
    [K in keyof typeof fs]: jest.Mock;
};

// --- Mock dynamic import is now handled in jest.setup.js ---

// Mock transformers
jest.mock('@xenova/transformers', () => ({
    pipeline: jest.fn().mockImplementation(() => {
        return async (text: string, options: any) => {
            return { data: new Float32Array([0.1, 0.2, 0.3]) };
        };
    }),
    env: {
        cacheDir: ''
    }
}));

// Mock fs with proper types
jest.mock('fs', () => {
    const mockFs = {
        existsSync: jest.fn().mockReturnValue(true),
        mkdirSync: jest.fn(),
        readdirSync: jest.fn().mockReturnValue([]),
        unlinkSync: jest.fn(),
        statSync: jest.fn().mockReturnValue({
            isDirectory: () => false,
            size: 1024
        })
    };
    return mockFs;
});

// Create mock Dirent objects (for tests that expect readdirSync to return strings, we use an array of strings)
const createMockDirent = (name: string, isDir: boolean = false): fs.Dirent => ({
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false
} as fs.Dirent);

// Create a simple mock of vscode without trying to reference the original
jest.mock('vscode', () => {
    const mockStatusBarItem = {
        text: '',
        tooltip: '',
        command: '',
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn()
    };

    // Create a simple uri implementation
    const mockUri = {
        file: jest.fn((path: string) => ({
            fsPath: path,
            toString: () => path
        })),
        joinPath: jest.fn((base, ...segments) => {
            // Handle both string and object base paths
            const basePath = typeof base === 'string' ? base : (base.fsPath || '');
            // Only join if basePath is not empty
            if (!basePath) {
                return {
                    fsPath: null,
                    toString: () => 'null'
                };
            }
            const joined = segments.reduce((acc, segment) =>
                path.join(acc, segment), basePath);
            return {
                fsPath: joined,
                toString: () => joined
            };
        })
    };

    return {
        StatusBarAlignment: {
            Left: 1,
            Right: 2
        },
        window: {
            createStatusBarItem: jest.fn().mockReturnValue(mockStatusBarItem),
            showInformationMessage: jest.fn(),
            showWarningMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            setStatusBarMessage: jest.fn(),
            showQuickPick: jest.fn().mockResolvedValue(null)
        },
        commands: {
            registerCommand: jest.fn()
        },
        workspace: {
            name: 'test-workspace'
        },
        Uri: mockUri,
        // Export the status bar item for test access
        _mockStatusBarItem: mockStatusBarItem
    };
});

import { CodeEmbeddingService } from '../services/codeEmbeddingService';
const mockStatusBarItem = (vscode as any)._mockStatusBarItem;

describe('CodeEmbeddingService', () => {
    let context: vscode.ExtensionContext;
    let service: CodeEmbeddingService;
    let mockedFS: MockedFS;

    beforeEach(() => {
        jest.clearAllMocks();

        // Cast fs mocks to our type
        mockedFS = fs as unknown as MockedFS;

        // For most tests, existsSync returns true.
        mockedFS.existsSync.mockReturnValue(true);
        // Default readdirSync returns an array (simulate directory with one file)
        mockedFS.readdirSync.mockReturnValue([createMockDirent('file1.json')]);
        mockedFS.statSync.mockReturnValue({
            isDirectory: () => false,
            size: 1024
        } as fs.Stats);

        context = {
            globalStorageUri: vscode.Uri.file('/tmp/global'),
            storageUri: vscode.Uri.file('/tmp/workspace'),
            workspaceState: {
                update: jest.fn(),
                get: jest.fn()
            },
            subscriptions: [],
            asAbsolutePath: (relativePath: string) => path.join('/ext', relativePath)
        } as unknown as vscode.ExtensionContext;

        service = new CodeEmbeddingService(context);
    });

    it('should initialize the model', async () => {
        await service.initializeModel();
        expect(service.isModelReady()).toBe(true);
    });

    it('should generate embeddings', async () => {
        await service.initializeModel();
        const embedding = await service.generateEmbedding('test code');
        expect(embedding).toEqual(new Float32Array([0.1, 0.2, 0.3]));
    });

    it('should handle model initialization failure and fallback', async () => {
        // Set the global flag to make the primary model fail
        (global as any).__testPrimaryModelFailure = true;

        // Create a new service instance that will use our failing mock
        const serviceWithFailure = new CodeEmbeddingService(context);

        try {
            await serviceWithFailure.initializeModel();
            expect(serviceWithFailure.getCurrentModelName()).toBe('Xenova/all-MiniLM-L6-v2');
        } finally {
            // Reset the flag for other tests
            (global as any).__testPrimaryModelFailure = false;
        }
    });

    it('should clear cache', async () => {
        // For clearCache test, simulate readdirSync returning an array of filenames (strings)
        const mockFiles = ['file1', 'file2'];
        mockedFS.readdirSync.mockReturnValue(mockFiles as any);  // cast to any to satisfy Dirent[] type
        const unlinkSyncSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { });
        const readdirSyncSpy = jest.spyOn(fs, 'readdirSync').mockReturnValue(mockFiles as any);

        await service.clearCache('/tmp/cache');
        expect(unlinkSyncSpy).toHaveBeenCalledTimes(2);
        expect(unlinkSyncSpy).toHaveBeenCalledWith(path.join('/tmp/cache', 'file1'));
        expect(unlinkSyncSpy).toHaveBeenCalledWith(path.join('/tmp/cache', 'file2'));
        expect(readdirSyncSpy).toHaveBeenCalledWith('/tmp/cache');
    });

    describe('cache management', () => {
        it('should create cache directories on initialization', () => {
            // For this test, simulate that primary and fallback directories do not exist:
            mockedFS.existsSync.mockImplementation((p: string) => {
                if (p.includes('primary') || p.includes('fallback')) {
                    return false;
                }
                return true;
            });
            // Re-run initCachePaths to force mkdirSync calls
            (service as any).initCachePaths();
            expect(mockedFS.mkdirSync).toHaveBeenCalledWith(
                expect.stringContaining('primary'),
                expect.any(Object)
            );
            expect(mockedFS.mkdirSync).toHaveBeenCalledWith(
                expect.stringContaining('fallback'),
                expect.any(Object)
            );
        });

        it('should update status bar based on cache state', () => {
            // For updateCacheStatus test, simulate non-empty directories:
            mockedFS.readdirSync
                .mockReturnValueOnce(['file1']) // For primary cache
                .mockReturnValueOnce(['file2']); // For fallback cache

            (service as any).updateCacheStatus();
            expect((service as any).statusBarItem.text).toBe('$(database) PR Analyzer (P+F)');
            expect((service as any).statusBarItem.tooltip).toBe('PR Analyzer: Primary and fallback caches available');
        });

        it('should clear cache correctly', async () => {
            const mockFiles = ['file1', 'file2'];
            mockedFS.readdirSync.mockReturnValue(mockFiles);
            await service.clearCache('/tmp/cache');
            expect(mockedFS.unlinkSync).toHaveBeenCalledTimes(2);
            expect(mockedFS.readdirSync).toHaveBeenCalledWith('/tmp/cache');
        });

        it('should handle showCacheManagementOptions with "Show cache info"', async () => {
            // Mock showCacheInfo method
            const showCacheInfoSpy = jest.spyOn(service as any, 'showCacheInfo').mockImplementation(() => {});

            // Simulate user selecting "Show cache info" from quick pick
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('Show cache info');

            await (service as any).showCacheManagementOptions();
            expect(showCacheInfoSpy).toHaveBeenCalled();
        });

        it('should handle showCacheManagementOptions with "Clear primary cache"', async () => {
            const clearCacheSpy = jest.spyOn(service, 'clearCache').mockResolvedValueOnce();
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('Clear primary cache');

            await (service as any).showCacheManagementOptions();
            expect(clearCacheSpy).toHaveBeenCalledWith((service as any).primaryCachePath);
        });

        it('should handle showCacheManagementOptions with "Clear fallback cache"', async () => {
            const clearCacheSpy = jest.spyOn(service, 'clearCache').mockResolvedValueOnce();
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('Clear fallback cache');

            await (service as any).showCacheManagementOptions();
            expect(clearCacheSpy).toHaveBeenCalledWith((service as any).fallbackCachePath);
        });

        it('should handle showCacheManagementOptions with "Clear all caches"', async () => {
            const clearCacheSpy = jest.spyOn(service, 'clearCache').mockResolvedValueOnce();
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('Clear all caches');

            await (service as any).showCacheManagementOptions();
            expect(clearCacheSpy).toHaveBeenCalledTimes(2);
        });

        it('should handle showCacheManagementOptions with "Regenerate primary cache"', async () => {
            const regenerateCacheSpy = jest.spyOn(service as any, 'regenerateCache').mockResolvedValueOnce(undefined);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('Regenerate primary cache');

            await (service as any).showCacheManagementOptions();
            expect(regenerateCacheSpy).toHaveBeenCalledWith((service as any).primaryModelName, true);
        });

        it('should handle showCacheManagementOptions with "Regenerate fallback cache"', async () => {
            const regenerateCacheSpy = jest.spyOn(service as any, 'regenerateCache').mockResolvedValueOnce(undefined);
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('Regenerate fallback cache');

            await (service as any).showCacheManagementOptions();
            expect(regenerateCacheSpy).toHaveBeenCalledWith((service as any).fallbackModelName, false);
        });

        it('should show cache info correctly', () => {
            // Setup mocks for directory size calculation
            mockedFS.existsSync.mockReturnValue(true);
            mockedFS.readdirSync.mockImplementation((dirPath: string) => {
                if (dirPath.includes('primary')) {
                    return ['file1', 'file2'];
                }
                if (dirPath.includes('fallback')) {
                    return ['file1'];
                }
                return [];
            });
            mockedFS.statSync.mockImplementation((filepath: string) => {
                return {
                    isDirectory: () => false,
                    size: 1024
                } as fs.Stats;
            });

            (service as any).showCacheInfo();
            expect(vscode.window.showInformationMessage).toHaveBeenCalled();
        });

        it('should handle errors when showing cache info', () => {
            mockedFS.existsSync.mockImplementation(() => {
                throw new Error('Test error');
            });

            (service as any).showCacheInfo();
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });

        it('should regenerate cache correctly', async () => {
            // Setup mocks
            (service as any).env = { cacheDir: '' };
            (service as any).pipeline = jest.fn().mockImplementation(() => {
                return async (text: string, options: any) => {
                    return { data: new Float32Array([0.1, 0.2, 0.3]) };
                };
            });

            const clearCacheSpy = jest.spyOn(service, 'clearCache').mockResolvedValueOnce();

            await (service as any).regenerateCache('test-model', true);

            expect(clearCacheSpy).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Primary cache regenerated successfully');
        });

        it('should handle errors when regenerating cache', async () => {
            // Setup mocks for failure
            (service as any).env = { cacheDir: '' };
            (service as any).pipeline = jest.fn().mockImplementation(() => {
                throw new Error('Pipeline error');
            });

            const clearCacheSpy = jest.spyOn(service, 'clearCache').mockResolvedValueOnce();

            await (service as any).regenerateCache('test-model', true);

            expect(clearCacheSpy).toHaveBeenCalled();
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });

        it('should calculate directory size correctly', () => {
            // Reset mocks to make sure there are no leftover implementations
            mockedFS.readdirSync.mockReset();
            mockedFS.statSync.mockReset();
            mockedFS.existsSync.mockReset();

            // Ensure the directory exists
            mockedFS.existsSync.mockReturnValue(true);

            // Use string includes for more resilient path matching rather than exact dictionary keys
            mockedFS.readdirSync.mockImplementation((dirPath: string) => {
                // Root directory contains file1 and file2
                if (dirPath.includes('/test/dir') && !dirPath.includes('file2')) {
                    return ['file1', 'file2'];
                }
                // Subdirectory contains subfile1 and subfile2
                if (dirPath.includes('file2')) {
                    return ['subfile1', 'subfile2'];
                }
                return [];
            });

            // Mock stats based on filename patterns
            mockedFS.statSync.mockImplementation((filePath: string) => {
                if (filePath.includes('file1')) {
                    return { isDirectory: () => false, size: 1024 } as fs.Stats;
                }
                if (filePath.includes('file2') && !filePath.includes('subfile')) {
                    return { isDirectory: () => true, size: 0 } as fs.Stats;
                }
                if (filePath.includes('subfile')) {
                    return { isDirectory: () => false, size: 1024 } as fs.Stats;
                }
                return { isDirectory: () => false, size: 0 } as fs.Stats;
            });

            // Call the method under test
            const size = (service as any).calculateDirSize('/test/dir');

            // Verify result
            expect(size).toBe(3072); // 1024 (file1) + 2048 (subdir with 2 files of 1024 each)
        });

        it('should format bytes correctly', () => {
            expect((service as any).formatBytes(0)).toBe('0 Bytes');
            expect((service as any).formatBytes(1000)).toBe('1000 Bytes');
            expect((service as any).formatBytes(1024)).toBe('1 KB');
            expect((service as any).formatBytes(1048576)).toBe('1 MB');
            expect((service as any).formatBytes(1073741824)).toBe('1 GB');
        });
    });

    describe('embedding generation', () => {
        it('should handle errors in generateEmbedding and attempt recovery', async () => {
            // Setup so initialization succeeds but embedding generation fails the first time
            await service.initializeModel();
            expect(service.isModelReady()).toBe(true);

            // Mock embeddingPipeline to throw an error and then succeed
            (service as any).embeddingPipeline = jest.fn()
                .mockRejectedValueOnce(new Error('Embedding error'))
                .mockImplementationOnce(async () => ({ data: new Float32Array([0.1, 0.2, 0.3]) }));

            // Mock initializeModel to succeed
            const initSpy = jest.spyOn(service, 'initializeModel').mockResolvedValueOnce();

            // This should fail but recover
            const embedding = await service.generateEmbedding('test code');
            expect(embedding).toEqual(new Float32Array([0.1, 0.2, 0.3]));
            expect(initSpy).toHaveBeenCalled();
        });

        it('should handle errors in generateEmbedding when recovery fails', async () => {
            await service.initializeModel();

            // Mock embeddingPipeline to throw an error
            (service as any).embeddingPipeline = jest.fn().mockRejectedValue(new Error('Embedding error'));

            // Mock initializeModel to fail
            jest.spyOn(service, 'initializeModel').mockRejectedValueOnce(new Error('Init error'));

            // This should fail with both original and recovery errors
            await expect(service.generateEmbedding('test code')).rejects.toThrow('Failed to generate embedding');
        });

        it('should batch generate embeddings correctly', async () => {
            // Mock generateEmbedding
            const generateSpy = jest.spyOn(service, 'generateEmbedding')
                .mockResolvedValueOnce(new Float32Array([0.1, 0.2, 0.3]))
                .mockResolvedValueOnce(new Float32Array([0.4, 0.5, 0.6]));

            const results = await service.generateBatchEmbeddings(['code1', 'code2']);

            expect(results.length).toBe(2);
            expect(results[0]).toEqual(new Float32Array([0.1, 0.2, 0.3]));
            expect(results[1]).toEqual(new Float32Array([0.4, 0.5, 0.6]));
            expect(generateSpy).toHaveBeenCalledTimes(2);
        });

        it('should handle large batches correctly', async () => {
            // Create mock for generateEmbedding that returns different values for each call
            const generateSpy = jest.spyOn(service, 'generateEmbedding')
                .mockImplementation(async (code) => {
                    const index = parseInt(code.replace('code', ''));
                    return new Float32Array([0.1 * index, 0.2 * index, 0.3 * index]);
                });

            // Create a large batch of inputs (15 items to test batching of 10)
            const inputs = Array.from({ length: 15 }, (_, i) => `code${i + 1}`);

            const results = await service.generateBatchEmbeddings(inputs);

            expect(results.length).toBe(15);
            expect(generateSpy).toHaveBeenCalledTimes(15);
        });
    });

    describe('model management', () => {
        it('should dispose resources correctly', () => {
            // Setup
            (service as any).embeddingPipeline = {};

            // Call dispose
            service.dispose();

            // Verify
            expect((service as any).embeddingPipeline).toBeNull();
        });

        it('should handle multiple initializeModel calls concurrently', async () => {
            // Create spies
            const _initSpy = jest.spyOn(service as any, '_initializeModel')
                .mockResolvedValueOnce(undefined);

            // Call initializeModel twice in quick succession
            const promise1 = service.initializeModel();
            const promise2 = service.initializeModel();

            // Both should resolve
            await Promise.all([promise1, promise2]);

            // _initializeModel should be called only once
            expect(_initSpy).toHaveBeenCalledTimes(1);
        });

        it('should update workspaceState when model loads successfully', async () => {
            // Instead of mocking _initializeModel, call the actual method but with mocked dependencies
            // Make sure pipeline succeeds to trigger the successful branch
            (service as any).pipeline = jest.fn().mockResolvedValue(async () => {
                return { data: new Float32Array([0.1, 0.2, 0.3]) };
            });

            await service.initializeModel();

            // Now the actual method should have called these updates
            expect(context.workspaceState.update).toHaveBeenCalledWith('codeEmbeddingService.status', 'ready');
            expect(context.workspaceState.update).toHaveBeenCalledWith('codeEmbeddingService.model', expect.any(String));
        });

        it('should handle when no storage path is available', () => {
            // Spy on console.warn
            const consoleSpy = jest.spyOn(console, 'warn');

            // Create a service with mock context that simulates no storage path
            const contextWithoutStorage = {
                ...context,
                storageUri: null as unknown as vscode.Uri,
                globalStorageUri: null as unknown as vscode.Uri
            };

            // This should log a warning but not crash
            const serviceWithoutStorage = new CodeEmbeddingService(contextWithoutStorage);

            expect(consoleSpy).toHaveBeenCalledWith('No storage path available, using memory cache only');
        });
    });

    describe('error handling', () => {
        it('should handle clearCache for non-existent paths', async () => {
            // Simple mocking - no recursion issues
            mockedFS.existsSync.mockReturnValueOnce(false);

            await service.clearCache('/nonexistent/path');

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Cache does not exist');
        });

        it('should handle errors during cache clearing', async () => {
            // Mock fs.readdirSync to throw an error
            mockedFS.existsSync.mockReturnValue(true);
            mockedFS.readdirSync.mockImplementationOnce(() => {
                throw new Error('Failed to read directory');
            });

            await service.clearCache('/problematic/path');

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to clear cache'));
        });
    });

    describe('additional embedding functionality', () => {
        it('should generate embeddings with different options', async () => {
            // Mock the embeddingPipeline directly instead of initializing
            (service as any).embeddingPipeline = jest.fn().mockImplementation(async () => ({
                data: new Float32Array([0.1, 0.2, 0.3])
            }));

            // Test with different pooling options
            await service.generateEmbedding('test code', { pooling: 'cls' });
            await service.generateEmbedding('test code', { pooling: 'none' });
            await service.generateEmbedding('test code', { normalize: false });

            expect((service as any).embeddingPipeline).toHaveBeenCalledTimes(3);
        });
    });
});

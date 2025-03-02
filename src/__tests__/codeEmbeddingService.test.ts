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
jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    unlinkSync: jest.fn(),
    statSync: jest.fn().mockReturnValue({
        isDirectory: () => false,
        size: 1024
    })
}));

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

jest.mock('vscode', () => {
    const originalVscode = jest.requireActual('vscode');
    const mockStatusBarItem = {
        text: '',
        tooltip: '',
        command: '',
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn()
    };
    return {
        ...originalVscode,
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
        Uri: {
            file: jest.fn(filepath => ({
                fsPath: filepath,
                toString: () => filepath
            })),
            joinPath: jest.fn((base, ...segments) => {
                const basePath = typeof base === 'string' ? base : (base.fsPath || '');
                const joined = path.join(basePath, ...segments);
                return {
                    fsPath: joined,
                    toString: () => joined
                };
            })
        },
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
    });
});

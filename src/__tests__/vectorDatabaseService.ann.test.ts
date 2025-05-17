import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VectorDatabaseService } from '../services/vectorDatabaseService';
import { HierarchicalNSW } from 'hnswlib-node';

// Mock hnswlib-node
vi.mock('hnswlib-node', () => {
    const actualHNSW = vi.importActual('hnswlib-node');
    const HierarchicalNSW = vi.fn();
    HierarchicalNSW.prototype.initIndex = vi.fn();
    HierarchicalNSW.prototype.readIndexSync = vi.fn();
    HierarchicalNSW.prototype.writeIndexSync = vi.fn();
    HierarchicalNSW.prototype.getCurrentCount = vi.fn(() => 0);
    return { ...actualHNSW, HierarchicalNSW };
});

// Mock fs
vi.mock('fs', async () => {
    const actualFs = await vi.importActual<typeof fs>('fs');
    return {
        ...actualFs,
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        statSync: vi.fn(() => ({ size: 0 })),
        unlinkSync: vi.fn(),
    };
});


describe('VectorDatabaseService ANN Integration', () => {
    let vectorDbService: VectorDatabaseService;
    let mockContext: vscode.ExtensionContext;
    // Use in-memory database for tests
    const dbPath = ':memory:';
    // annIndexPath will be relative to the current working directory when dbPath is :memory:
    // as path.dirname(':memory:') is '.'
    const annIndexPath = path.join('.', 'embeddings.ann.idx');


    beforeEach(async () => {
        mockContext = {
            globalStorageUri: vscode.Uri.file(path.join(__dirname, 'globalStorage')),
            extensionPath: __dirname,
        } as unknown as vscode.ExtensionContext;

        // Ensure globalStorageUri directory exists for the test
        if (!fs.existsSync(mockContext.globalStorageUri.fsPath)) {
            fs.mkdirSync(mockContext.globalStorageUri.fsPath, { recursive: true });
        }

        // Reset mocks for fs.existsSync before each test
        vi.mocked(fs.existsSync).mockReset();

        vectorDbService = new VectorDatabaseService({ dbPath });
        // Ensure SQLite initialization is complete before tests run
        // @ts-expect-error accessing private member for test setup
        await vectorDbService.initPromise;
    });

    afterEach(async () => {
        await vectorDbService.dispose();
        // Clean up mock ANN index file if it was "created" by a mock
        // No actual db file to clean up when using :memory:
        if (vi.mocked(fs.existsSync)(annIndexPath)) { // Check if mock thinks it exists
            vi.mocked(fs.unlinkSync)(annIndexPath); // Call the mock unlink
        }
        vi.clearAllMocks();
    });

    it('should initialize annIndexPath in constructor', () => {
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.annIndexPath).toBe(annIndexPath);
    });

    it('setCurrentModelDimension should initialize HierarchicalNSW with correct dimension', () => {
        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);

        expect(HierarchicalNSW).toHaveBeenCalledWith('cosine', dimension);
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.annIndex).toBeInstanceOf(HierarchicalNSW);
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.currentModelDimension).toBe(dimension);
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.annIndex.initIndex).toHaveBeenCalledWith(1000000); // ANN_MAX_ELEMENTS_CONFIG
    });

    it('setCurrentModelDimension should not re-initialize if dimension is the same and index exists', () => {
        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);
        const initialAnnIndexInstance = vectorDbService.getAnnIndex();
        vi.clearAllMocks(); // Clear mocks after first call

        vectorDbService.setCurrentModelDimension(dimension); // Call again with same dimension

        expect(HierarchicalNSW).not.toHaveBeenCalled(); // Should not create a new instance
        expect(initialAnnIndexInstance?.initIndex).not.toHaveBeenCalled(); // Should not re-initialize
        expect(vectorDbService.getAnnIndex()).toBe(initialAnnIndexInstance);
    });

    it('setCurrentModelDimension should re-initialize if dimension changes', () => {
        vectorDbService.setCurrentModelDimension(128);
        const firstIndexInstance = vectorDbService.getAnnIndex();
        vi.clearAllMocks();

        vectorDbService.setCurrentModelDimension(256); // New dimension

        expect(HierarchicalNSW).toHaveBeenCalledWith('cosine', 256);
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.annIndex).not.toBe(firstIndexInstance);
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.annIndex.initIndex).toHaveBeenCalledWith(1000000);
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.currentModelDimension).toBe(256);
    });

    it('setCurrentModelDimension should attempt to load index if file exists', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true); // Simulate index file exists
        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);

        // @ts-expect-error accessing private member for test
        expect(vectorDbService.annIndex.readIndexSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('setCurrentModelDimension should initialize new index if loading fails', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true); // Simulate index file exists
        const mockAnnIndexInstance = new HierarchicalNSW('cosine', 128);
        vi.mocked(mockAnnIndexInstance.readIndexSync).mockImplementation(() => {
            throw new Error('Load failed');
        });
        vi.mocked(HierarchicalNSW).mockReturnValue(mockAnnIndexInstance);


        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);

        expect(mockAnnIndexInstance.readIndexSync).toHaveBeenCalledWith(annIndexPath);
        // Since loading failed, a new index should be initialized on a fresh instance
        // The mock setup for HierarchicalNSW needs to be precise here.
        // The test checks that initIndex is called on the *new* instance created after load failure.
        // This part is tricky to test perfectly without deeper mocking of the HNSW constructor logic post-failure.
        // The core idea is that if loadAnnIndex returns false, initIndex is called.
        // Our loadAnnIndex re-creates the instance if load fails.
        expect(mockAnnIndexInstance.initIndex).toHaveBeenCalledWith(1000000);
    });


    it('dispose should call saveAnnIndex', async () => {
        vectorDbService.setCurrentModelDimension(128); // Initialize annIndex
        const annIndexInstance = vectorDbService.getAnnIndex();

        await vectorDbService.dispose();

        expect(annIndexInstance?.writeIndexSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('saveAnnIndex should call writeIndexSync and create directory if not exists', () => {
        vectorDbService.setCurrentModelDimension(128);
        const annIndexInstance = vectorDbService.getAnnIndex();
        vi.mocked(fs.existsSync).mockReturnValue(false); // Simulate directory does not exist

        // @ts-expect-error accessing private method for test
        vectorDbService.saveAnnIndex();

        expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(annIndexPath), { recursive: true });
        expect(annIndexInstance?.writeIndexSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('deleteAllEmbeddingsAndChunks should clear and save ANN index if dimension is set', async () => {
        vectorDbService.setCurrentModelDimension(128);
        const annIndexInstance = vectorDbService.getAnnIndex();

        await vectorDbService.deleteAllEmbeddingsAndChunks();

        expect(annIndexInstance?.initIndex).toHaveBeenCalledWith(1000000);
        expect(annIndexInstance?.writeIndexSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('deleteAllEmbeddingsAndChunks should delete ANN index file if dimension is not set and file exists', async () => {
        // @ts-expect-error
        vectorDbService.currentModelDimension = null; // Ensure no dimension
        // @ts-expect-error
        vectorDbService.annIndex = null; // Ensure no index instance
        vi.mocked(fs.existsSync).mockReturnValue(true); // Simulate index file exists

        await vectorDbService.deleteAllEmbeddingsAndChunks();

        expect(fs.unlinkSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('getAnnIndex should return the current ANN index instance', () => {
        expect(vectorDbService.getAnnIndex()).toBeNull(); // Initially null
        vectorDbService.setCurrentModelDimension(128);
        expect(vectorDbService.getAnnIndex()).toBeInstanceOf(HierarchicalNSW);
    });

    it('setCurrentModelDimension should handle null dimension by clearing index and attempting to delete file', () => {
        vectorDbService.setCurrentModelDimension(128); // Set a dimension first
        expect(vectorDbService.getAnnIndex()).not.toBeNull();

        vi.mocked(fs.existsSync).mockReturnValue(true); // Simulate index file exists for deletion attempt

        // @ts-expect-error testing with null
        vectorDbService.setCurrentModelDimension(null);

        expect(vectorDbService.getAnnIndex()).toBeNull();
        // @ts-expect-error
        expect(vectorDbService.currentModelDimension).toBeNull();
        expect(fs.unlinkSync).toHaveBeenCalledWith(annIndexPath);
    });
});
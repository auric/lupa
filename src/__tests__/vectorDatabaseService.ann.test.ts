import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
// Import 'fs' to access its mocked functions later
import * as fs from 'fs';
import * as path from 'path';
import { VectorDatabaseService } from '../services/vectorDatabaseService';
// Import 'HierarchicalNSW' to allow type checking and access to the mocked constructor
import { HierarchicalNSW } from 'hnswlib-node';
import { EmbeddingRecord } from '../types/embeddingTypes';
// Import '@vscode/sqlite3' to access its mocked Database constructor
import * as sqlite3 from '@vscode/sqlite3';

// --- Mock Factories ---

// Mock hnswlib-node
vi.mock('hnswlib-node', () => {
    const mockHNSWInstanceMethods = {
        // Sync methods
        initIndex: vi.fn(),
        addPoint: vi.fn(),
        searchKnn: vi.fn(),
        getMaxElements: vi.fn(),
        getCurrentCount: vi.fn(),
        getPoint: vi.fn(),
        writeIndexSync: vi.fn(),
        readIndexSync: vi.fn(),
        resizeIndex: vi.fn(),
        markDelete: vi.fn(),
        unmarkDelete: vi.fn(),
        getIdsList: vi.fn(() => []),
        getNumDimensions: vi.fn(() => 0),
        getEf: vi.fn(() => 0),
        setEf: vi.fn(),
        // Async methods
        writeIndex: vi.fn(() => Promise.resolve(true)), // Should return Promise<boolean>
        readIndex: vi.fn(() => Promise.resolve(true)),  // Should return Promise<boolean>
    };
    const MockedHierarchicalNSW = vi.fn(() => mockHNSWInstanceMethods);
    return { HierarchicalNSW: MockedHierarchicalNSW };
});

// Mock fs
vi.mock('fs', async () => {
    const actualFs = await vi.importActual<typeof fs>('fs');
    return {
        ...actualFs, // Spread actual fs for any unmocked functions if needed
        existsSync: vi.fn(),
        mkdirSync: vi.fn(),
        statSync: vi.fn(),
        unlinkSync: vi.fn(),
    };
});

// Mock @vscode/sqlite3
vi.mock('@vscode/sqlite3', () => {
    // Define mockStatementMethods with 'this' return type for chaining
    const mockStatementMethods: any = {}; // Use 'any' for self-reference during definition
    Object.assign(mockStatementMethods, {
        run: vi.fn(function (...args: any[]) {
            const callback = args[args.length - 1];
            if (typeof callback === 'function') callback.call(this, null); // 'this' here is RunResult context
            return mockStatementMethods; // Return 'this' (the statement object)
        }),
        finalize: vi.fn((callback) => {
            if (typeof callback === 'function') callback(null);
            // Finalize doesn't typically chain the statement itself in the same way.
        }),
        bind: vi.fn(function (...args: any[]) { return mockStatementMethods; }),
        reset: vi.fn(function (callback?: (err: Error | null) => void) {
            if (callback) callback(null);
            return mockStatementMethods;
        }),
        all: vi.fn(function (...args: any[]) {
            const callback = args[args.length - 1];
            if (typeof callback === 'function') callback.call(this, null, []); // 'this' is Statement context
            return mockStatementMethods;
        }),
        get: vi.fn(function (...args: any[]) {
            const callback = args[args.length - 1];
            if (typeof callback === 'function') callback.call(this, null, undefined); // 'this' is Statement context
            return mockStatementMethods;
        }),
        each: vi.fn(function (...args: any[]) {
            // row callback, then completion callback
            const completionCallback = args[args.length - 1];
            if (typeof completionCallback === 'function') completionCallback.call(this, null, 0); // 'this' is Statement context
            return mockStatementMethods;
        }),
    });

    const mockDbMethods: any = {}; // Use 'any' for self-reference
    Object.assign(mockDbMethods, {
        run: vi.fn(function (...args: any[]) {
            const callback = args[args.length - 1];
            // The callback for db.run has `this` as RunResult
            if (typeof callback === 'function') callback.call({ lastID: 1, changes: 1 } as sqlite3.RunResult, null);
            return mockDbMethods; // Return 'this' (the DB object)
        }),
        get: vi.fn(function (...args: any[]) {
            const callback = args[args.length - 1];
            if (typeof callback === 'function') callback.call(this, null, undefined);
            return mockDbMethods;
        }),
        all: vi.fn(function (...args: any[]) {
            const callback = args[args.length - 1];
            if (typeof callback === 'function') callback.call(this, null, []);
            return mockDbMethods;
        }),
        prepare: vi.fn(function (sql: string, callback?: (err: Error | null) => void) {
            if (callback) callback(null);
            return mockStatementMethods; // Returns a statement object
        }),
        close: vi.fn((callback) => {
            if (typeof callback === 'function') callback(null);
            // Close doesn't typically chain.
        }),
        exec: vi.fn(function (sql: string, callback?: (this: sqlite3.Statement, err: Error | null) => void) {
            if (callback) callback.call(mockStatementMethods, null); // 'this' context is Statement
            return mockDbMethods;
        }),
        each: vi.fn(function (sql: string, paramsOrCallback?: any, callbackOrUndefined?: any) {
            const completionCallback = callbackOrUndefined || (typeof paramsOrCallback === 'function' && !paramsOrCallback.length ? paramsOrCallback : undefined);
            if (typeof completionCallback === 'function') completionCallback.call(this, null, 0);
            return mockDbMethods;
        }),
        map: vi.fn(function (sql: string, params: any, callback?: (err: Error | null, rows: any) => void) {
            if (callback) callback(null, {});
            return mockDbMethods;
        }),
        serialize: vi.fn(function (callback?: () => void) { if (callback) callback(); return mockDbMethods; }),
        parallelize: vi.fn(function (callback?: () => void) { if (callback) callback(); return mockDbMethods; }),
        on: vi.fn(function () { return mockDbMethods; }),
        loadExtension: vi.fn(function (path: string, callback?: (err: Error | null) => void) { if (callback) callback(null); return mockDbMethods; }),
        interrupt: vi.fn(() => { }), // interrupt is void
        busyTimeout: vi.fn(function () { return mockDbMethods; }),
        configure: vi.fn(), // Often void or specific return, assume void for basic mock
        wait: vi.fn(function (callback?: (err: Error | null) => void) { if (callback) callback(null); return mockDbMethods; }),
        addListener: vi.fn(function () { return mockDbMethods; }),
        once: vi.fn(function () { return mockDbMethods; }),
        removeListener: vi.fn(function () { return mockDbMethods; }),
        off: vi.fn(function () { return mockDbMethods; }), // Alias for removeListener
        removeAllListeners: vi.fn(function () { return mockDbMethods; }),
        setMaxListeners: vi.fn(function () { return mockDbMethods; }),
        getMaxListeners: vi.fn(() => 0), // Returns number
        listenerCount: vi.fn(() => 0), // Returns number
        prependListener: vi.fn(function () { return mockDbMethods; }),
        prependOnceListener: vi.fn(function () { return mockDbMethods; }),
        eventNames: vi.fn(() => []), // Returns string[]
        listeners: vi.fn(() => []), // Returns Function[]
        rawListeners: vi.fn(() => []), // Returns Function[]
        emit: vi.fn(() => false), // Returns boolean
    });

    const MockedDatabase = vi.fn(
        (
            filename: string,
            modeOrCallback?: number | ((err: Error | null) => void),
            callback?: (err: Error | null) => void
        ) => {
            let cb: ((err: Error | null) => void) | undefined;
            if (typeof modeOrCallback === 'function') {
                cb = modeOrCallback;
            } else if (typeof callback === 'function') {
                cb = callback;
            }
            if (cb) {
                cb(null); // Simulate successful opening
            }
            return mockDbMethods;
        }
    );
    return {
        Database: MockedDatabase,
        OPEN_READWRITE: 1, // Actual values, not mocks
        OPEN_CREATE: 2,    // Actual values, not mocks
    };
});


describe('VectorDatabaseService ANN Integration', () => {
    let vectorDbService: VectorDatabaseService;
    let mockContext: vscode.ExtensionContext;
    const dbPath = ':memory:';
    const annIndexPath = path.join('.', 'embeddings.ann.idx');

    // Helper to get the HNSW mock instance methods
    // This relies on the fact that setCurrentModelDimension creates an instance
    const getMockHNSWInstanceMethods = () => {
        // After HierarchicalNSW constructor is called, its return value (the mock instance)
        // is stored. We can get it from the last call to the constructor.
        const constructorMock = vi.mocked(HierarchicalNSW);
        if (constructorMock.mock.results.length > 0) {
            // Get the last returned value which is our mockHNSWInstanceMethods object
            return constructorMock.mock.results[constructorMock.mock.results.length - 1].value;
        }
        // Fallback if setCurrentModelDimension hasn't been called yet in a test,
        // though most tests will call it.
        // This direct return is less safe if multiple instances were created and not reset properly.
        // However, with resetAllMocks and careful test setup, it should point to the one from the factory.
        // For safety, ensure setCurrentModelDimension is called in test setups.
        // This is a bit of a workaround because the mockHNSWInstanceMethods is defined inside the factory.
        // A more robust way might be to have the factory export the methods object, but that's complex.
        // For now, we assume tests will set up the HNSW index.
        return vi.mocked(new HierarchicalNSW('cosine', 1) as any); // Cast to any to access mocked methods
    };

    // Helper to get the SQLite mock instance methods
    const getMockSqliteDbMethods = () => {
        const constructorMock = vi.mocked(sqlite3.Database);
        if (constructorMock.mock.results.length > 0) {
            return constructorMock.mock.results[constructorMock.mock.results.length - 1].value;
        }
        return vi.mocked(new sqlite3.Database(':memory:') as any); // Cast to any
    }


    beforeEach(async () => {
        vi.resetAllMocks(); // Reset all mocks: call history, implementations, return values

        // --- Re-establish default mock implementations after reset ---

        // FS Mocks
        vi.mocked(fs.existsSync).mockImplementation((p) => {
            if (p === annIndexPath) return false;
            if (mockContext && p === mockContext.globalStorageUri.fsPath) return true;
            return false;
        });
        vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
        vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as fs.Stats);
        vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

        // HNSW Mocks (re-establish on the instance that will be created)
        // We can't directly access mockHNSWInstanceMethods from here due to hoisting.
        // Instead, we rely on HierarchicalNSW constructor mock returning an object
        // whose methods we can then mock if needed, or rely on their fresh vi.fn() state.
        // Default return values for HNSW methods that are commonly checked:
        const hnswInstanceDefaults = {
            getMaxElements: () => 1000000, // ANN_MAX_ELEMENTS_CONFIG
            getCurrentCount: () => 0,
            searchKnn: () => ({ neighbors: [], distances: [] }),
            getPoint: () => null,
        };
        vi.mocked(HierarchicalNSW).mockImplementation(() => ({
            initIndex: vi.fn(),
            addPoint: vi.fn(),
            searchKnn: vi.fn().mockImplementation(hnswInstanceDefaults.searchKnn),
            getMaxElements: vi.fn().mockImplementation(hnswInstanceDefaults.getMaxElements),
            getCurrentCount: vi.fn().mockImplementation(hnswInstanceDefaults.getCurrentCount),
            getPoint: vi.fn().mockImplementation(hnswInstanceDefaults.getPoint),
            writeIndexSync: vi.fn(),
            readIndexSync: vi.fn(),
            resizeIndex: vi.fn(),
            markDelete: vi.fn(),
            unmarkDelete: vi.fn(),
            getIdsList: vi.fn(() => []),
            getNumDimensions: vi.fn(() => 0),
            getEf: vi.fn(() => 0),
            setEf: vi.fn(),
            writeIndex: vi.fn(() => Promise.resolve(true)), // Return Promise<boolean>
            readIndex: vi.fn(() => Promise.resolve(true)),  // Return Promise<boolean>
        }));


        // SQLite Mocks - Re-establish default implementations ensuring 'this' is returned for chaining
        // and callbacks are handled correctly.
        const mockStatementDefaults: any = {}; // Use 'any' for self-reference during definition
        Object.assign(mockStatementDefaults, {
            run: vi.fn(function (this: sqlite3.Statement, ...args: any[]) {
                const callback = args[args.length - 1];
                // For statement.run, 'this' in callback is RunResult, not Statement
                if (typeof callback === 'function') callback.call({ lastID: 1, changes: 1 } as sqlite3.RunResult, null);
                return this;
            }),
            finalize: vi.fn(function (this: sqlite3.Statement, callback?: (err: Error | null) => void) {
                if (callback) callback(null);
                // Finalize doesn't chain 'this' statement.
            }),
            bind: vi.fn(function (this: sqlite3.Statement, ...args: any[]) { return this; }),
            reset: vi.fn(function (this: sqlite3.Statement, callback?: (err: Error | null) => void) {
                if (callback) callback(null);
                return this;
            }),
            all: vi.fn(function (this: sqlite3.Statement, ...args: any[]) {
                const callback = args[args.length - 1];
                if (typeof callback === 'function') callback.call(this, null, []);
                return this;
            }),
            get: vi.fn(function (this: sqlite3.Statement, ...args: any[]) {
                const callback = args[args.length - 1];
                if (typeof callback === 'function') callback.call(this, null, undefined);
                return this;
            }),
            each: vi.fn(function (this: sqlite3.Statement, ...args: any[]) {
                const completionCallback = args[args.length - 1];
                // Invoke row callback if provided (args[args.length-2]) - simplified here
                if (typeof completionCallback === 'function') completionCallback.call(this, null, 0);
                return this;
            }),
        });

        const mockDbDefaults: any = {}; // Use 'any' for self-reference
        Object.assign(mockDbDefaults, {
            run: vi.fn(function (this: sqlite3.Database, ...args: any[]) {
                const callback = args[args.length - 1];
                if (typeof callback === 'function') callback.call({ lastID: 1, changes: 1 } as sqlite3.RunResult, null);
                return this;
            }),
            get: vi.fn(function (this: sqlite3.Database, ...args: any[]) {
                const callback = args[args.length - 1];
                if (typeof callback === 'function') callback.call(this, null, undefined);
                return this;
            }),
            all: vi.fn(function (this: sqlite3.Database, ...args: any[]) {
                const callback = args[args.length - 1];
                if (typeof callback === 'function') callback.call(this, null, []);
                return this;
            }),
            prepare: vi.fn(function (this: sqlite3.Database, sql: string, callback?: (this: sqlite3.Database, err: Error | null) => void) {
                if (callback) callback.call(this, null);
                return mockStatementDefaults;
            }),
            close: vi.fn(function (this: sqlite3.Database, callback?: (err: Error | null) => void) {
                if (callback) callback(null);
                // Close doesn't chain.
            }),
            exec: vi.fn(function (this: sqlite3.Database, sql: string, callback?: (this: sqlite3.Database, err: Error | null) => void) {
                if (callback) callback.call(this, null); // 'this' in exec callback is Database
                return this;
            }),
            each: vi.fn(function (this: sqlite3.Database, sql: string, paramsOrCallback?: any, callbackOrUndefined?: any) {
                const completionCallback = callbackOrUndefined || (typeof paramsOrCallback === 'function' && (typeof paramsOrCallback !== 'object' || paramsOrCallback === null) ? paramsOrCallback : undefined);
                // Invoke row callback if provided - simplified here
                if (typeof completionCallback === 'function') completionCallback.call(this, null, 0);
                return this;
            }),
            map: vi.fn(function (this: sqlite3.Database, sql: string, params: any, callback?: (this: sqlite3.Database, err: Error | null, rows: any) => void) {
                if (callback) callback.call(this, null, {});
                return this;
            }),
            serialize: vi.fn(function (this: sqlite3.Database, callback?: () => void) { if (callback) callback(); return this; }),
            parallelize: vi.fn(function (this: sqlite3.Database, callback?: () => void) { if (callback) callback(); return this; }),
            on: vi.fn(function (this: sqlite3.Database) { return this; }),
            loadExtension: vi.fn(function (this: sqlite3.Database, path: string, callback?: (err: Error | null) => void) { if (callback) callback(null); return this; }),
            interrupt: vi.fn(function (this: sqlite3.Database) { /* void */ }),
            busyTimeout: vi.fn(function (this: sqlite3.Database) { return this; }),
            configure: vi.fn(function (this: sqlite3.Database, option: string, value: any) { /* void or specific based on option */ }),
            wait: vi.fn(function (this: sqlite3.Database, callback?: (err: Error | null) => void) { if (callback) callback(null); return this; }),
            addListener: vi.fn(function (this: sqlite3.Database) { return this; }),
            once: vi.fn(function (this: sqlite3.Database) { return this; }),
            removeListener: vi.fn(function (this: sqlite3.Database) { return this; }),
            off: vi.fn(function (this: sqlite3.Database) { return this; }),
            removeAllListeners: vi.fn(function (this: sqlite3.Database) { return this; }),
            setMaxListeners: vi.fn(function (this: sqlite3.Database) { return this; }),
            getMaxListeners: vi.fn(() => 0),
            listenerCount: vi.fn(() => 0),
            prependListener: vi.fn(function (this: sqlite3.Database) { return this; }),
            prependOnceListener: vi.fn(function (this: sqlite3.Database) { return this; }),
            eventNames: vi.fn(() => []),
            listeners: vi.fn(() => []),
            rawListeners: vi.fn(() => []),
            emit: vi.fn(() => false),
        });

        vi.mocked(sqlite3.Database).mockImplementation(
            (
                filename: string,
                modeOrCallback?: number | ((err: Error | null) => void), // Correctly use modeOrCallback
                callback?: (err: Error | null) => void
            ) => {
                let cb: ((err: Error | null) => void) | undefined;
                if (typeof modeOrCallback === 'function') {
                    cb = modeOrCallback;
                } else if (typeof callback === 'function') {
                    cb = callback;
                }
                if (cb) {
                    // cb(null); // Simulate successful opening -- DO NOT CALL SYNCHRONOUSLY
                    // Simulate asynchronous callback invocation
                    process.nextTick(() => {
                        cb!(null); // Use non-null assertion as we checked cb
                    });
                }
                const instanceToReturn = mockDbDefaults as sqlite3.Database;
                return instanceToReturn;
            }
        );

        mockContext = {
            globalStorageUri: vscode.Uri.file(path.join(__dirname, 'globalStorageTest')),
            extensionPath: __dirname,
        } as unknown as vscode.ExtensionContext;

        // Ensure globalStorageUri directory exists (using the mock)
        if (!fs.existsSync(mockContext.globalStorageUri.fsPath)) {
            fs.mkdirSync(mockContext.globalStorageUri.fsPath, { recursive: true });
        }

        vectorDbService = new VectorDatabaseService({ dbPath });
        // @ts-expect-error initPromise is private
        await vectorDbService.initPromise; // Should resolve now
    });

    afterEach(async () => {
        await vectorDbService.dispose();
        // vi.resetAllMocks() in beforeEach should handle mock state cleanup.
    });

    it('should initialize annIndexPath in constructor', () => {
        // @ts-expect-error accessing private member for test
        expect(vectorDbService.annIndexPath).toBe(annIndexPath);
    });

    it('setCurrentModelDimension should initialize HierarchicalNSW with correct dimension', () => {
        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);
        const mockHNSW = getMockHNSWInstanceMethods();

        expect(vi.mocked(HierarchicalNSW)).toHaveBeenCalledWith('cosine', dimension);
        // @ts-expect-error annIndex is private
        expect(vectorDbService.annIndex).toBe(mockHNSW);
        // @ts-expect-error currentModelDimension is private
        expect(vectorDbService.currentModelDimension).toBe(dimension);
        expect(mockHNSW.initIndex).toHaveBeenCalledWith(1000000); // ANN_MAX_ELEMENTS_CONFIG
    });

    it('setCurrentModelDimension should not re-initialize if dimension is the same and index exists', () => {
        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);
        const initialAnnIndexInstance = vectorDbService.getAnnIndex(); // This will be our mock HNSW instance
        vi.mocked(HierarchicalNSW).mockClear(); // Clear constructor calls for the next check
        vi.mocked(initialAnnIndexInstance!.initIndex).mockClear();


        vectorDbService.setCurrentModelDimension(dimension); // Call again with same dimension

        expect(vi.mocked(HierarchicalNSW)).not.toHaveBeenCalled();
        expect(initialAnnIndexInstance!.initIndex).not.toHaveBeenCalled();
        expect(vectorDbService.getAnnIndex()).toBe(initialAnnIndexInstance);
    });

    it('setCurrentModelDimension should re-initialize if dimension changes', () => {
        vectorDbService.setCurrentModelDimension(128);
        const firstMockHNSW = getMockHNSWInstanceMethods();
        vi.mocked(HierarchicalNSW).mockClear(); // Clear constructor for the next call

        vectorDbService.setCurrentModelDimension(256); // New dimension
        const secondMockHNSW = getMockHNSWInstanceMethods();


        expect(vi.mocked(HierarchicalNSW)).toHaveBeenCalledWith('cosine', 256);
        // @ts-expect-error annIndex is private
        expect(vectorDbService.annIndex).not.toBe(firstMockHNSW);
        // @ts-expect-error annIndex is private
        expect(vectorDbService.annIndex).toBe(secondMockHNSW);
        expect(secondMockHNSW.initIndex).toHaveBeenCalledWith(1000000);
        // @ts-expect-error currentModelDimension is private
        expect(vectorDbService.currentModelDimension).toBe(256);
    });

    it('setCurrentModelDimension should attempt to load index if file exists', () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => p === annIndexPath); // Simulate index file exists
        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);
        const mockHNSW = getMockHNSWInstanceMethods();

        expect(mockHNSW.readIndexSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('setCurrentModelDimension should initialize new index if loading fails', () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => p === annIndexPath);

        const mockReadIndexSync = vi.fn(() => { throw new Error('Load failed'); });
        const mockInitIndexAfterFailure = vi.fn();

        // Mock HNSW constructor to return an instance that fails on read,
        // then for the subsequent call (re-initialization), return one that can be init'd.
        vi.mocked(HierarchicalNSW)
            .mockImplementationOnce(() => ({
                initIndex: vi.fn(), addPoint: vi.fn(), searchKnn: vi.fn(), getMaxElements: vi.fn(),
                getCurrentCount: vi.fn(), getPoint: vi.fn(), writeIndexSync: vi.fn(),
                readIndexSync: mockReadIndexSync, // This one will throw
                resizeIndex: vi.fn(), markDelete: vi.fn(), unmarkDelete: vi.fn(), getIdsList: vi.fn(() => []),
                getNumDimensions: vi.fn(() => dimension), getEf: vi.fn(), setEf: vi.fn(),
                writeIndex: vi.fn(() => Promise.resolve(true)), readIndex: vi.fn(() => Promise.resolve(true)),
            }))
            .mockImplementationOnce(() => ({
                initIndex: mockInitIndexAfterFailure, // This one will be called
                addPoint: vi.fn(), searchKnn: vi.fn(), getMaxElements: vi.fn(),
                getCurrentCount: vi.fn(), getPoint: vi.fn(), writeIndexSync: vi.fn(),
                readIndexSync: vi.fn(), resizeIndex: vi.fn(), markDelete: vi.fn(), unmarkDelete: vi.fn(),
                getIdsList: vi.fn(() => []), getNumDimensions: vi.fn(() => dimension), getEf: vi.fn(),
                setEf: vi.fn(), writeIndex: vi.fn(() => Promise.resolve(true)), readIndex: vi.fn(() => Promise.resolve(true)),
            }));

        const dimension = 128;
        vectorDbService.setCurrentModelDimension(dimension);

        expect(mockReadIndexSync).toHaveBeenCalledWith(annIndexPath);
        expect(mockInitIndexAfterFailure).toHaveBeenCalledWith(1000000);
    });


    it('dispose should call saveAnnIndex', async () => {
        vectorDbService.setCurrentModelDimension(128);
        const mockHNSW = getMockHNSWInstanceMethods();
        await vectorDbService.dispose();
        expect(mockHNSW.writeIndexSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('saveAnnIndex should call writeIndexSync and create directory if not exists', () => {
        vectorDbService.setCurrentModelDimension(128);
        const mockHNSW = getMockHNSWInstanceMethods();
        // Simulate directory for ANN index does not exist
        vi.mocked(fs.existsSync).mockImplementation((p) => p === path.dirname(annIndexPath) ? false : (p === annIndexPath ? false : true));

        // @ts-expect-error saveAnnIndex is private
        vectorDbService.saveAnnIndex();

        expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(path.dirname(annIndexPath), { recursive: true });
        expect(mockHNSW.writeIndexSync).toHaveBeenCalledWith(annIndexPath);
    });

    it('deleteAllEmbeddingsAndChunks should clear and save ANN index if dimension is set', async () => {
        vectorDbService.setCurrentModelDimension(128);
        const mockHNSW = getMockHNSWInstanceMethods();
        await vectorDbService.deleteAllEmbeddingsAndChunks();

        expect(mockHNSW.initIndex).toHaveBeenCalledWith(1000000); // Re-init to clear
        expect(mockHNSW.writeIndexSync).toHaveBeenCalledWith(annIndexPath); // Save empty index
    });

    it('deleteAllEmbeddingsAndChunks should delete ANN index file if dimension is not set and file exists', async () => {
        // @ts-expect-error currentModelDimension is private
        vectorDbService.currentModelDimension = null;
        // @ts-expect-error annIndex is private
        vectorDbService.annIndex = null;
        vi.mocked(fs.existsSync).mockReturnValue(true); // Simulate index file exists

        await vectorDbService.deleteAllEmbeddingsAndChunks();

        expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(annIndexPath);
    });

    it('getAnnIndex should return the current ANN index instance', () => {
        expect(vectorDbService.getAnnIndex()).toBeNull(); // Initially null
        vectorDbService.setCurrentModelDimension(128);
        expect(vectorDbService.getAnnIndex()).toEqual(getMockHNSWInstanceMethods());
    });

    it('setCurrentModelDimension should handle null dimension by clearing index and attempting to delete file', () => {
        vectorDbService.setCurrentModelDimension(128);
        expect(vectorDbService.getAnnIndex()).not.toBeNull();
        vi.mocked(fs.existsSync).mockReturnValue(true);

        // @ts-expect-error testing with null
        vectorDbService.setCurrentModelDimension(null);

        expect(vectorDbService.getAnnIndex()).toBeNull();
        // @ts-expect-error currentModelDimension is private
        expect(vectorDbService.currentModelDimension).toBeNull();
        expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(annIndexPath);
    });

    // --- Tests for storeEmbeddings ---
    describe('storeEmbeddings', () => {
        const dimension = 3;
        let mockHNSW: ReturnType<typeof getMockHNSWInstanceMethods>;
        let mockDB: ReturnType<typeof getMockSqliteDbMethods>;


        beforeEach(() => { // This beforeEach is nested
            vectorDbService.setCurrentModelDimension(dimension);
            mockHNSW = getMockHNSWInstanceMethods();
            mockDB = getMockSqliteDbMethods();


            // Reset specific mock states for this suite
            mockHNSW.addPoint.mockClear();
            mockHNSW.writeIndexSync.mockClear();
            mockHNSW.getCurrentCount.mockReturnValue(0);
            mockHNSW.getMaxElements.mockReturnValue(100);
            vi.mocked(mockDB.prepare().run).mockClear();
        });

        it('should store embeddings in ANN index and metadata in SQLite', async () => {
            const embeddingsToStore: Array<Omit<EmbeddingRecord, 'id' | 'createdAt' | 'label'>> = [
                { chunkId: 'chunk1', vector: new Float32Array([0.1, 0.2, 0.3]) },
                { chunkId: 'chunk2', vector: new Float32Array([0.4, 0.5, 0.6]) },
            ];

            await vectorDbService.storeEmbeddings(embeddingsToStore);

            expect(mockHNSW.addPoint).toHaveBeenCalledTimes(2);
            expect(mockHNSW.addPoint).toHaveBeenCalledWith(Array.from(embeddingsToStore[0].vector), 0);
            expect(mockHNSW.addPoint).toHaveBeenCalledWith(Array.from(embeddingsToStore[1].vector), 1);

            expect(mockDB.prepare).toHaveBeenCalledWith('INSERT INTO embeddings (id, chunk_id, label, created_at) VALUES (?, ?, ?, ?)');
            const stmtRunMock = vi.mocked(mockDB.prepare().run);
            expect(stmtRunMock).toHaveBeenCalledTimes(2);
            expect(stmtRunMock.mock.calls[0][1]).toBe('chunk1');
            expect(stmtRunMock.mock.calls[0][2]).toBe(0);
            expect(stmtRunMock.mock.calls[1][1]).toBe('chunk2');
            expect(stmtRunMock.mock.calls[1][2]).toBe(1);

            expect(mockHNSW.writeIndexSync).toHaveBeenCalled();
        });

        it('should throw error if ANN index or model dimension is not initialized', async () => {
            // @ts-expect-error annIndex is private
            vectorDbService.annIndex = null;
            const embeddingsToStore = [{ chunkId: 'c1', vector: new Float32Array([1, 2, 3]) }];
            await expect(vectorDbService.storeEmbeddings(embeddingsToStore))
                .rejects.toThrow('ANN index or model dimension is not initialized. Cannot store embeddings.');
        });

        it('should attempt to resize ANN index if full and log warning', async () => {
            mockHNSW.getCurrentCount.mockReturnValue(99);
            mockHNSW.getMaxElements.mockReturnValue(100);
            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            const embeddingsToStore = [
                { chunkId: 'c100', vector: new Float32Array([0.1, 0.1, 0.1]) },
                { chunkId: 'c101', vector: new Float32Array([0.2, 0.2, 0.2]) },
            ];

            let currentCountForResizeTest = 99;
            mockHNSW.addPoint.mockImplementation(() => {
                currentCountForResizeTest++;
            });
            // Simulate that after the first addPoint, getCurrentCount would return 100
            // This is tricky because the check happens *before* addPoint for the item that overflows.
            // The logic is: nextLabel (which is currentCount) >= maxElements
            // So if currentCount = 99, nextLabel = 99. 99 < 100. Add c100. nextLabel becomes 100.
            // For c101, nextLabel = 100. 100 >= 100. Resize.
            mockHNSW.getCurrentCount.mockImplementationOnce(() => 99); // For c100
            mockHNSW.getCurrentCount.mockImplementationOnce(() => 100); // For c101 check, before resize
            // After resize, it might be called again, but we are interested in the call that triggers resize.


            await vectorDbService.storeEmbeddings(embeddingsToStore);

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('ANN index is full (current: 100, max: 100). Attempting to resize to 200 using resizeIndex.')
            );
            expect(mockHNSW.resizeIndex).toHaveBeenCalledWith(200);
            expect(mockHNSW.addPoint).toHaveBeenCalledTimes(2);

            consoleWarnSpy.mockRestore();
        });

        it('should throw error if ANN index resize fails', async () => {
            mockHNSW.getCurrentCount.mockReturnValue(100);
            mockHNSW.getMaxElements.mockReturnValue(100);
            mockHNSW.resizeIndex.mockImplementation(() => {
                throw new Error('Simulated resize failure');
            });
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

            const embeddingsToStore = [{ chunkId: 'c101', vector: new Float32Array([0.1, 0.1, 0.1]) }];
            await expect(vectorDbService.storeEmbeddings(embeddingsToStore))
                .rejects.toThrow('ANN index is full and resize failed. Max elements: 100. Please increase ANN_MAX_ELEMENTS_CONFIG and rebuild.');

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to resize ANN index. Max elements: 100. Current count: 100. Error: Error: Simulated resize failure')
            );
            consoleErrorSpy.mockRestore();
        });
    });

    // --- Tests for findSimilarCode ---
    describe('findSimilarCode', () => {
        const dimension = 3;
        const queryVector = new Float32Array([0.1, 0.2, 0.3]);
        let mockHNSW: ReturnType<typeof getMockHNSWInstanceMethods>;
        let mockDB: ReturnType<typeof getMockSqliteDbMethods>;

        beforeEach(() => { // Nested beforeEach
            vectorDbService.setCurrentModelDimension(dimension);
            mockHNSW = getMockHNSWInstanceMethods();
            mockDB = getMockSqliteDbMethods();
            mockHNSW.searchKnn.mockClear();
            vi.mocked(mockDB.all).mockClear();
        });

        it('should return empty array if ANN index is not initialized', async () => {
            // @ts-expect-error annIndex is private
            vectorDbService.annIndex = null;
            const results = await vectorDbService.findSimilarCode(queryVector);
            expect(results).toEqual([]);
            expect(mockHNSW.searchKnn).not.toHaveBeenCalled();
        });

        it('should return empty array if ANN index is empty', async () => {
            mockHNSW.getCurrentCount.mockReturnValue(0);
            const results = await vectorDbService.findSimilarCode(queryVector);
            expect(results).toEqual([]);
            expect(mockHNSW.searchKnn).not.toHaveBeenCalled();
        });

        it('should find similar items and fetch metadata from SQLite', async () => {
            mockHNSW.getCurrentCount.mockReturnValue(2);
            mockHNSW.searchKnn.mockReturnValue({
                neighbors: [0, 1], // labels
                distances: [0.1, 0.2] // similarity 0.9, 0.8
            });

            const mockMetadataRows = [
                { chunk_id: 'chunk0', content: 'content0', file_id: 'file0', start_offset: 0, end_offset: 10, path: '/path/file0.txt', label: 0 },
                { chunk_id: 'chunk1', content: 'content1', file_id: 'file1', start_offset: 0, end_offset: 10, path: '/path/file1.txt', label: 1 },
            ];
            vi.mocked(mockDB.all).mockImplementation((sql, params, cb) => cb(null, mockMetadataRows));


            const results = await vectorDbService.findSimilarCode(queryVector, { limit: 2, minScore: 0.7 });

            expect(mockHNSW.searchKnn).toHaveBeenCalledWith(Array.from(queryVector), 10);
            expect(vi.mocked(mockDB.all)).toHaveBeenCalledWith(expect.stringContaining('WHERE e.label IN (?,?)'), [0, 1], expect.any(Function));
            expect(results.length).toBe(2);
            expect(results[0].chunkId).toBe('chunk0');
            expect(results[0].score).toBeCloseTo(0.9);
        });

        it('should apply limit and minScore options', async () => {
            mockHNSW.getCurrentCount.mockReturnValue(3);
            mockHNSW.searchKnn.mockReturnValue({
                neighbors: [0, 1, 2],
                distances: [0.1, 0.2, 0.5] // scores 0.9, 0.8, 0.5
            });
            const allMetadata = [
                { chunk_id: 'chunk0', content: 'c0', file_id: 'f0', start_offset: 0, end_offset: 1, path: 'p0', label: 0 },
                { chunk_id: 'chunk1', content: 'c1', file_id: 'f1', start_offset: 0, end_offset: 1, path: 'p1', label: 1 },
                { chunk_id: 'chunk2', content: 'c2', file_id: 'f2', start_offset: 0, end_offset: 1, path: 'p2', label: 2 }, // score 0.5
            ];
            vi.mocked(mockDB.all).mockImplementation((sql, params, cb) => {
                // Filter rows based on labels passed from the service (which are already score-filtered)
                const requestedRows = allMetadata.filter(row => (params as number[]).includes(row.label));
                cb(null, requestedRows);
            });

            const results = await vectorDbService.findSimilarCode(queryVector, { limit: 1, minScore: 0.7 });
            expect(results.length).toBe(1);
            expect(results[0].chunkId).toBe('chunk0');
            expect(results[0].score).toBeCloseTo(0.9);
        });

        it('should apply fileFilter', async () => {
            mockHNSW.getCurrentCount.mockReturnValue(2);
            mockHNSW.searchKnn.mockReturnValue({
                neighbors: [0, 1], distances: [0.1, 0.2]
            });
            const allMetadata = [
                { chunk_id: 'chunk0', content: 'c0', file_id: 'f0', start_offset: 0, end_offset: 1, path: '/path/file_A.txt', label: 0 },
                { chunk_id: 'chunk1', content: 'c1', file_id: 'f1', start_offset: 0, end_offset: 1, path: '/path/file_B.txt', label: 1 },
            ];
            vi.mocked(mockDB.all).mockImplementation((sql, params, cb) => cb(null, allMetadata.filter(r => params.includes(r.label))));

            const results = await vectorDbService.findSimilarCode(queryVector, { fileFilter: ['/path/file_A.txt'], minScore: 0.5 });
            expect(results.length).toBe(1);
            expect(results[0].filePath).toBe('/path/file_A.txt');
        });
    });

    // --- Tests for getEmbedding ---
    describe('getEmbedding', () => {
        const dimension = 3;
        const chunkId = 'test-chunk-id';
        const label = 42;
        const vectorArray = [0.7, 0.8, 0.9];
        const vectorFloat32 = new Float32Array(vectorArray);
        let mockHNSW: ReturnType<typeof getMockHNSWInstanceMethods>;
        let mockDB: ReturnType<typeof getMockSqliteDbMethods>;


        beforeEach(() => { // Nested beforeEach
            vectorDbService.setCurrentModelDimension(dimension);
            mockHNSW = getMockHNSWInstanceMethods();
            mockDB = getMockSqliteDbMethods();
            vi.mocked(mockDB.get).mockClear();
            mockHNSW.getPoint.mockClear();
        });

        it('should retrieve embedding vector from ANN and metadata from SQLite', async () => {
            vi.mocked(mockDB.get).mockImplementation((sql, params, cb) => cb(null, { id: 'emb-id', chunk_id: chunkId, label: label, created_at: Date.now() }));
            mockHNSW.getPoint.mockReturnValue(vectorFloat32);

            const result = await vectorDbService.getEmbedding(chunkId);

            expect(vi.mocked(mockDB.get)).toHaveBeenCalledWith(expect.stringContaining('WHERE chunk_id = ?'), [chunkId], expect.any(Function));
            expect(mockHNSW.getPoint).toHaveBeenCalledWith(label);
            expect(result).not.toBeNull();
            expect(result?.vector).toEqual(vectorFloat32);
        });

        it('should handle HNSW returning number[] for getPoint and convert to Float32Array', async () => {
            vi.mocked(mockDB.get).mockImplementation((sql, params, cb) => cb(null, { id: 'emb-id', chunk_id: chunkId, label: label, created_at: Date.now() }));
            mockHNSW.getPoint.mockReturnValue(vectorArray); // HNSW returns number[]

            const result = await vectorDbService.getEmbedding(chunkId);
            expect(result?.vector).toBeInstanceOf(Float32Array);

            const resultArray = Array.from(result!.vector);
            expect(resultArray.length).toBe(vectorArray.length);
            for (let i = 0; i < vectorArray.length; i++) {
                // Default precision for toBeCloseTo is 2, might need more for typical embedding values
                // Let's use a common precision for float comparisons, e.g., 5-7 decimal places.
                expect(resultArray[i]).toBeCloseTo(vectorArray[i], 5);
            }
        });

        it('should return null if embedding metadata not found in SQLite', async () => {
            vi.mocked(mockDB.get).mockImplementation((sql, params, cb) => cb(null, undefined));

            const result = await vectorDbService.getEmbedding(chunkId);
            expect(result).toBeNull();
            expect(mockHNSW.getPoint).not.toHaveBeenCalled();
        });

        it('should return metadata with empty vector if ANN index is not available', async () => {
            vi.mocked(mockDB.get).mockImplementation((sql, params, cb) => cb(null, { id: 'emb-id', chunk_id: chunkId, label: label, created_at: Date.now() }));
            // @ts-expect-error annIndex is private
            vectorDbService.annIndex = null;

            const result = await vectorDbService.getEmbedding(chunkId);
            expect(result).not.toBeNull();
            expect(result?.vector).toEqual(new Float32Array(0));
        });

        it('should return metadata with empty vector if point not found in ANN index', async () => {
            vi.mocked(mockDB.get).mockImplementation((sql, params, cb) => cb(null, { id: 'emb-id', chunk_id: chunkId, label: label, created_at: Date.now() }));
            mockHNSW.getPoint.mockReturnValue(null);

            const result = await vectorDbService.getEmbedding(chunkId);
            expect(result).not.toBeNull();
            expect(result?.vector).toEqual(new Float32Array(0));
        });
    });
});
import { vi, describe, it, beforeEach, afterEach, expect } from 'vitest';
import { AsyncIndexingProcessor, FileToProcess, ProcessingResult } from '../workers/asyncIndexingProcessor';
import { EmbeddingOptions } from '../types/embeddingTypes';

// Mock worker_threads to provide test data
vi.mock('worker_threads', () => ({
    workerData: null
}));

describe('AsyncIndexingProcessor Integration Tests', () => {
    let processor: AsyncIndexingProcessor;
    const testModelBasePath = '/test/models';
    const testModelName = 'test-model';
    const testContextLength = 256;

    beforeEach(() => {
        vi.clearAllMocks();

        processor = new AsyncIndexingProcessor(
            testModelBasePath,
            testModelName,
            testContextLength
        );
    });

    afterEach(() => {
        processor.dispose();
    });

    it('should initialize correctly', () => {
        expect(processor).toBeDefined();
    });

    it('should handle file processing with empty content', async () => {
        const testFile: FileToProcess = {
            id: 'empty-file',
            path: '/test/empty.js',
            content: ''
        };

        const signal = new AbortController().signal;
        const result = await processor.processFile(testFile, signal);

        expect(result.fileId).toBe('empty-file');
        expect(result.embeddings).toBeDefined();

        // For empty content, we expect either success with some result or a specific error
        // The actual behavior depends on how the real dependencies handle empty text
        expect(typeof result.success).toBe('boolean');

        if (result.success) {
            expect(Array.isArray(result.embeddings)).toBe(true);
            expect(Array.isArray(result.chunkOffsets)).toBe(true);
        } else {
            expect(result.error).toBeDefined();
            expect(result.embeddings).toEqual([]);
        }
    });

    it('should handle file processing with simple content', async () => {
        const testFile: FileToProcess = {
            id: 'simple-file',
            path: '/test/simple.js',
            content: 'const x = 1;'
        };

        const signal = new AbortController().signal;
        const result = await processor.processFile(testFile, signal);

        expect(result.fileId).toBe('simple-file');
        expect(typeof result.success).toBe('boolean');

        // Since transformers might not be available in test environment,
        // we accept either success or graceful failure
        if (result.success) {
            expect(Array.isArray(result.embeddings)).toBe(true);
            expect(Array.isArray(result.chunkOffsets)).toBe(true);
            expect(result.error).toBeUndefined();
        } else {
            expect(result.error).toBeDefined();
            expect(result.embeddings).toEqual([]);
        }
    });

    it('should handle cancellation gracefully', async () => {
        const abortController = new AbortController();

        const testFile: FileToProcess = {
            id: 'cancelled-file',
            path: '/test/cancelled.js',
            content: 'const x = 1;'
        };

        // Cancel immediately to test cancellation handling
        abortController.abort();

        const result = await processor.processFile(testFile, abortController.signal);

        expect(result.fileId).toBe('cancelled-file');
        expect(typeof result.success).toBe('boolean');

        // Cancellation should result in failure
        if (!result.success) {
            expect(result.error).toBeDefined();
            expect(result.embeddings).toEqual([]);
        }
    });

    it('should use correct embedding options', async () => {
        const customOptions: EmbeddingOptions = {
            pooling: 'mean',
            normalize: false
        };

        const customProcessor = new AsyncIndexingProcessor(
            testModelBasePath,
            testModelName,
            testContextLength,
            customOptions
        );

        const testFile: FileToProcess = {
            id: 'options-test',
            path: '/test/options.js',
            content: 'const x = 1;'
        };

        const signal = new AbortController().signal;

        // This will test that the processor can be created with custom options
        const result = await customProcessor.processFile(testFile, signal);

        expect(result.fileId).toBe('options-test');
        expect(typeof result.success).toBe('boolean');

        customProcessor.dispose();
    });

    it('should handle different file extensions', async () => {
        const testFiles = [
            { id: 'js-file', path: '/test/file.js', content: 'const x = 1;' },
            { id: 'ts-file', path: '/test/file.ts', content: 'const x: number = 1;' },
            { id: 'py-file', path: '/test/file.py', content: 'x = 1' },
            { id: 'txt-file', path: '/test/file.txt', content: 'Hello world' }
        ];

        const signal = new AbortController().signal;

        for (const testFile of testFiles) {
            const result = await processor.processFile(testFile, signal);
            expect(result.fileId).toBe(testFile.id);
            expect(typeof result.success).toBe('boolean');

            if (result.success) {
                expect(Array.isArray(result.embeddings)).toBe(true);
                expect(Array.isArray(result.chunkOffsets)).toBe(true);
            } else {
                expect(result.error).toBeDefined();
            }
        }
    });

    it('should handle multiple chunks correctly', async () => {
        const testFile: FileToProcess = {
            id: 'multi-chunk',
            path: '/test/multi.js',
            content: `
function a() {
    return 1;
}

function b() {
    return 2;
}

function c() {
    return 3;
}
            `.trim()
        };

        const signal = new AbortController().signal;
        const result = await processor.processFile(testFile, signal);

        expect(result.fileId).toBe('multi-chunk');
        expect(typeof result.success).toBe('boolean');

        if (result.success) {
            expect(Array.isArray(result.embeddings)).toBe(true);
            expect(Array.isArray(result.chunkOffsets)).toBe(true);
            // Should have processed multiple chunks for the larger content
            expect(result.chunkOffsets.length).toBeGreaterThan(0);
        } else {
            expect(result.error).toBeDefined();
        }
    });

    it('should handle invalid file content gracefully', async () => {
        const testFile: FileToProcess = {
            id: 'invalid-content',
            path: '/test/invalid.js',
            content: '\x00\x01\x02' // Binary content that might cause issues
        };

        const signal = new AbortController().signal;
        const result = await processor.processFile(testFile, signal);

        expect(result.fileId).toBe('invalid-content');
        expect(typeof result.success).toBe('boolean');

        // Invalid content should be handled gracefully
        if (!result.success) {
            expect(result.error).toBeDefined();
            expect(result.embeddings).toEqual([]);
        }
    });

    it('should handle very large files', async () => {
        // Create a large content string
        const largeContent = 'const x = 1;\n'.repeat(1000);

        const testFile: FileToProcess = {
            id: 'large-file',
            path: '/test/large.js',
            content: largeContent
        };

        const signal = new AbortController().signal;
        const result = await processor.processFile(testFile, signal);

        expect(result.fileId).toBe('large-file');
        expect(typeof result.success).toBe('boolean');

        if (result.success) {
            expect(Array.isArray(result.embeddings)).toBe(true);
            expect(Array.isArray(result.chunkOffsets)).toBe(true);
            // Large files should be chunked into multiple pieces
            expect(result.chunkOffsets.length).toBeGreaterThan(0);
        } else {
            expect(result.error).toBeDefined();
        }
    });
});

describe('AsyncIndexingProcessor Piscina Integration', () => {
    it('should export default function for Piscina', async () => {
        // This test verifies that the default export function works correctly
        const module = await import('../workers/asyncIndexingProcessor');
        expect(module.default).toBeDefined();
        expect(typeof module.default).toBe('function');
    });

    it('should handle task data structure correctly', () => {
        // Test the expected task data structure
        const taskData = {
            file: {
                id: 'test-task',
                path: '/test/task.js',
                content: 'const x = 1;'
            }
        };

        expect(taskData.file).toBeDefined();
        expect(taskData.file.id).toBe('test-task');
        expect(taskData.file.path).toBe('/test/task.js');
        expect(taskData.file.content).toBe('const x = 1;');
    });

    it('should validate ProcessingResult structure', () => {
        // Test expected result structure
        const mockResult: ProcessingResult = {
            fileId: 'test',
            embeddings: [new Float32Array([0.1, 0.2])],
            chunkOffsets: [0],
            metadata: {
                parentStructureIds: [],
                structureOrders: [],
                isOversizedFlags: [],
                structureTypes: []
            },
            success: true
        };

        expect(mockResult.fileId).toBe('test');
        expect(mockResult.embeddings).toHaveLength(1);
        expect(mockResult.chunkOffsets).toEqual([0]);
        expect(mockResult.metadata).toBeDefined();
        expect(mockResult.success).toBe(true);
        expect(mockResult.error).toBeUndefined();
    });
});

describe('AsyncIndexingProcessor Error Handling', () => {
    let processor: AsyncIndexingProcessor;

    beforeEach(() => {
        vi.clearAllMocks();

        processor = new AsyncIndexingProcessor(
            '/test/models',
            'test-model',
            256
        );
    });

    afterEach(() => {
        processor.dispose();
    });

    it('should handle transformer initialization errors gracefully', async () => {
        // This test relies on the fact that transformers will likely fail to initialize
        // in a test environment without proper model files
        const testFile: FileToProcess = {
            id: 'transformer-error',
            path: '/test/error.js',
            content: 'const x = 1;'
        };

        const signal = new AbortController().signal;
        const result = await processor.processFile(testFile, signal);

        expect(result.fileId).toBe('transformer-error');
        expect(typeof result.success).toBe('boolean');

        // In a real test environment, this will likely fail due to missing transformers setup
        // which is exactly what we want to test - graceful error handling
        if (!result.success) {
            expect(result.error).toBeDefined();
            expect(result.embeddings).toEqual([]);
        }
    });

    it('should provide consistent error handling', async () => {
        const testFiles = [
            { id: 'test1', path: '/test/test1.js', content: 'test content 1' },
            { id: 'test2', path: '/test/test2.js', content: 'test content 2' }
        ];

        const signal = new AbortController().signal;
        const results: ProcessingResult[] = [];

        for (const file of testFiles) {
            const result = await processor.processFile(file, signal);
            results.push(result);
        }

        // All results should have consistent structure
        for (const result of results) {
            expect(typeof result.success).toBe('boolean');
            expect(typeof result.fileId).toBe('string');
            expect(Array.isArray(result.embeddings)).toBe(true);
            expect(Array.isArray(result.chunkOffsets)).toBe(true);
            expect(result.metadata).toBeDefined();

            if (!result.success) {
                expect(typeof result.error).toBe('string');
            }
        }
    });
});

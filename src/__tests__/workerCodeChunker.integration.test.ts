import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { TreeStructureAnalyzerPool } from '../services/treeStructureAnalyzer';
import { WorkerCodeChunker } from '../workers/workerCodeChunker';
import { WorkerTokenEstimator } from '../workers/workerTokenEstimator';
import { EmbeddingOptions } from '../types/embeddingTypes';

// Mock vscode module
vi.mock('vscode');

function hasUnbalancedQuotes(str: string): boolean {
    let doubleQuotes = 0;
    let singleQuotes = 0;
    let inDoubleQuoteString = false;
    let inSingleQuoteString = false;
    let escaped = false;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (char === '"' && !inSingleQuoteString) {
            inDoubleQuoteString = !inDoubleQuoteString;
        } else if (char === "'" && !inDoubleQuoteString) {
            inSingleQuoteString = !inSingleQuoteString;
        }
    }

    return inDoubleQuoteString || inSingleQuoteString;
}

describe('WorkerCodeChunker Integration Tests', () => {
    // Increase timeout for model initialization
    vi.setConfig({ testTimeout: 30000 });

    let extensionPath: string;
    let tokenEstimator: WorkerTokenEstimator;
    let chunker: WorkerCodeChunker;

    beforeAll(async () => {
        // Set up the extension path to the actual project root
        extensionPath = path.resolve(__dirname, '..', '..');

        // Initialize TreeStructureAnalyzerPool
        TreeStructureAnalyzerPool.createSingleton(extensionPath, 2);

        // Initialize WorkerTokenEstimator with Xenova model
        tokenEstimator = new WorkerTokenEstimator('Xenova/all-MiniLM-L6-v2', 256);

        // Initialize WorkerCodeChunker
        chunker = new WorkerCodeChunker(tokenEstimator);

        // Wait for the tokenizer to initialize
        await tokenEstimator.initialize();
    });

    afterAll(async () => {
        // Clean up resources
        await chunker.dispose();
    });

    it('should properly chunk TypeScript code without splitting words/symbols', async () => {
        const code = `
/**
 * Sample TypeScript code with multiple structures
 */
export class SampleClass {
    // Class property
    private value: number = 42;

    constructor(initialValue?: number) {
        if (initialValue !== undefined) {
            this.value = initialValue;
        }
    }

    /**
     * Sample method that does something
     */
    public doSomething(param1: string, param2: number): string {
        const result = param1.repeat(param2) + this.value;
        return result;
    }

    // Another method with a long name that might get split incorrectly
    public calculateSomethingReallyComplexWithLongMethodNameThatMightCauseProblems(): number {
        let accumulator = 0;
        // Some loop that does calculations
        for (let i = 0; i < this.value; i++) {
            accumulator += Math.pow(i, 2) + Math.sqrt(i);
        }
        return accumulator;
    }
}

// Another class to test multiple structures
export class AnotherClass {
    public static helper(): void {
        console.log("Helper method");
    }
}

// A function outside of any class
export function standaloneFunction(test: string): boolean {
    return test.length > 10;
}
`;

        // Define embedding options
        const options: EmbeddingOptions = {
            overlapSize: 100
        };

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(code, options, signal, 'typescript');

        // Verify the result has chunks
        expect(result.chunks.length).toBeGreaterThan(0);

        // Check for proper chunking - no chunks should end with split words/symbols
        for (const chunk of result.chunks) {
            // A word/symbol split would typically end with an incomplete identifier
            const endsWithIncompleteWord = /[a-zA-Z0-9_]$/.test(chunk);
            expect(endsWithIncompleteWord).toBe(false);
        }

        // Check that chunks respect structure boundaries when possible
        // At least one chunk should contain a complete method or class
        const containsCompleteMethod = result.chunks.some(chunk =>
            chunk.includes('public doSomething(') &&
            chunk.includes('return result;') &&
            chunk.includes('}')
        );

        expect(containsCompleteMethod).toBe(true);
    });

    it('should handle oversized structures by breaking them intelligently', async () => {
        // Create a very large function that definitely won't fit in a single chunk
        let longFunction = 'function veryLargeFunction() {\n';
        longFunction += '  // A lot of code comments to make this function large\n'.repeat(200);
        longFunction += '  const largeArray = [\n';

        // Add a lot of array items to make it large
        for (let i = 0; i < 500; i++) {
            longFunction += `    { id: ${i}, name: "Item ${i}", value: ${i * 3.14} },\n`;
        }

        longFunction += '  ];\n';
        longFunction += '  return largeArray;\n';
        longFunction += '}\n';

        // Define embedding options
        const options: EmbeddingOptions = {
            overlapSize: 50
        };

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(longFunction, options, signal, 'javascript');

        // Should split into multiple chunks due to size
        expect(result.chunks.length).toBeGreaterThan(1);

        // Check parent structure information - chunks from same structure should share parent ID
        const parentIds = result.metadata.parentStructureIds.filter(id => id !== null);

        // If we have chunks with parent IDs, there should be multiple chunks with the same parent ID
        if (parentIds.length > 0) {
            // Get unique parent IDs
            const uniqueParentIds = [...new Set(parentIds)];

            // For each unique ID, there should be multiple chunks with that ID
            for (const parentId of uniqueParentIds) {
                const chunksWithParentId = result.metadata.parentStructureIds.filter(id => id === parentId).length;
                expect(chunksWithParentId).toBeGreaterThan(1);
            }
        }

        // Check that no chunk ends with a split identifier or keyword
        // These regex patterns match incomplete identifiers, string literals, or operators
        const badEndingPatterns = [
            /[a-zA-Z0-9_]$/, // Incomplete identifier
            /\+$/, /-$/, /\*$/, /\/$/, // Operator at end
            /\.$/ // Object property access
        ];

        for (const chunk of result.chunks) {
            // Check for unbalanced quotes
            if (hasUnbalancedQuotes(chunk)) {
                console.log(`Chunk ends with an unclosed string literal: ${chunk}`);
            }
            expect(hasUnbalancedQuotes(chunk)).toBe(false);

            // Check for other bad endings
            for (const pattern of badEndingPatterns) {
                if (pattern.test(chunk)) {
                    console.log(`Chunk ends with a bad pattern: ${chunk}`);
                }

                expect(pattern.test(chunk)).toBe(false);
            }
        }
    });

    it('should handle templates', async () => {
        // Read the complex C++ sample from fixtures
        const complexCppPath = path.join(__dirname, 'fixtures', 'complex_cpp_sample.cpp');

        // Get the code from the fixture file
        let complexCppCode = `
/**
 * A namespace containing utility functions and classes
 */
namespace utils {
    /**
     * A template container class
     */
    template<typename T>
    class Container {
    public:
        // Type definitions
        using value_type = T;
        using reference = T&;
        using const_reference = const T&;

        // Constructors
        Container() = default;
        explicit Container(size_t size) : mItems(size) {}

        // Element access
        reference at(size_t index) { return mItems.at(index); }
        const_reference at(size_t index) const { return mItems.at(index); }

        // Capacity
        size_t size() const { return mItems.size(); }
        bool empty() const { return mItems.empty(); }

        // Modifiers
        void push_back(const T& value) { mItems.push_back(value); }
        void pop_back() { mItems.pop_back(); }

        // Iterators
        auto begin() { return mItems.begin(); }
        auto end() { return mItems.end(); }

    private:
        std::vector<T> mItems; // Storage for items
    };
}
`
        // Define embedding options
        const options: EmbeddingOptions = {
            overlapSize: 100
        };

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(complexCppCode, options, signal, 'cpp');

        // Verify chunking result
        expect(result.chunks.length).toBeGreaterThan(0);

        // Check that each chunk has appropriate content
        // and no chunk ends with an incomplete identifier
        const incompleteIdentifierPattern = /[a-zA-Z0-9_]$/;

        for (const chunk of result.chunks) {
            // Check for incomplete identifiers at end of chunk
            if (incompleteIdentifierPattern.test(chunk)) {
                console.log(`Chunk ends with an incomplete identifier: ${chunk}`);
            }
            expect(incompleteIdentifierPattern.test(chunk)).toBe(false);

            // Chunks should have meaningful content
            expect(chunk.trim().length).toBeGreaterThan(0);
        }

        // Check for structure type information
        const structureTypes = result.metadata.structureTypes.filter(t => t !== null);
        expect(structureTypes.length).toBeGreaterThan(0);
    });

    it('should handle complex language constructs like nested classes and functions', async () => {
        // Read the complex C++ sample from fixtures
        const complexCppPath = path.join(__dirname, 'fixtures', 'complex_cpp_sample.cpp');

        // Get the code from the fixture file
        let complexCppCode = '';
        try {
            if (fs.existsSync(complexCppPath)) {
                complexCppCode = fs.readFileSync(complexCppPath, 'utf8');
            } else {
                // Simple fallback if the file doesn't exist
                complexCppCode = `
                class TestClass {
                    void testMethod() {}
                };
                `;
            }
        } catch (error) {
            console.error("Error reading fixture file:", error);
            // Create a simple test case as fallback
            complexCppCode = `class TestClass {};`;
        }

        // Define embedding options
        const options: EmbeddingOptions = {
            overlapSize: 100
        };

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(complexCppCode, options, signal, 'cpp');

        // Verify chunking result
        expect(result.chunks.length).toBeGreaterThan(0);

        // Check that each chunk has appropriate content
        // and no chunk ends with an incomplete identifier
        const incompleteIdentifierPattern = /[a-zA-Z0-9_]$/;

        for (const chunk of result.chunks) {
            // Check for incomplete identifiers at end of chunk
            if (incompleteIdentifierPattern.test(chunk)) {
                console.log(`Chunk ends with an incomplete identifier: ${chunk}`);
            }
            expect(incompleteIdentifierPattern.test(chunk)).toBe(false);

            // Chunks should have meaningful content
            expect(chunk.trim().length).toBeGreaterThan(0);
        }

        // Check for structure type information
        const structureTypes = result.metadata.structureTypes.filter(t => t !== null);
        expect(structureTypes.length).toBeGreaterThan(0);
    });

    it('should not produce overlapped chunks that split words/identifiers', async () => {
        const code = `
function testFunction(param1, param2) {
    // This is a comment to provide some context
    const result = param1 + param2;

    if (result > 10) {
        console.log('Result is greater than 10');
        return result * 2;
    } else {
        console.log('Result is less than or equal to 10');
        return result / 2;
    }
}

class TestClass {
    constructor(value) {
        this.value = value;
    }

    getValue() {
        return this.value;
    }

    setValue(newValue) {
        this.value = newValue;
    }
}
`;

        // Define embedding options with significant overlap
        const options: EmbeddingOptions = {
            overlapSize: 200 // Large overlap to test boundary handling
        };

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(code, options, signal, 'javascript');

        // If we have multiple chunks
        if (result.chunks.length > 1) {
            // For each chunk except the last
            for (let i = 0; i < result.chunks.length - 1; i++) {
                const currentChunk = result.chunks[i];
                const nextChunk = result.chunks[i + 1];

                // Find the overlapping region
                const nextChunkStartPos = result.offsets[i + 1];
                const currentChunkEndPos = result.offsets[i] + currentChunk.length;

                // If we have overlap
                if (nextChunkStartPos < currentChunkEndPos) {
                    const overlapStart = nextChunkStartPos - result.offsets[i];
                    const overlapFromCurrent = currentChunk.substring(overlapStart);
                    const overlapLength = Math.min(overlapFromCurrent.length, nextChunk.length);
                    const overlapFromNext = nextChunk.substring(0, overlapLength);

                    // Check that the overlap doesn't start in the middle of a word
                    // by examining the character before and after the split point
                    // If both are alphanumeric or underscores, we may have split a word
                    if (overlapStart > 0) {
                        const charBeforeSplit = currentChunk[overlapStart - 1];
                        const charAfterSplit = currentChunk[overlapStart];

                        const bothArePartOfIdentifier =
                            /[a-zA-Z0-9_]/.test(charBeforeSplit) &&
                            /[a-zA-Z0-9_]/.test(charAfterSplit);

                        expect(bothArePartOfIdentifier).toBe(false);
                    }
                }
            }
        }
    });
});
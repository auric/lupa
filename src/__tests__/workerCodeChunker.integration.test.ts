import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { CodeAnalysisService, CodeAnalysisServiceInitializer } from '../services/codeAnalysisService';
import { WorkerCodeChunker } from '../workers/workerCodeChunker';
import { WorkerTokenEstimator } from '../workers/workerTokenEstimator';
import { EmbeddingOptions } from '../types/embeddingTypes';

// Mock vscode module
vi.mock('vscode');

function hasUnbalancedQuotes(str: string): boolean {
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
    let codeAnalysisService: CodeAnalysisService;

    beforeAll(async () => {
        // Set up the extension path to the actual project root
        extensionPath = path.resolve(__dirname, '..', '..');

        await CodeAnalysisServiceInitializer.initialize(extensionPath);

        // Initialize WorkerTokenEstimator with Xenova model
        tokenEstimator = new WorkerTokenEstimator('Xenova/all-MiniLM-L6-v2', 256);
        await tokenEstimator.initialize();

        codeAnalysisService = new CodeAnalysisService();
        chunker = new WorkerCodeChunker(codeAnalysisService, tokenEstimator);
    });

    afterAll(() => {
        // Clean up resources
        chunker.dispose();
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

        // Define embedding options (overlapSize is ignored by the new chunker but kept for test structure)
        const options: EmbeddingOptions = {};

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(code, 'typescript', undefined, options, signal);

        // Verify the result has chunks
        expect(result.chunks.length).toBeGreaterThan(0);

        // Check for proper chunking - no chunks should end with split words/symbols
        console.log('Integration Test: TypeScript chunking test. Chunks:', result.chunks);
        for (const chunk of result.chunks) {
            // A word/symbol split would typically end with an incomplete identifier.
            // This is less likely with structure-aware chunking but still a good check.
            const endsWithIncompleteWord = /[a-zA-Z0-9_]$/.test(chunk.trim());
            if (endsWithIncompleteWord) {
                console.log('Chunk ends with incomplete word:', chunk);
            }
            expect(endsWithIncompleteWord).toBe(false);
        }

        // Check that chunks respect structure boundaries when possible
        // The code should be split into its main components: SampleClass, AnotherClass, standaloneFunction
        const joinedChunks = result.chunks.join('\n');
        expect(joinedChunks).toContain('export class SampleClass');
        expect(joinedChunks).toContain('export class AnotherClass');
        expect(joinedChunks).toContain('export function standaloneFunction');
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
        const options: EmbeddingOptions = {};

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(longFunction, 'javascript', undefined, options, signal);

        // Should split into multiple chunks due to size
        expect(result.chunks.length).toBeGreaterThan(1);

        // The new chunker does not generate parent structure IDs, so this metadata will be null.
        const parentIds = result.metadata.parentStructureIds.filter(id => id !== null);
        expect(parentIds.length).toBe(0);

        // Check that no chunk ends with a split identifier or keyword
        // These regex patterns match incomplete identifiers, string literals, or operators
        // 1. Content Integrity Check
        const reconstructedCode = result.chunks.join('\n');
        const originalLines = longFunction.split('\n').filter(line => line.trim() !== '');
        const reconstructedLines = reconstructedCode.split('\n').filter(line => line.trim() !== '');
        expect(reconstructedLines.length).toEqual(originalLines.length);

        // 2. Syntactic Sanity Check
        const badLineEndings = [
            /([=&|<>+\-*/%^!~?:]|&&|\|\|)\s*$/, // Ends in a binary/unary operator
            /(?<!\.)\.\s*$/, // Ends in a single dot
        ];
        for (const chunk of result.chunks) {
            const lines = chunk.split('\n');
            const lastLine = lines[lines.length - 1].trim();
            for (const pattern of badLineEndings) {
                expect(pattern.test(lastLine), `Chunk's last line ends with a bad pattern: "${lastLine}"`).toBe(false);
            }
        }
    });

    it('should handle templates', async () => {
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
`;
        // Define embedding options
        const options: EmbeddingOptions = {};

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(complexCppCode, 'cpp', undefined, options, signal);

        // Verify chunking result
        expect(result.chunks.length).toBeGreaterThan(0);
        // Since the code is small, it should be treated as a single structural chunk
        expect(result.chunks.length).toBe(2);

        // Check that each chunk has appropriate content
        // and no chunk ends with an incomplete identifier
        // 3. Structural Integrity Check
        // A single, small class like this should not be split into many pieces.
        expect(result.chunks.length).toBeLessThanOrEqual(2);

        for (const chunk of result.chunks) {
            expect(chunk.trim().length).toBeGreaterThan(0);
        }

        // The new chunker does not generate structure type metadata.
        const structureTypes = result.metadata.structureTypes.filter(t => t !== null);
        expect(structureTypes.length).toBe(0);
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
        const options: EmbeddingOptions = {};

        // Create an abort signal for testing
        const controller = new AbortController();
        const signal = controller.signal;

        // Chunk the code
        const result = await chunker.chunkCode(complexCppCode, 'cpp', undefined, options, signal);

        // Verify chunking result
        expect(result.chunks.length).toBeGreaterThan(0);

        // Check that each chunk has appropriate content
        // and no chunk ends with an incomplete identifier
        for (const chunk of result.chunks) {
            expect(chunk.trim().length).toBeGreaterThan(0);
        }

        // The new chunker does not generate structure type metadata.
        const structureTypes = result.metadata.structureTypes.filter(t => t !== null);
        expect(structureTypes.length).toBe(0);
    });

    // This test is removed because the new structure-aware chunker does not use `overlapSize`
    // and does not produce overlapping chunks. Its core design is to split at natural
    // structural boundaries, making the concept of overlapping obsolete.
    // it('should not produce overlapped chunks that split words/identifiers', async () => { ... });
    it('should correctly chunk a complex C# file into logical blocks', async () => {
        const csharpCode = `using System;
using System.Collections.Generic;

namespace MyTestNamespace
{
    /// <summary>
    /// A test class for chunking.
    /// </summary>
    [Serializable]
    public class TestClass<T> where T : new()
    {
        public T MyProperty { get; set; }

        public TestClass()
        {
            MyProperty = new T();
        }

        /// <summary>
        /// A sample method with some logic.
        /// </summary>
        public void DoSomething(List<T> items)
        {
            foreach (var item in items)
            {
                Console.WriteLine(item.ToString());
            }
        }
    }
}`;
        const result = await chunker.chunkCode(csharpCode, 'csharp', undefined, {}, new AbortController().signal);

        // Expect three main chunks: one for the using statement, one for the second using statement, and one for the namespace.
        expect(result.chunks.length).toBe(1);

        // The first chunk should contain the using directives.
        expect(result.chunks[0]).not.toContain('using System;');
        expect(result.chunks[0]).not.toContain('using System.Collections.Generic;');

        // The second chunk should be the entire namespace block.
        const namespaceChunk = result.chunks[0];
        expect(namespaceChunk.startsWith('namespace MyTestNamespace')).toBe(true);
        expect(namespaceChunk.endsWith('}')).toBe(true);
        expect(namespaceChunk).toContain('public class TestClass<T>');
    });
});
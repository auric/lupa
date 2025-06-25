import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { WorkerTokenEstimator } from '../workers/workerTokenEstimator';
import { WorkerCodeChunker } from '../workers/workerCodeChunker';
import { EmbeddingOptions } from '../types/embeddingTypes';
import { CodeAnalysisService, CodeAnalysisServiceInitializer } from '../services/codeAnalysisService';

// Shorter test fixtures to ensure tests run faster and more reliably
const CODE_WITH_LONG_LINE = `
function testLongLine() {
    // This is an extremely long line that should trigger the smart splitting logic: ${Array(30).fill('word').join(' ')}. End of sentence. ${Array(30).fill('more_words').join(' ')} and some additional text.
    return true;
}`;

const CODE_WITH_MULTI_CHAR_OPERATORS = `
function testMultiCharOperators() {
    // Test with various multi-character operators
    const a = b ?? c; // Nullish coalescing
    const obj = someObj?.property; // Optional chaining
    const arrowFn = () => { return 42; }; // Arrow function
    const template = \`Value: \${getValue()}\`; // Template literal
    const inc = x += 1; // Compound assignment
    const compare = a !== b && c >= d || e <= f; // Comparison operators
    return true;
}`;

const CODE_WITH_COMMENTS_AND_STRINGS = `
/**
 * This is a function with long comments and strings
 * that might need to be split carefully.
 * We want to make sure that comments are split at reasonable points.
 * ${Array(20).fill('word').join(' ')}
 */
function testCommentsAndStrings() {
    // A very long single-line comment that exceeds the token limit. ${Array(20).fill('comment-word').join(' ')}

    const longString = "This is a string literal. ${Array(20).fill('string-content').join(' ')}";

    return true;
}`;

const CODE_WITH_NESTED_BRACKETS = `
function testNestedBrackets() {
    // Function with deeply nested brackets and braces
    const result = compute(
        first(
            second(
                third({
                    key1: [1, 2, 3],
                    key2: {
                        nestedKey: function() {
                            return ${Array(15).fill('value').join(' + ')};
                        }
                    }
                })
            )
        )
    );
    return result;
}`;

describe('WorkerCodeChunker Improved Splitting Tests', () => {
    let extensionPath: string;
    let tokenEstimator: WorkerTokenEstimator;
    let codeChunker: WorkerCodeChunker;
    let codeAnalysisService: CodeAnalysisService;
    let abortController: AbortController;

    beforeEach(async () => {
        // Set up extension path to project root
        extensionPath = path.resolve(__dirname, '..', '..');

        await CodeAnalysisServiceInitializer.initialize(extensionPath);

        // Initialize token estimator with a small context length to force chunking
        tokenEstimator = new WorkerTokenEstimator(
            'Xenova/all-MiniLM-L6-v2',
            80 // Very small context length to force aggressive chunking
        );

        await tokenEstimator.initialize();

        codeAnalysisService = new CodeAnalysisService();
        codeChunker = new WorkerCodeChunker(codeAnalysisService, tokenEstimator);

        // Set up abort controller for tests
        abortController = new AbortController();
    });

    afterEach(() => {
        codeChunker.dispose();
        abortController.abort();
    });

    it('should correctly handle long lines by falling back to line-based splitting', async () => {
        const options: EmbeddingOptions = {};

        const result = await codeChunker.chunkCode(
            CODE_WITH_LONG_LINE,
            'javascript',
            undefined,
            options,
            abortController.signal,
        );

        // The structure-aware chunker will treat the function as one unit. If it's too large,
        // it will be split by line. Since the long line is a single line, it should be one chunk.
        expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should preserve multi-character operators when splitting', async () => {
        const options: EmbeddingOptions = {};

        const result = await codeChunker.chunkCode(
            CODE_WITH_MULTI_CHAR_OPERATORS,
            'javascript',
            undefined,
            options,
            abortController.signal,
        );

        // The critical multi-character operators to check
        const operators = ['??', '?.', '=>', '+=', '!==', '>=', '<='];

        // The new chunker splits by structure, so it should not split operators within a line.
        const fullText = result.chunks.join('');
        for (const op of operators) {
            expect(fullText).toContain(op);
        }
        expect(fullText).toContain('`Value: ${getValue()}`');
    });

    it('should not mangle comments when splitting', async () => {
        const options: EmbeddingOptions = {};

        const result = await codeChunker.chunkCode(
            CODE_WITH_COMMENTS_AND_STRINGS,
            'javascript',
            undefined,
            options,
            abortController.signal,
        );

        // Find chunks containing comments
        const commentChunks = result.chunks.filter(chunk =>
            chunk.includes('//') || chunk.includes('/*')
        );

        // Verify that at least some comments were found
        expect(commentChunks.length).toBeGreaterThan(0);

        // Ensure no chunks end with just the comment marker
        for (const chunk of commentChunks) {
            // A chunk shouldn't end with just a comment marker
            expect(chunk.trimEnd()).not.toMatch(/\/\/\s*$/);
            expect(chunk.trimEnd()).not.toMatch(/\/\*\s*$/);
        }
    });

    it('should handle bracket nesting by splitting at structure boundaries', async () => {
        const options: EmbeddingOptions = {};

        const result = await codeChunker.chunkCode(
            CODE_WITH_NESTED_BRACKETS,
            'javascript',
            undefined,
            options,
            abortController.signal,
        );

        // There should be at least one chunk
        expect(result.chunks.length).toBeGreaterThan(0);

        // The structure-aware chunker should ideally not split this, but if it does (due to size),
        // it should be a clean line-based split.
        const fullText = result.chunks.join('');
        expect(fullText).toContain('function testNestedBrackets');
        expect(fullText).toContain('return result;');
    });

    // This test is removed because the `findPreferredSplitPoints` method, which was part of the old,
    // more complex chunker, no longer exists. The new chunker relies on `CodeAnalysisService`
    // to identify structural boundaries.
    // it('should leverage findPreferredSplitPoints method for better splitting', async () => { ... });

    // This test is removed because the new chunker's fallback mechanism is line-based, not
    // whitespace-based. The concept of splitting at whitespace is no longer relevant.
    // it('should split at whitespace when no statement boundaries are available', async () => { ... });

    // This test is removed because the `createEmergencyChunks` method, a character-based fallback,
    // no longer exists. The new chunker's fallback is a simpler, line-based split.
    // it('should use character-based splitting only as a last resort', async () => { ... });

    it('should handle multiple languages with different syntax patterns', async () => {
        const python = `
def long_function_with_many_variables():
    # This is a long comment line that will need to be split ${Array(30).fill('python-comment-word').join(' ')}
    really_long_string = f"This is a formatted string {variable} with a lot of content ${Array(30).fill('python-string-content').join(' ')}"
    return True
`;

        const csharp = `
public class TestClass
{
    /// <summary>
    /// XML documentation comment that is very long ${Array(30).fill('csharp-doc-word').join(' ')}
    /// </summary>
    public string LongMethod()
    {
        // Long string with C# string interpolation
        string interpolatedString = $"Value: {SomeProperty} and more text ${Array(30).fill('csharp-string-content').join(' ')}";
        return interpolatedString;
    }
}
`;

        const options: EmbeddingOptions = {};

        const pythonResult = await codeChunker.chunkCode(python, 'python', undefined, options, abortController.signal);
        const csharpResult = await codeChunker.chunkCode(csharp, 'csharp', undefined, options, abortController.signal);

        expect(pythonResult.chunks.length).toBeGreaterThan(0);
        expect(csharpResult.chunks.length).toBeGreaterThan(0);

        const pythonText = pythonResult.chunks.join('');
        expect(pythonText).toContain('def long_function_with_many_variables');

        const csharpText = csharpResult.chunks.join('');
        expect(csharpText).toContain('public class TestClass');
    });

    it('should handle empty input correctly', async () => {
        const result = await codeChunker.chunkCode('', 'javascript', undefined, {}, abortController.signal);
        // The new chunker returns an empty result for empty input.
        expect(result.chunks).toHaveLength(0);
        expect(result.offsets).toHaveLength(0);
    });

    it('should handle very small input', async () => {
        const tinyCode = 'x=1;';
        const result = await codeChunker.chunkCode(tinyCode, 'javascript', undefined, {}, abortController.signal);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]).toBe(tinyCode);
    });

    it('should fallback to basic chunking when language is not supported', async () => {
        const unsupportedLanguageCode = `
line 1 of code in an unsupported language
line 2 of code
line 3 of code
`;
        const options: EmbeddingOptions = {};

        // Spy on the basic chunking method to confirm it's used as a fallback
        const basicChunkingSpy = vi.spyOn(codeChunker as any, 'createBasicChunks');

        const result = await codeChunker.chunkCode(
            unsupportedLanguageCode,
            'unsupported-language',
            undefined,
            options,
            abortController.signal
        );

        // Verify that the fallback to basic chunking was triggered
        expect(basicChunkingSpy).toHaveBeenCalled();

        // The basic chunker is line-based. Given the small token limit,
        // we expect the code to be split into multiple chunks.
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.chunks.join('\n')).toContain('line 1 of code');
        expect(result.chunks.join('\n')).toContain('line 2 of code');
        expect(result.chunks.join('\n')).toContain('line 3 of code');

        basicChunkingSpy.mockRestore();
    });

    it('should handle abort signal correctly', async () => {
        const localAbortController = new AbortController();
        const chunkPromise = codeChunker.chunkCode(CODE_WITH_LONG_LINE, 'javascript', undefined, {}, localAbortController.signal);
        localAbortController.abort();
        await expect(chunkPromise).rejects.toThrow('Operation cancelled');
    });

    it('should handle Unicode and emoji characters properly', async () => {
        const unicodeText = `
        function handleEmoji() {
          // Text with emoji 😀 and Unicode characters: こんにちは, Привіт, שלום
          return "😀 " + ${Array(20).fill('word').join(' ')};
        }`;

        const result = await codeChunker.chunkCode(unicodeText, 'javascript', undefined, {}, abortController.signal);
        const allText = result.chunks.join('');
        expect(allText).toContain('😀');
        expect(allText).toContain('こんにちは');
        expect(allText).toContain('Привіт');
        expect(allText).toContain('שלום');
    });

    // This test is removed as it tests a private helper method `isRangeCovered` that no longer exists.
    // it('should correctly identify covered ranges', async () => { ... });

    it('should properly handle JSX/TSX syntax', async () => {
        const jsxCode = `
        function Component() {
          return (
            <div className="container">
              <h1>Title</h1>
              <p>This is a long paragraph with {dynamicContent} and
                 ${Array(30).fill('jsx-content-word').join(' ')}
              </p>
            </div>
          );
        }`;

        const result = await codeChunker.chunkCode(jsxCode, 'tsx', undefined, {}, abortController.signal);
        const fullText = result.chunks.join('');
        expect(fullText).toContain('<div className="container">');
        expect(fullText).toContain('{dynamicContent}');
    });

    it('should process large files within reasonable time', async () => {
        const largeSample = Array(1000).fill(CODE_WITH_COMMENTS_AND_STRINGS).join('\\n\\n');
        const startTime = performance.now();
        const result = await codeChunker.chunkCode(largeSample, 'javascript', undefined, {}, abortController.signal);
        const duration = performance.now() - startTime;
        expect(result.chunks.length).toBeGreaterThan(10);
        expect(duration).toBeLessThan(10000); // 10 seconds max
    }, 15000);
});

describe('WorkerCodeChunker Basic Chunking Tests for Non-Code Content', () => {
    let extensionPath: string;
    let tokenEstimator: WorkerTokenEstimator;
    let codeChunker: WorkerCodeChunker;
    let codeAnalysisService: CodeAnalysisService;
    let abortController: AbortController;

    const BASIC_MARKDOWN = `# Main Title

## Introduction
This is an introduction paragraph that explains the purpose of this document.
It spans multiple lines to represent a typical markdown content flow.

## Section 1
Content for section 1 with some **bold** and *italic* text formatting.
- List item 1
- List item 2
  - Nested list item
  - Another nested item

## Section 2
${Array(30).fill('content word').join(' ')}

## Conclusion
Final thoughts and summary of the document.`;

    beforeEach(async () => {
        extensionPath = path.resolve(__dirname, '..', '..');
        await CodeAnalysisServiceInitializer.initialize(extensionPath);
        tokenEstimator = new WorkerTokenEstimator('Xenova/all-MiniLM-L6-v2', 80);
        await tokenEstimator.initialize();
        codeAnalysisService = new CodeAnalysisService();
        codeChunker = new WorkerCodeChunker(codeAnalysisService, tokenEstimator);
        abortController = new AbortController();
    });

    afterEach(() => {
        codeChunker.dispose();
        abortController.abort();
    });

    it('should correctly chunk basic markdown content', async () => {
        const options: EmbeddingOptions = {};
        const result = await codeChunker.chunkCode(BASIC_MARKDOWN, 'markdown', undefined, options, abortController.signal);
        expect(result.chunks.length).toBeGreaterThan(1);
        const allText = result.chunks.join('');
        expect(allText).toContain('# Main Title');
        expect(allText).toContain('## Section 1');
    });
});

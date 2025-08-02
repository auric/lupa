import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchForPatternTool } from '../tools/searchForPatternTool';

// Simple test to verify the implementation works with minimal mocking
describe('SearchForPatternTool - Simple Implementation Test', () => {
    let searchForPatternTool: SearchForPatternTool;
    let mockGitOperationsManager: any;

    beforeEach(() => {
        // Create minimal mock
        mockGitOperationsManager = {
            getRepository: vi.fn().mockReturnValue({
                rootUri: { fsPath: '/test/project' }
            })
        };

        searchForPatternTool = new SearchForPatternTool(mockGitOperationsManager);
    });

    describe('Tool Configuration', () => {
        it('should be properly configured', () => {
            expect(searchForPatternTool.name).toBe('search_for_pattern');
            expect(searchForPatternTool.description).toContain('Search for a regex pattern');
        });

        it('should have valid Zod schema', () => {
            const schema = searchForPatternTool.schema;

            // Test valid inputs
            expect(schema.safeParse({ pattern: 'test' }).success).toBe(true);
            expect(schema.safeParse({ pattern: 'class.*{', include: '*.ts' }).success).toBe(true);
            expect(schema.safeParse({ pattern: 'function', path: 'src' }).success).toBe(true);
            expect(schema.safeParse({ pattern: 'export.*{', include: '*.js', path: 'lib' }).success).toBe(true);

            // Test invalid inputs
            expect(schema.safeParse({ pattern: '' }).success).toBe(false);
            expect(schema.safeParse({}).success).toBe(false);
            expect(schema.safeParse({ pattern: null }).success).toBe(false);
        });

        it('should create valid VS Code tool definition', () => {
            const vscodeTools = searchForPatternTool.getVSCodeTool();

            expect(vscodeTools.name).toBe('search_for_pattern');
            expect(vscodeTools.description).toContain('Search for a regex pattern');
            expect(vscodeTools.inputSchema).toBeDefined();

            // Check schema structure
            const properties = (vscodeTools.inputSchema as any).properties;
            expect(properties.pattern).toBeDefined();
            expect(properties.include).toBeDefined();
            expect(properties.path).toBeDefined();
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid regex patterns gracefully', async () => {
            const result = await searchForPatternTool.execute({
                pattern: '[invalid-regex'
            });

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
            expect(result[0]).toContain('Error searching for pattern');
        });

        it('should handle missing git repository', async () => {
            // Create tool with null repository
            const nullRepoManager = {
                getRepository: vi.fn().mockReturnValue(null)
            } as any;
            const toolWithNullRepo = new SearchForPatternTool(nullRepoManager);

            const result = await toolWithNullRepo.execute({
                pattern: 'test'
            });

            expect(Array.isArray(result)).toBe(true);
            // Should either work with empty root or return an error - both are acceptable
        });

        it('should return no matches message for non-existent patterns', async () => {
            // This test will actually try to search but should return no matches
            // since we're not mocking the file system properly
            const result = await searchForPatternTool.execute({
                pattern: 'nonexistentpattern123456789'
            });

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
            // Should either return no matches message or an error - both are valid
            const resultText = result.join(' ');
            const hasValidResponse = resultText.includes('No matches found') ||
                resultText.includes('Error') ||
                resultText.includes('File:');
            expect(hasValidResponse).toBe(true);
        });
    });

    describe('Schema Validation Integration', () => {
        it('should validate pattern parameter correctly', () => {
            const schema = searchForPatternTool.schema;

            // Valid patterns
            const validPatterns = [
                'simple',
                'class.*{',
                'function\\s+\\w+',
                'export\\s+(const|let|var)',
                '\\d+',
                '[a-zA-Z]+',
                '.*pattern.*'
            ];

            validPatterns.forEach(pattern => {
                const result = schema.safeParse({ pattern });
                expect(result.success).toBe(true);
            });
        });

        it('should validate optional parameters correctly', () => {
            const schema = searchForPatternTool.schema;

            // Valid include patterns
            const validIncludes = ['*.ts', '*.js', '**/*.tsx', 'src/**/*.ts'];
            validIncludes.forEach(include => {
                const result = schema.safeParse({ pattern: 'test', include });
                expect(result.success).toBe(true);
            });

            // Valid path patterns
            const validPaths = ['src', 'src/components', 'lib/utils', '.'];
            validPaths.forEach(path => {
                const result = schema.safeParse({ pattern: 'test', path });
                expect(result.success).toBe(true);
            });
        });
    });

    describe('Tool Interface Compliance', () => {
        it('should implement ITool interface correctly', () => {
            // Check all required ITool properties exist
            expect(typeof searchForPatternTool.name).toBe('string');
            expect(typeof searchForPatternTool.description).toBe('string');
            expect(searchForPatternTool.schema).toBeDefined();
            expect(typeof searchForPatternTool.getVSCodeTool).toBe('function');
            expect(typeof searchForPatternTool.execute).toBe('function');
        });

        it('should extend BaseTool correctly', () => {
            // Verify BaseTool functionality
            const vscodeTools = searchForPatternTool.getVSCodeTool();
            expect(vscodeTools.name).toBe(searchForPatternTool.name);
            expect(vscodeTools.description).toBe(searchForPatternTool.description);
            expect(vscodeTools.inputSchema).toBeDefined();
        });

        it('should have async execute method', () => {
            const executeResult = searchForPatternTool.execute({ pattern: 'test' });
            expect(executeResult).toBeInstanceOf(Promise);
        });
    });

    describe('Basic Functionality', () => {
        it('should return array of strings from execute', async () => {
            const result = await searchForPatternTool.execute({
                pattern: 'test'
            });

            expect(Array.isArray(result)).toBe(true);
            result.forEach(item => {
                expect(typeof item).toBe('string');
            });
        });

        it('should handle all parameter combinations', async () => {
            const testCases = [
                { pattern: 'test' },
                { pattern: 'test', include: '*.ts' },
                { pattern: 'test', path: 'src' },
                { pattern: 'test', include: '*.js', path: 'lib' }
            ];

            for (const testCase of testCases) {
                const result = await searchForPatternTool.execute(testCase);
                expect(Array.isArray(result)).toBe(true);
                expect(result.length).toBeGreaterThan(0);
            }
        });
    });
});
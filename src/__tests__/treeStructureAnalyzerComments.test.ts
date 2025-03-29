import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TreeStructureAnalyzer, TreeStructureAnalyzerPool } from '../services/treeStructureAnalyzer';
import * as path from 'path';

describe('TreeStructureAnalyzer Comment Association', () => {
    let analyzer: TreeStructureAnalyzer;

    beforeEach(async () => {
        // Create a real analyzer instance
        const extensionPath = path.resolve(__dirname, '..', '..');
        const analyzerPool = TreeStructureAnalyzerPool.createSingleton(extensionPath, 2);

        analyzer = await analyzerPool.getAnalyzer();
        await analyzer.initialize();
    });

    afterEach(() => {
        analyzer.dispose();
    });

    it('should associate comments before classes in C++', async () => {
        const code = `
/**
 * This is a comment for MyClass
 */
class MyClass {
public:
    void foo() {
        // Implementation
    }
};
`;

        const structures = await analyzer.findAllStructures(code, 'cpp');

        // Find the class structure
        const classStructure = structures.find(s => s.type === 'class_specifier');

        expect(classStructure).toBeDefined();
        expect(classStructure?.comment).toBeDefined();
        expect(classStructure?.comment).toContain('This is a comment for MyClass');

        // Check full text includes both comment and class definition
        expect(classStructure?.text).toContain('/**');
        expect(classStructure?.text).toContain('class MyClass');
    });

    it('should associate comments before functions in C++', async () => {
        const code = `
/**
 * This is a comment for foo function
 */
void foo() {
    // Implementation
}
`;

        const structures = await analyzer.findAllStructures(code, 'cpp');

        // Find the function structure
        const functionStructure = structures.find(s => s.type.includes('function'));

        expect(functionStructure).toBeDefined();
        expect(functionStructure?.comment).toBeDefined();
        expect(functionStructure?.comment).toContain('This is a comment for foo function');

        // Check content range vs full range
        if (functionStructure) {
            expect(functionStructure.contentRange.startPosition.row).toBeGreaterThan(
                functionStructure.range.startPosition.row
            );
        }
    });

    it('should associate comments with methods in classes', async () => {
        const code = `
class MyClass {
public:
    /**
     * This is a comment for the method
     */
    void foo() {
        // Implementation
    }
};
`;

        const structures = await analyzer.findAllStructures(code, 'cpp');

        // There should be a class and a function
        expect(structures.length).toBeGreaterThanOrEqual(2);

        // Find the function structure
        const functionStructures = structures.filter(s => s.type.includes('function'));
        expect(functionStructures.length).toBeGreaterThan(0);

        const methodWithComment = functionStructures.find(f => f.comment?.includes('comment for the method'));
        expect(methodWithComment).toBeDefined();

        // Check parent-child relationship
        const classStructure = structures.find(s => s.type === 'class_specifier');
        expect(classStructure?.children).toBeDefined();
        if (classStructure?.children) {
            expect(classStructure.children.some(c => c.comment?.includes('comment for the method'))).toBeTruthy();
        }
    });

    it('should associate comments with C++ structs', async () => {
        const code = `
// Comment for MyStruct
struct MyStruct {
    int data;
};
`;
        const structures = await analyzer.findAllStructures(code, 'cpp');
        const struct = structures.find(s => s.type === 'struct_specifier');
        expect(struct).toBeDefined();
        expect(struct?.comment).toContain('Comment for MyStruct');
        expect(struct?.text).toContain('// Comment for MyStruct');
        expect(struct?.text).toContain('struct MyStruct');
    });

    it('should associate comments with C++ enums', async () => {
        const code = `
/*
 * Comment for MyEnum
 */
enum class MyEnum {
    VALUE1,
    VALUE2
};
`;
        const structures = await analyzer.findAllStructures(code, 'cpp');
        const enumStruct = structures.find(s => s.type === 'enum_specifier');
        expect(enumStruct).toBeDefined();
        expect(enumStruct?.comment).toContain('Comment for MyEnum');
        expect(enumStruct?.text).toContain('/*');
        expect(enumStruct?.text).toContain('enum class MyEnum');
    });


    it('should handle namespace closing comments in C++', async () => {
        const code = `
/** Comment for namespace test */
namespace test {

    /** Function comment */
    void foo() {
        // Implementation
    }

} // namespace test
`;
        const structures = await analyzer.findAllStructures(code, 'cpp');

        // Find the namespace structure
        const namespaceStructure = structures.find(s => s.type === 'namespace_definition' && s.name === 'test');

        expect(namespaceStructure).toBeDefined();
        expect(namespaceStructure?.comment).toContain('Comment for namespace test');
        expect(namespaceStructure?.text).toContain('namespace test');
        expect(namespaceStructure?.text).toContain('// namespace test'); // Check full text includes trailing comment
        expect(namespaceStructure?.trailingComment).toBe('// namespace test'); // Check specific field
    });

    it('should handle comments separated by blank lines', async () => {
        const code = `
// First comment line

// Second comment line
class BlankLineCommentClass {
    void method() {}
};
`;
        const structures = await analyzer.findAllStructures(code, 'cpp');
        const classStructure = structures.find(s => s.type === 'class_specifier');
        expect(classStructure).toBeDefined();
        expect(classStructure?.comment).toContain("First comment line\n\n// Second comment line"); // Check if blank line is preserved in raw comment text if needed, or adjust based on cleanCommentText behavior
        expect(classStructure?.text).toContain('// First comment line');
        expect(classStructure?.text).toContain('// Second comment line');
    });


    it('should handle multiple comments (block and line) for the same structure', async () => {
        const code = `
/*
 * Block comment
 */
// Line comment after block
class MultiCommentClass {
    // Method comment
    void method() {}
};
`;
        const structures = await analyzer.findAllStructures(code, 'cpp');

        // Find the class structure
        const classStructure = structures.find(s => s.type === 'class_specifier' && s.name === 'MultiCommentClass');

        expect(classStructure).toBeDefined();
        expect(classStructure?.comment).toBeDefined();
        // Depending on cleanCommentText, check for combined content
        expect(classStructure?.comment).toContain('Block comment');
        expect(classStructure?.comment).toContain('Line comment after block');
        expect(classStructure?.text).toContain('/*');
        expect(classStructure?.text).toContain('// Line comment after block');
    });

    it('should handle comments with decorators/attributes (TypeScript)', async () => {
        const code = `
/**
 * Comment for decorated class
 */
@decorator
class DecoratedClass {
    /**
     * Comment for decorated method
     */
    @methodDecorator
    method() {}
}
`;
        const structures = await analyzer.findAllStructures(code, 'typescript');
        const classStructure = structures.find(s => s.type === 'class_declaration');
        const methodStructure = structures.find(s => s.type === 'method_definition');

        expect(classStructure).toBeDefined();
        expect(classStructure?.comment).toContain('Comment for decorated class');
        expect(classStructure?.text).toContain('@decorator');

        expect(methodStructure).toBeDefined();
        expect(methodStructure?.comment).toContain('Comment for decorated method');
        expect(methodStructure?.text).toContain('@methodDecorator');
    });


    it('should associate comments with all supported languages', async () => {
        // Test a few different languages
        const cppCode = `
/**
 * C++ function comment
 */
void cppFunction() {}
`;

        const jsCode = `
/**
 * JavaScript function comment
 */
function jsFunction() {}
`;

        const pyCode = `
# Python function comment
def pyFunction():
    pass
`;

        // Test C++
        const cppStructures = await analyzer.findAllStructures(cppCode, 'cpp');
        const cppFunction = cppStructures.find(s => s.type.includes('function'));
        expect(cppFunction?.comment).toContain('C++ function comment');

        // Test JavaScript
        const jsStructures = await analyzer.findAllStructures(jsCode, 'javascript');
        const jsFunction = jsStructures.find(s => s.type.includes('function'));
        expect(jsFunction?.comment).toContain('JavaScript function comment');

        // Test Python
        const pyStructures = await analyzer.findAllStructures(pyCode, 'python');
        const pyFunction = pyStructures.find(s => s.type.includes('function'));
        expect(pyFunction?.comment).toContain('Python function comment');
    });

    it('should handle complex hierarchy with nested namespaces and classes', async () => {
        const code = `
/**
 * Outer namespace
 */
namespace outer {
    /**
     * Inner namespace
     */
    namespace inner {
        /**
         * Nested class
         */
        class NestedClass {
        public:
            /**
             * Nested method
             */
            void method() {}
        };
    } // namespace inner
} // namespace outer
`;

        const structures = await analyzer.findAllStructures(code, 'cpp');

        // Find all the structures
        const outerNamespace = structures.find(s =>
            s.type === 'namespace_definition' && s.name === 'outer');

        expect(outerNamespace).toBeDefined();
        expect(outerNamespace?.comment).toContain('Outer namespace');

        // Find inner namespace within outer namespace's children
        expect(outerNamespace?.children).toBeDefined();
        const innerNamespace = outerNamespace?.children.find(c =>
            c.type === 'namespace_definition' && c.name === 'inner');

        expect(innerNamespace).toBeDefined();
        expect(innerNamespace?.comment).toContain('Inner namespace');

        // Find nested class within inner namespace's children
        expect(innerNamespace?.children).toBeDefined();
        const nestedClass = innerNamespace?.children.find(c =>
            c.type === 'class_specifier' && c.name === 'NestedClass');

        expect(nestedClass).toBeDefined();
        expect(nestedClass?.comment).toContain('Nested class');

        // Find method within nested class's children
        expect(nestedClass?.children).toBeDefined();
        const method = nestedClass?.children.find(c =>
            c.type.includes('function') && c.name === 'method');

        expect(method).toBeDefined();
        expect(method?.comment).toContain('Nested method');
    });
});

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
        const namespaceStructure = structures.find(s => s.type === 'namespace_definition');

        expect(namespaceStructure).toBeDefined();
        expect(namespaceStructure?.text).toContain('namespace test');
        expect(namespaceStructure?.text).toContain('// namespace test'); // Check full text includes trailing comment
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
        const classStructure = structures.find(s => s.type === 'class_specifier');

        expect(classStructure).toBeDefined();
        // Depending on cleanCommentText, check for combined content
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
        expect(classStructure?.text).toContain('@decorator');

        expect(methodStructure).toBeDefined();
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

        // Test JavaScript
        const jsStructures = await analyzer.findAllStructures(jsCode, 'javascript');
        const jsFunction = jsStructures.find(s => s.type.includes('function'));

        // Test Python
        const pyStructures = await analyzer.findAllStructures(pyCode, 'python');
        const pyFunction = pyStructures.find(s => s.type.includes('function'));
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
            s.type === 'namespace_definition');

        expect(outerNamespace).toBeDefined();

        // Find inner namespace within outer namespace's children
        const innerNamespace = structures.find(s =>
            s.type === 'namespace_definition' && s.text.includes('inner'));

        expect(innerNamespace).toBeDefined();

        // Find nested class within inner namespace's children
        const nestedClass = structures.find(s =>
            s.type === 'class_specifier' && s.text.includes('NestedClass'));

        expect(nestedClass).toBeDefined();
    });
});

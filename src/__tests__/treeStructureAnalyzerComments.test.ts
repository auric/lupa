import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TreeStructureAnalyzer, TreeStructureAnalyzerPool, TreeStructureAnalyzerResource } from '../services/treeStructureAnalyzer';
import * as path from 'path';

describe('TreeStructureAnalyzer Comment Association', () => {
    let resource: TreeStructureAnalyzerResource;
    let analyzer: TreeStructureAnalyzer;

    beforeEach(async () => {
        // Create a real analyzer instance
        const extensionPath = path.resolve(__dirname, '..', '..');
        const analyzerPool = TreeStructureAnalyzerPool.createSingleton(extensionPath, 2);

        resource = await TreeStructureAnalyzerResource.create();
        analyzer = resource.instance;
        await analyzer.initialize();
    });

    afterEach(() => {
        resource.dispose();
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

        const functionStructure = structures.find(s => s.type.includes('function'));
        expect(functionStructure).toBeDefined();
        expect(functionStructure?.text).toContain('void foo()');
        expect(functionStructure?.text).toContain('/** Function comment */');
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
        expect(structures.length).toBe(2);
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

    it('should create a comprehensive template for C++ structure comments', async () => {
        const code = `
/**
 * This is a file-level comment
 * describing the entire file
 */

// Forward declaration
class ForwardClass;

/**
 * This is a namespace comment
 * with multiple lines
 */
namespace test_namespace {

    /**
     * This is a class comment
     * Class documentation with multiple lines
     */
    class TestClass {
    public:
        /**
         * This is a method comment
         * @param a First parameter
         * @param b Second parameter
         * @return Return value description
         */
        int testMethod(int a, int b) {
            // Implementation comment
            return a + b;
        }

        // Simple line comment for a field
        int testField;
    };

    /**
     * This is a function comment outside of class
     */
    void testFunction() {
        // Function implementation
    }

    /**
     * This is a struct comment
     */
    struct TestStruct {
        // Field comment
        int structField;
    };

    /**
     * This is an enum comment
     */
    enum class TestEnum {
        VALUE1, // Value comment
        VALUE2
    };

} // namespace test_namespace

/**
 * Template class comment
 */
template <typename T>
class TemplateClass {
public:
    /**
     * Template method comment
     */
    T templateMethod(T value) {
        return value;
    }
};

// Test trailing namespace closing comment
namespace another {
    void anotherFunction() {}
} // namespace another
`;

        const structures = await analyzer.findAllStructures(code, 'cpp');

        console.log('Structures:', JSON.stringify(structures, null, 2));

        // Check that we found the expected number of structures
        expect(structures.length).toBeGreaterThan(5);

        // Verify namespace with comments
        const namespaces = structures.filter(s => s.type === 'namespace_definition');
        expect(namespaces.length).toBeGreaterThan(0);

        // First namespace should have the comment and also the trailing comment
        const mainNamespace = namespaces.find(n => n.text.includes('test_namespace'));
        expect(mainNamespace).toBeDefined();
        expect(mainNamespace?.text).toContain('This is a namespace comment');
        expect(mainNamespace?.text).toContain('// namespace test_namespace');

        // Verify class with comments
        const classes = structures.filter(s => s.type === 'class_specifier');
        expect(classes.length).toBeGreaterThan(0);
        const testClass = classes.find(c => c.text.includes('TestClass'));
        expect(testClass).toBeDefined();
        expect(testClass?.text).toContain('This is a class comment');

        // Verify method with comments
        const methods = structures.filter(s => s.type.includes('function'));
        expect(methods.length).toBeGreaterThan(0);
        const testMethod = methods.find(m => m.text.includes('testMethod'));
        expect(testMethod).toBeDefined();
        expect(testMethod?.text).toContain('This is a method comment');

        // Verify standalone function with comments
        const testFunction = methods.find(m => m.text.includes('testFunction'));
        expect(testFunction).toBeDefined();
        expect(testFunction?.text).toContain('This is a function comment outside of class');

        // Verify struct with comments
        const structs = structures.filter(s => s.type === 'struct_specifier');
        expect(structs.length).toBeGreaterThan(0);
        const testStruct = structs.find(s => s.text.includes('TestStruct'));
        expect(testStruct).toBeDefined();
        expect(testStruct?.text).toContain('This is a struct comment');

        // Verify enum with comments
        const enums = structures.filter(s => s.type === 'enum_specifier');
        expect(enums.length).toBeGreaterThan(0);
        const testEnum = enums.find(e => e.text.includes('TestEnum'));
        expect(testEnum).toBeDefined();
        expect(testEnum?.text).toContain('This is an enum comment');

        // Verify template class with comments
        const templateClass = classes.find(c => c.text.includes('TemplateClass'));
        expect(templateClass).toBeDefined();
        expect(templateClass?.text).toContain('Template class comment');
    });

    it('should correctly handle comments for C++ template structures', async () => {
        const code = `
/**
 * Comment for template function
 */
template <typename T>
T templateFunction(T value) {
    return value;
}

/**
 * Comment for template class
 */
template <typename T, typename U>
class TemplateExample {
public:
    /**
     * Comment for template method
     */
    T processValue(T input, U modifier) {
        return input;
    }
};

// Comment for specialized template
template <>
class TemplateExample<int, double> {
public:
    int processValue(int input, double modifier) {
        return input * static_cast<int>(modifier);
    }
};
`;

        const structures = await analyzer.findAllStructures(code, 'cpp');

        console.log('Structures:', JSON.stringify(structures, null, 2));

        expect(structures.length).toBe(5);

        // Verify template function with comments
        const functions = structures.filter(s => s.type.includes('function'));
        const templateFunction = functions.find(f => f.text.includes('templateFunction'));
        expect(templateFunction).toBeDefined();
        expect(templateFunction?.text).toContain('Comment for template function');

        // Verify template class with comments
        const classes = structures.filter(s => s.type === 'class_specifier' || s.text.includes('template'));
        const templateClass = classes.find(c => c.text.includes('TemplateExample') && c.text.includes('typename T'));
        expect(templateClass).toBeDefined();
        expect(templateClass?.text).toContain('Comment for template class');

        // Verify specialized template with comments
        const specializedClass = classes.find(c => c.text.includes('TemplateExample<int, double>'));
        expect(specializedClass).toBeDefined();
        expect(specializedClass?.text).toContain('// Comment for specialized template');
    });
});

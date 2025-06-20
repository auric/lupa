import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CodeAnalysisService, CodeAnalysisServiceInitializer } from '../services/codeAnalysisService';
import * as path from 'path';

describe('CodeAnalysisService - Comment Association', () => {
    let service: CodeAnalysisService;

    beforeAll(async () => {
        const extensionPath = path.resolve(__dirname, '..', '..');
        await CodeAnalysisServiceInitializer.initialize(extensionPath);
        service = new CodeAnalysisService();
    });

    afterAll(() => {
        if (service) {
            service.dispose();
        }
    });

    it('should identify the line of the associated comment for a C++ class', async () => {
        const code = `
/**
 * This is a comment for MyClass
 */
class MyClass {
public:
    void foo() {}
};
`;
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // MyClass is the POI, its comment starts on line 2 (1-based).
        expect(lines).toContain(2);
    });

    it('should identify the line of the associated comment for a C++ function', async () => {
        const code = `
/**
 * This is a comment for foo function
 */
void foo() {
    // Implementation
}
`;
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // foo() is the POI, its comment starts on line 2 (1-based).
        expect(lines).toContain(2);
    });

    it('should associate comments with methods inside a class', async () => {
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // POIs are MyClass and foo().
        // MyClass has no preceding comment, so its own line (2) is used.
        // foo() has a comment starting on line 4.
        expect(lines).toContain(2); // For MyClass
        expect(lines).toContain(4); // For foo()
    });

    it('should associate comments with C++ structs', async () => {
        const code = `
// Comment for MyStruct
struct MyStruct {
    int data;
};
`;
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // MyStruct is the POI, its comment starts on line 2.
        expect(lines).toContain(2);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // MyEnum is the POI, its comment starts on line 2.
        expect(lines).toContain(2);
    });

    it('should handle namespace comments and nested comments', async () => {
        const code = `
/** Comment for namespace test */
namespace test {

    /** Function comment */
    void foo() {
        // Implementation
    }

} // namespace test
`;
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // namespace test is a POI, comment starts on line 2.
        // void foo() is a POI, comment starts on line 5.
        expect(lines).toContain(2);
        expect(lines).toContain(5);
    });

    it('should not associate comments separated by blank lines', async () => {
        const code = `
// First comment line

// Second comment line
class BlankLineCommentClass {
    void method() {}
};
`;
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // The blank line breaks the association.
        // The comment for BlankLineCommentClass starts on line 4.
        expect(lines).toContain(4);
        // It should NOT associate the comment from line 2.
        expect(lines).not.toContain(2);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // The comment block for MultiCommentClass starts at line 2.
        // The method comment starts at line 8.
        expect(lines).toContain(2);
        expect(lines).toContain(7);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'ts');
        // DecoratedClass POI, comment starts line 2.
        // method POI, comment starts line 7.
        expect(lines).toContain(2);
        expect(lines).toContain(7);
    });

    it('should associate comments across different supported languages', async () => {
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
        const jsLines = await service.getLinesForPointsOfInterest(jsCode, 'js');
        expect(jsLines).toContain(2);

        const pyLines = await service.getLinesForPointsOfInterest(pyCode, 'py');
        expect(pyLines).toContain(2);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp');
        // outer namespace, comment line 2
        // inner namespace, comment line 6
        // NestedClass, comment line 10
        // method, comment line 15
        expect(lines).toEqual([2, 6, 10, 15]);
    });
});

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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // MyClass is the POI, its comment starts on line 2 (index 1).
        expect(lines).toContain(1);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // foo() is the POI, its comment starts on line 2 (index 1).
        expect(lines).toContain(1);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // POIs are MyClass and foo().
        // MyClass has no preceding comment, so its own line (index 1) is used.
        // foo() has a comment starting on line 4 (index 3).
        // With the new logic, the method is a child of the class POI, so it's filtered out.
        // We only get the top-level class breakpoint.
        expect(lines).toEqual([1]);
    });

    it('should associate comments with C++ structs', async () => {
        const code = `
// Comment for MyStruct
struct MyStruct {
    int data;
};
`;
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // MyStruct is the POI, its comment starts on line 2 (index 1).
        expect(lines).toContain(1);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // MyEnum is the POI, its comment starts on line 2 (index 1).
        expect(lines).toContain(1);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // namespace test is a POI, comment starts on line 2 (index 1).
        // void foo() is a POI, comment starts on line 5 (index 4).
        // The function `foo` is a child of the namespace, so it's filtered out.
        expect(lines).toEqual([1]);
    });

    it('should not associate comments separated by blank lines', async () => {
        const code = `
// First comment line

// Second comment line
class BlankLineCommentClass {
    void method() {}
};
`;
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // The blank line breaks the association.
        // The comment for BlankLineCommentClass starts on line 4 (index 3).
        expect(lines).toContain(3);
        // It should NOT associate the comment from line 2 (index 1).
        expect(lines).not.toContain(1);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // The comment block for MultiCommentClass starts at line 2 (index 1).
        // The method comment starts at line 8 (index 7).
        // The method is a child of the class, so it's filtered out.
        expect(lines).toEqual([1]);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'typescript', undefined);
        // DecoratedClass POI, comment starts line 2.
        // method POI, comment starts line 6.
        // The method is a child of the class, so it's filtered out.
        expect(lines).toEqual([1]);
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
        const jsLines = await service.getLinesForPointsOfInterest(jsCode, 'javascript', undefined);
        expect(jsLines).toContain(1);

        const pyLines = await service.getLinesForPointsOfInterest(pyCode, 'python', undefined);
        expect(pyLines).toContain(1);
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
        const lines = await service.getLinesForPointsOfInterest(code, 'cpp', undefined);
        // outer namespace, comment line 2 (index 1)
        // inner namespace, comment line 6 (index 5)
        // NestedClass, comment line 10 (index 9)
        // method, comment line 15 (index 14)
        // The new logic correctly identifies only the top-level POIs.
        expect(lines).toEqual([1]);
    });
});

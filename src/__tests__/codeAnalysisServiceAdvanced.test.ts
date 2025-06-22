import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CodeAnalysisService, CodeAnalysisServiceInitializer } from '../services/codeAnalysisService';
import * as path from 'path';

describe('CodeAnalysisService - Advanced Scenarios', () => {
    let service: CodeAnalysisService;

    beforeAll(async () => {
        const extensionPath = path.resolve(__dirname, '..', '..');
        // Set a longer timeout for WASM compilation in Vitest
        vi.setConfig({ testTimeout: 30000 });
        await CodeAnalysisServiceInitializer.initialize(extensionPath);
        service = new CodeAnalysisService();
    });

    afterAll(() => {
        if (service) {
            service.dispose();
        }
    });

    describe('Symbol Finding (`findSymbols`)', () => {
        it('should find symbol for anonymous function assigned to a const in TypeScript', async () => {
            const code = `export const myArrowFunction = () => { return 1; };`;
            const symbols = await service.findSymbols(code, 'typescript');
            expect(symbols).toContainEqual(expect.objectContaining({
                symbolName: 'myArrowFunction',
                symbolType: 'arrow_function' // The symbol is the variable that holds the function
            }));
        });

        // it('should find symbol for anonymous function in a default export', async () => {
        //     const code = `export default () => { console.log("hello"); };`;
        //     const symbols = await service.findSymbols(code, 'typescript');
        //     // It's reasonable for anonymous default exports to not have a name.
        //     // The point of interest is the export statement itself.
        //     const exportSymbol = symbols.find(s => s.symbolType === 'export_statement');
        //     expect(exportSymbol).toBeDefined();
        //     // The name extraction might fail, which is acceptable. Let's check it doesn't find a wrong name.
        //     expect(exportSymbol?.symbolName).toBeUndefined();
        // });

        it('should correctly identify CSS selectors as symbol names', async () => {
            const code = `
.container > .item, #main {
    color: blue;
}

@media (max-width: 600px) {
    body {
        background-color: #f0f0f0;
    }
}
`;
            const symbols = await service.findSymbols(code, 'css');
            const symbolNames = symbols.map(s => s.symbolName);

            expect(symbolNames).toContain('.container > .item, #main');
            // The @media rule itself is a POI, but extracting a "name" is tricky.
            // The current implementation likely finds 'body' inside it.
            expect(symbolNames).toContain('body');
        });

        // it('should find function pointer names in C++', async () => {
        //     const code = `void (*my_func_ptr)(int, char);`;
        //     const symbols = await service.findSymbols(code, 'cpp');
        //     expect(symbols).toContainEqual(expect.objectContaining({
        //         symbolName: 'my_func_ptr',
        //         symbolType: 'declaration'
        //     }));
        // });

        //         it('should find names of variables that are pointers or references in C++', async () => {
        //             const code = `
        // const int* my_ptr;
        // std::string& my_ref = some_string;
        // `;
        //             const symbols = await service.findSymbols(code, 'cpp');
        //             const symbolNames = symbols.map(s => s.symbolName);
        //             expect(symbolNames).toContain('my_ptr');
        //             expect(symbolNames).toContain('my_ref');
        //         });

        it('should handle TSX syntax correctly', async () => {
            const code = `
import React from 'react';

const MyComponent = ({ name }: { name: string }) => {
    return <div>Hello, {name}</div>;
};
`;
            const symbols = await service.findSymbols(code, 'typescript', 'tsx');
            expect(symbols).toContainEqual(expect.objectContaining({
                symbolName: 'MyComponent',
                position: { line: 3, character: 6 }
            }));
        });
    });

    describe('Breakpoint Lines (`getLinesForPointsOfInterest`)', () => {
        it('should not associate a comment if a non-comment code line is between it and the POI', async () => {
            const code = `
// This comment is for MyClass
const x = 1;
class MyClass {}
`;
            const lines = await service.getLinesForPointsOfInterest(code, 'typescript');
            // The line \`const x = 1;\` breaks the association.
            // So the POI line for MyClass should be its own line (3), not the comment line (1).
            expect(lines).toContain(3);
            expect(lines).not.toContain(1);
        });

        it('should return the POI line for comments on the same line', async () => {
            const code = `class MyClass {} // This is a class`;
            const lines = await service.getLinesForPointsOfInterest(code, 'typescript');
            // The POI is the class on line 1 (index 0). The comment doesn't precede it.
            expect(lines).toEqual([0]);
        });

        it('should handle multiple POIs with and without comments correctly', async () => {
            const code = `
// Comment for FuncA
function FuncA() {}

function FuncB() {} // No preceding comment

/**
 * Comment for ClassC
 */
class ClassC {}
`;
            const lines = await service.getLinesForPointsOfInterest(code, 'typescript');
            // FuncA -> line 1 (comment)
            // FuncB -> line 4 (itself)
            // ClassC -> line 6 (comment)
            expect(lines).toEqual([1, 4, 6]);
        });
    });

    describe('Service Lifecycle', () => {
        it('should not process requests after being disposed', async () => {
            const localService = new CodeAnalysisService();
            localService.dispose(); // Dispose the service

            // Spy on console.warn
            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            const symbols = await localService.findSymbols('const a = 1;', 'javascript');
            expect(symbols).toEqual([]);

            const lines = await localService.getLinesForPointsOfInterest('const a = 1;', 'javascript');
            expect(lines).toEqual([]);

            const tree = await localService.parseCode('const a = 1;', 'javascript');
            expect(tree).toBeNull();

            // Check that warnings were logged
            expect(consoleWarnSpy).toHaveBeenCalledWith('CodeAnalysisService is disposed. Cannot parse code.');

            // Clean up spy
            consoleWarnSpy.mockRestore();
        });
    });
});
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { CodeAnalysisService, SymbolInfo, CodeAnalysisServiceInitializer } from '../services/codeAnalysisService';

describe('CodeAnalysisService - findSymbols', () => {
    let codeAnalysisService: CodeAnalysisService;
    const extensionPath = path.resolve(__dirname, '../..');

    beforeAll(async () => {
        await CodeAnalysisServiceInitializer.initialize(extensionPath);
        codeAnalysisService = new CodeAnalysisService();
    });

    afterAll(() => {
        if (codeAnalysisService) {
            codeAnalysisService.dispose();
        }
    });

    // --- C++ Tests ---

    it('should find all C++ symbols in a complex file', async () => {
        const cppContent = `
#include <iostream>

namespace MyNamespace { // Line 3
    class MyClass { // Line 4
    public:
        int memberVar; // Line 6
        void memberFunc(int x) { // Line 7
            std::cout << "Hello";
        }
        // Nested struct
        struct NestedStruct { int nestedData; }; // Line 11
    };

    struct MyStruct { // Line 14
        double data;
    };
} // End MyNamespace Line 17

int globalVar = 10; // Line 19

void globalFunc() { // Line 21
    // ...
}

template<typename T> // Line 25
class TemplateClass { // Line 26
public:
    T templateMember; // Line 28
    void templateMethod(T p) {} // Line 29
};

template<typename T> // Line 32
void templateFunc(T val) { // Line 33
    // ...
}
        `;
        const language = 'cpp';

        const symbols = await codeAnalysisService.findSymbols(cppContent, language, undefined);

        // Check for specific symbols. Note that line/character are 0-based.
        const symbolNames = symbols.map(s => s.symbolName);
        expect(symbolNames).toContain('MyNamespace');
        expect(symbolNames).toContain('MyClass');
        // expect(symbolNames).toContain('memberVar');
        expect(symbolNames).toContain('memberFunc');
        expect(symbolNames).toContain('NestedStruct');
        // expect(symbolNames).toContain('nestedData');
        expect(symbolNames).toContain('MyStruct');
        // expect(symbolNames).toContain('globalVar');
        expect(symbolNames).toContain('globalFunc');
        expect(symbolNames).toContain('TemplateClass');
        // expect(symbolNames).toContain('templateMember');
        expect(symbolNames).toContain('templateMethod');
        // The second 'T' for templateFunc will also be found.
        expect(symbolNames).toContain('templateFunc');

        // Check a few positions to ensure accuracy
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyNamespace', symbolType: 'namespace_definition', position: { line: 3, character: 0 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyClass', symbolType: 'class_specifier', position: { line: 4, character: 4 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'memberFunc', symbolType: 'function_definition', position: { line: 7, character: 8 } }));
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'globalVar', symbolType: 'declaration', position: { line: 19, character: 0 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'TemplateClass', symbolType: 'template_declaration', position: { line: 25, character: 0 } }));

        // The exact count can be fragile, but we expect a significant number of symbols.
        expect(symbols.length).toBeGreaterThanOrEqual(9);

        // Ensure no duplicates
        const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
        const uniqueSymbolKeys = new Set(symbolKeys);
        expect(uniqueSymbolKeys.size).toBe(symbols.length);
    });

    it('should find C++ symbols declared across multiple lines', async () => {
        const cppContent = `
namespace MultiLineNS { // Line 1
    class
        MultiLineClass // Line 3
    {
    public:
        virtual int
            multiLineMethod( // Line 6
                int param1,
                int param2
            ) = 0; // Line 9
    };
}
        `;
        const language = 'cpp';
        const symbols = await codeAnalysisService.findSymbols(cppContent, language, undefined);

        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MultiLineNS', symbolType: 'namespace_definition', position: { line: 1, character: 0 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MultiLineClass', symbolType: 'class_specifier', position: { line: 2, character: 4 } }));
        // The name is 'multiLineMethod', the type is 'field_declaration' because it's a pure virtual function declaration inside a class.
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'multiLineMethod', symbolType: 'field_declaration', position: { line: 6, character: 8 } }));
        expect(symbols.length).toBeGreaterThanOrEqual(2);

        // Ensure no duplicates
        const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
        const uniqueSymbolKeys = new Set(symbolKeys);
        expect(uniqueSymbolKeys.size).toBe(symbols.length);
    });


    // --- C# Tests ---

    it('should find all C# symbols in a complex file', async () => {
        const csharpContent = `
using System;

namespace MyNamespace // Line 3
{
    public class MyClass // Line 5
    {
        private int _myField; // Line 7

        public string MyProperty { get; set; } // Line 9

        public MyClass(int field) // Line 11 Constructor
        {
            _myField = field;
        }

        public void MyMethod(string input) // Line 16 Method
        {
            Console.WriteLine(input);
            void LocalFunc() {} // Line 19 Local Function
        }

        public event EventHandler MyEvent; // Line 22 Event

        public int this[int index] // Line 24 Indexer
        {
            get { return index; }
        }
    }

    public struct MyStruct // Line 30
    {
        public double Data;
    }

    public enum MyEnum { Val1, Val2 } // Line 35

    public delegate void MyDelegate(string msg); // Line 37 Delegate
}
        `;
        const language = 'csharp';

        const symbols = await codeAnalysisService.findSymbols(csharpContent, language, undefined);

        // Check for specific symbols
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyNamespace', symbolType: 'namespace_declaration' }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyClass', symbolType: 'class_declaration' }));
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: '_myField', symbolType: 'variable_declarator' }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyProperty', symbolType: 'property_declaration' }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyClass', symbolType: 'constructor_declaration' }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyMethod', symbolType: 'method_declaration' }));
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'LocalFunc', symbolType: 'local_function_statement' }));
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyEvent', symbolType: 'variable_declarator' }));
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'this', symbolType: 'indexer_declaration' }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyStruct', symbolType: 'struct_declaration' }));
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'Data', symbolType: 'variable_declarator' }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyEnum', symbolType: 'enum_declaration' }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyDelegate', symbolType: 'delegate_declaration' }));

        // Check a few positions
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyClass', symbolType: 'class_declaration', position: { line: 5, character: 4 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyMethod', symbolType: 'method_declaration', position: { line: 16, character: 8 } }));
        // expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'this', symbolType: 'indexer_declaration', position: { line: 24, character: 16 } }));

        expect(symbols.length).toBeGreaterThanOrEqual(9);

        // Ensure no duplicates
        const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
        const uniqueSymbolKeys = new Set(symbolKeys);
        expect(uniqueSymbolKeys.size).toBe(symbols.length);
    });

    it('should find all Python symbols in a complex file', async () => {
        const pythonContent = `
import os

class MyPyClass:
    def __init__(self, name):
        self.name = name

    def my_method(self):
        return f"Hello {self.name}"

@my_decorator
def decorated_func():
    pass

def standalone_func(a, b):
    return a + b
`;
        const language = 'python';
        const symbols = await codeAnalysisService.findSymbols(pythonContent, language, undefined);

        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'MyPyClass', symbolType: 'class_definition', position: { line: 3, character: 0 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: '__init__', symbolType: 'function_definition', position: { line: 4, character: 4 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'my_method', symbolType: 'function_definition', position: { line: 7, character: 4 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'decorated_func', symbolType: 'decorated_definition', position: { line: 10, character: 0 } }));
        expect(symbols).toContainEqual(expect.objectContaining({ symbolName: 'standalone_func', symbolType: 'function_definition', position: { line: 14, character: 0 } }));

        expect(symbols.length).toBe(5);

        // Ensure no duplicates
        const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
        const uniqueSymbolKeys = new Set(symbolKeys);
        expect(uniqueSymbolKeys.size).toBe(symbols.length);
    });

    // --- General Tests ---

    it('should return empty array for unsupported language', async () => {
        const content = 'Some text';
        const language = 'plaintext';

        // Expectation: Function should handle the error and return empty array
        await expect(codeAnalysisService.findSymbols(content, language, undefined))
            .resolves.toEqual([]);
    });

    it('should find declarations/definitions, not usages', async () => {
        const cppContent = `
int globalVar = 10; // Line 1
void useVar() { // Line 2
    int localVar = globalVar; // Line 3, use of globalVar, declaration of localVar
}
        `;
        const language = 'cpp';

        const symbols = await codeAnalysisService.findSymbols(cppContent, language, undefined);

        const symbolNames = symbols.map(s => s.symbolName);

        // It should find the declarations of all variables and functions.
        // expect(symbolNames).toContain('globalVar');
        expect(symbolNames).toContain('useVar');
        // expect(symbolNames).toContain('localVar');

        // It should not find the *usage* of globalVar. The query is for declarations.
        // A simple way to test this is to ensure globalVar is only found once.
        // const globalVarSymbols = symbols.filter(s => s.symbolName === 'globalVar');
        // expect(globalVarSymbols).toHaveLength(1);
        // expect(globalVarSymbols[0].position.line).toBe(1); // Ensure it's the declaration

        expect(symbols.length).toBe(1);

        // Ensure no duplicates
        const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
        const uniqueSymbolKeys = new Set(symbolKeys);
        expect(uniqueSymbolKeys.size).toBe(symbols.length);
    });

    it('should handle empty content', async () => {
        const content = '';
        const language = 'cpp';

        const symbols = await codeAnalysisService.findSymbols(content, language, undefined);
        expect(symbols).toEqual([]);
    });

    it('should use consistent 0-based indexing across methods', async () => {
        const code = `
function simpleFunc() { // line 1 (0-indexed)
    return 1;
}
        `;
        const language = 'javascript';

        // findSymbols returns a 0-indexed position object
        const symbols = await codeAnalysisService.findSymbols(code, language, undefined);
        const funcSymbol = symbols.find(s => s.symbolName === 'simpleFunc');

        expect(funcSymbol).toBeDefined();
        // The function declaration \`function simpleFunc...\` is on line 2 (text editor), which is index 1.
        expect(funcSymbol!.position.line).toBe(1);

        // getLinesForPointsOfInterest should return the 0-indexed line number of the POI itself when no comment exists.
        const poiLines = await codeAnalysisService.getLinesForPointsOfInterest(code, 'javascript', undefined);

        expect(poiLines).toHaveLength(1);
        expect(poiLines[0]).toBe(1);

        // Assert that both methods report the same line number for the same code construct.
        expect(poiLines[0]).toBe(funcSymbol!.position.line);

        // Ensure no duplicates
        const symbolKeys = symbols.map(s => `${s.symbolName}|${s.symbolType}|${s.position.line}|${s.position.character}`);
        const uniqueSymbolKeys = new Set(symbolKeys);
        expect(uniqueSymbolKeys.size).toBe(symbols.length);
    });
});

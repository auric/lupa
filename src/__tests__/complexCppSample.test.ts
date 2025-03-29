import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TreeStructureAnalyzer, TreeStructureAnalyzerPool, CodeStructure } from '../services/treeStructureAnalyzer';
import * as path from 'path';
import * as fs from 'fs';

describe('TreeStructureAnalyzer Complex C++ Sample Test', () => {
    let analyzer: TreeStructureAnalyzer;
    let complexCppCode: string;

    beforeEach(async () => {
        // Create a real analyzer instance
        const extensionPath = path.resolve(__dirname, '..', '..');
        const analyzerPool = TreeStructureAnalyzerPool.createSingleton(extensionPath, 1); // Use pool size 1 for simplicity in tests

        analyzer = await analyzerPool.getAnalyzer();
        await analyzer.initialize();

        // Load the fixture file
        const fixturePath = path.resolve(__dirname, 'fixtures', 'complex_cpp_sample.cpp');
        complexCppCode = fs.readFileSync(fixturePath, 'utf-8');
    });

    afterEach(() => {
        analyzer.release(); // Release analyzer back to pool
        // Consider disposing the pool if tests are completely finished, or manage its lifecycle elsewhere
    });

    it('should correctly parse the complex C++ sample and identify top-level structures', async () => {
        const structures = await analyzer.getStructureHierarchy(complexCppCode, 'cpp');

        // Expecting top-level structures: file header, utils namespace, Application class, ComplexData struct, main function
        expect(structures.length).toBe(5); // Adjust based on exact parsing results

        // Check for file header comment
        const fileHeader = structures.find(s => s.type === 'file_header_comment');
        expect(fileHeader).toBeDefined();
        expect(fileHeader?.comment).toContain('@file complex_cpp_sample.cpp');

        // Check for utils namespace
        const utilsNamespace = structures.find(s => s.type === 'namespace_definition' && s.name === 'utils');
        expect(utilsNamespace).toBeDefined();
        expect(utilsNamespace?.comment).toContain('A namespace containing utility functions and classes');

        // Check for Application class
        const appClass = structures.find(s => s.type === 'class_specifier' && s.name === 'Application');
        expect(appClass).toBeDefined();
        expect(appClass?.comment).toContain('The main application class');

        // Check for ComplexData struct
        const complexDataStruct = structures.find(s => s.type === 'struct_specifier' && s.name === 'ComplexData');
        expect(complexDataStruct).toBeDefined();
        expect(complexDataStruct?.comment).toContain('A complex struct with nested types');

        // Check for main function
        const mainFunction = structures.find(s => s.type === 'function_definition' && s.name === 'main');
        expect(mainFunction).toBeDefined();
        expect(mainFunction?.comment).toContain('Main entry point');
    });

    it('should correctly identify nested structures within utils namespace', async () => {
        const structures = await analyzer.getStructureHierarchy(complexCppCode, 'cpp');
        const utilsNamespace = structures.find(s => s.type === 'namespace_definition' && s.name === 'utils');
        expect(utilsNamespace).toBeDefined();
        expect(utilsNamespace?.children).toBeDefined();

        const children = utilsNamespace!.children;

        // Check for StatusCode enum
        const statusCodeEnum = children.find(s => s.type === 'enum_specifier' && s.name === 'StatusCode');
        expect(statusCodeEnum).toBeDefined();
        expect(statusCodeEnum?.comment).toContain('A simple enumeration for status codes');

        // Check for Helper class
        const helperClass = children.find(s => s.type === 'class_specifier' && s.name === 'Helper');
        expect(helperClass).toBeDefined();
        expect(helperClass?.comment).toContain('A simple class for demonstration');

        // Check for Container template class
        const containerClass = children.find(s => s.type === 'template_declaration' && s.children.some(c => c.type === 'class_specifier' && c.name === 'Container'));
        expect(containerClass).toBeDefined();
        expect(containerClass?.comment).toContain('A template container class');

        // Check for processData template function
        const processDataFunc = children.find(s => s.type === 'template_declaration' && s.children.some(c => c.type === 'function_definition' && c.name === 'processData'));
        expect(processDataFunc).toBeDefined();
        expect(processDataFunc?.comment).toContain('A utility function to process data');

        // Check for strings namespace
        const stringsNamespace = children.find(s => s.type === 'namespace_definition' && s.name === 'strings');
        expect(stringsNamespace).toBeDefined();
        expect(stringsNamespace?.comment).toBeUndefined(); // No comment directly before namespace strings
        expect(stringsNamespace?.trailingComment).toBe('// namespace strings');
    });

    it('should correctly identify methods within Helper class', async () => {
        const structures = await analyzer.findAllStructures(complexCppCode, 'cpp'); // Use flat list to find easily
        const helperClass = structures.find(s => s.type === 'class_specifier' && s.name === 'Helper');
        expect(helperClass).toBeDefined();

        const calculateMethod = structures.find(s => s.name === 'calculate' && s.parent === helperClass);
        expect(calculateMethod).toBeDefined();
        expect(calculateMethod?.comment).toContain('Performs a calculation');
        expect(calculateMethod?.parentContext?.name).toBe('Helper');
        expect(calculateMethod?.parentContext?.type).toBe('class_specifier');

        const formatMethod = structures.find(s => s.name === 'format' && s.parent === helperClass);
        expect(formatMethod).toBeDefined();
        expect(formatMethod?.comment).toContain('Formats a string');
    });

    it('should correctly identify methods within Application class', async () => {
        const structures = await analyzer.findAllStructures(complexCppCode, 'cpp');
        const appClass = structures.find(s => s.type === 'class_specifier' && s.name === 'Application');
        expect(appClass).toBeDefined();

        const showHelpMethod = structures.find(s => s.name === 'showHelp' && s.parent === appClass);
        expect(showHelpMethod).toBeDefined();
        expect(showHelpMethod?.comment).toContain('Shows help information');

        const runMethod = structures.find(s => s.name === 'run' && s.parent === appClass);
        expect(runMethod).toBeDefined();
        expect(runMethod?.comment).toContain('Run the application');

        const executeCommandMethod = structures.find(s => s.name === 'executeCommand' && s.parent === appClass);
        expect(executeCommandMethod).toBeDefined();
        expect(executeCommandMethod?.comment).toContain('Execute a command');
    });

    it('should correctly identify nested structures within ComplexData struct', async () => {
        const structures = await analyzer.findAllStructures(complexCppCode, 'cpp');
        const complexDataStruct = structures.find(s => s.type === 'struct_specifier' && s.name === 'ComplexData');
        expect(complexDataStruct).toBeDefined();

        const typeEnum = structures.find(s => s.type === 'enum_specifier' && s.name === 'Type' && s.parent === complexDataStruct);
        expect(typeEnum).toBeDefined();
        expect(typeEnum?.comment).toContain('Nested enum');

        const entryStruct = structures.find(s => s.type === 'struct_specifier' && s.name === 'Entry' && s.parent === complexDataStruct);
        expect(entryStruct).toBeDefined();
        expect(entryStruct?.comment).toContain('Nested struct');

        const operatorMethod = structures.find(s => s.type === 'function_definition' && s.name === 'operator<' && s.parent === entryStruct);
        expect(operatorMethod).toBeDefined();
        expect(operatorMethod?.comment).toContain('Operator overloading');

        const addEntryMethod = structures.find(s => s.type === 'function_definition' && s.name === 'addEntry' && s.parent === complexDataStruct);
        expect(addEntryMethod).toBeDefined();
        expect(addEntryMethod?.comment).toBeUndefined(); // No comment

        const sortEntriesMethod = structures.find(s => s.type === 'function_definition' && s.name === 'sortEntries' && s.parent === complexDataStruct);
        expect(sortEntriesMethod).toBeDefined();
        expect(sortEntriesMethod?.comment).toBeUndefined(); // No comment
    });


    it('should correctly identify functions within utils::strings namespace', async () => {
        const structures = await analyzer.findAllStructures(complexCppCode, 'cpp');
        const stringsNamespace = structures.find(s => s.type === 'namespace_definition' && s.name === 'strings');
        expect(stringsNamespace).toBeDefined();

        const joinFunc = structures.find(s => s.name === 'join' && s.parent === stringsNamespace);
        expect(joinFunc).toBeDefined();
        expect(joinFunc?.comment).toContain('Joins a vector of strings');
        expect(joinFunc?.parentContext?.name).toBe('strings');
        expect(joinFunc?.parentContext?.type).toBe('namespace_definition');

        const splitFunc = structures.find(s => s.name === 'split' && s.parent === stringsNamespace);
        expect(splitFunc).toBeDefined();
        expect(splitFunc?.comment).toContain('Splits a string by a delimiter');
    });

    it('should correctly identify trailing namespace comments', async () => {
        const structures = await analyzer.findAllStructures(complexCppCode, 'cpp');

        const utilsNamespace = structures.find(s => s.type === 'namespace_definition' && s.name === 'utils');
        expect(utilsNamespace).toBeDefined();
        expect(utilsNamespace?.trailingComment).toBe('// namespace utils');

        const stringsNamespace = structures.find(s => s.type === 'namespace_definition' && s.name === 'strings');
        expect(stringsNamespace).toBeDefined();
        expect(stringsNamespace?.trailingComment).toBe('// namespace strings');
    });

    it('should build the correct hierarchy', async () => {
        const hierarchy = await analyzer.getStructureHierarchy(complexCppCode, 'cpp');

        const utilsNamespace = hierarchy.find(s => s.type === 'namespace_definition' && s.name === 'utils');
        expect(utilsNamespace).toBeDefined();
        expect(utilsNamespace!.children.length).toBeGreaterThan(3); // Enum, Class, Template Class, Template Func, Namespace

        const stringsNamespace = utilsNamespace!.children.find(s => s.type === 'namespace_definition' && s.name === 'strings');
        expect(stringsNamespace).toBeDefined();
        expect(stringsNamespace!.children.length).toBe(2); // join, split

        const joinFunc = stringsNamespace!.children.find(s => s.name === 'join');
        expect(joinFunc).toBeDefined();
        expect(joinFunc!.parent).toBe(stringsNamespace);

        const appClass = hierarchy.find(s => s.type === 'class_specifier' && s.name === 'Application');
        expect(appClass).toBeDefined();
        expect(appClass!.children.length).toBe(3); // showHelp, run, executeCommand

        const complexData = hierarchy.find(s => s.type === 'struct_specifier' && s.name === 'ComplexData');
        expect(complexData).toBeDefined();
        expect(complexData!.children.length).toBe(4); // Type enum, Entry struct, addEntry, sortEntries

        const entryStruct = complexData!.children.find(s => s.type === 'struct_specifier' && s.name === 'Entry');
        expect(entryStruct).toBeDefined();
        expect(entryStruct!.children.length).toBe(1); // operator<
    });
});

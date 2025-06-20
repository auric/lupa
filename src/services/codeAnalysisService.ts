// src/services/codeAnalysisService.ts
import { Parser, Language, Node, Tree, Query } from 'web-tree-sitter';
import * as path from 'path';
import { LANGUAGE_QUERIES } from '../config/treeSitterQueries';
import { getLanguageForExtension, SUPPORTED_LANGUAGES } from '../types/types';
import * as vscode from 'vscode';

export interface Position {
    line: number;
    character: number;
}

export interface SymbolInfo {
    symbolName: string;
    symbolType: string;
    position: Position;
}

/**
 * Singleton Initializer for the Tree-sitter parser.
 * Ensures that the heavy Parser.init() is called only once.
 */
export class CodeAnalysisServiceInitializer {
    private static initializationPromise: Promise<void> | null = null;
    private static extensionPath: string;

    public static async initialize(extensionPath: string): Promise<void> {
        if (!this.initializationPromise) {
            this.extensionPath = extensionPath;
            const wasmPath = path.join(extensionPath, 'dist', 'tree-sitter.wasm');
            console.log(`CodeAnalysisService: Initializing Tree-sitter parser with wasm at ${wasmPath}`);
            this.initializationPromise = Parser.init({
                locateFile: () => wasmPath,
            });
        }
        return this.initializationPromise;
    }

    public static getWasmGrammarPath(grammarName: string): string {
        if (!this.extensionPath) {
            throw new Error('CodeAnalysisServiceInitializer is not initialized with an extension path.');
        }
        return path.join(this.extensionPath, 'dist', 'grammars', `${grammarName}.wasm`);
    }
}

/**
 * Provides code analysis capabilities using Tree-sitter.
 * This service is responsible for parsing code and extracting structural information,
 * such as points of interest and comments, which are used for intelligent chunking and symbol analysis.
 */
export class CodeAnalysisService implements vscode.Disposable {
    private parser: Parser;
    private languageParsers: Map<string, Language> = new Map();
    private isDisposed = false;

    constructor() {
        this.parser = new Parser();
    }

    private async getLanguageParser(language: string, variant?: string): Promise<Language> {
        const cacheKey = variant ? `${language}-${variant}` : language;
        if (this.languageParsers.has(cacheKey)) {
            return this.languageParsers.get(cacheKey)!;
        }

        const langDetails = Object.values(SUPPORTED_LANGUAGES).find(l => l.language === language && l.variant === variant);
        if (!langDetails?.treeSitterGrammar) {
            throw new Error(`Language '${language}' (${variant || 'default'}) is not supported.`);
        }

        const wasmPath = CodeAnalysisServiceInitializer.getWasmGrammarPath(langDetails.treeSitterGrammar);
        const loadedLanguage = await Language.load(wasmPath);
        this.languageParsers.set(cacheKey, loadedLanguage);
        return loadedLanguage;
    }

    public async parseCode(code: string, language: string, variant?: string): Promise<Tree | null> {
        if (this.isDisposed) {
            console.warn('CodeAnalysisService is disposed. Cannot parse code.');
            return null;
        }
        try {
            const langParser = await this.getLanguageParser(language, variant);
            this.parser.setLanguage(langParser);
            return this.parser.parse(code);
        } catch (error) {
            console.error(`Error parsing ${language} code:`, error);
            return null;
        }
    }

    public async findSymbols(code: string, languageId: string, variant?: string): Promise<SymbolInfo[]> {
        const tree = await this.parseCode(code, languageId, variant);
        if (!tree) {
            return [];
        }

        try {
            const langParser = await this.getLanguageParser(languageId, variant);
            const langConfig = LANGUAGE_QUERIES[languageId];
            if (!langConfig || !langConfig.pointsOfInterest) return [];

            const symbolNodes = this.runQuery(tree.rootNode, langParser, langConfig.pointsOfInterest);
            const foundSymbols: SymbolInfo[] = [];
            const processedKeys = new Set<string>();

            for (const node of symbolNodes) {
                const symbolName = this._extractNodeName(node, languageId);
                if (symbolName) {
                    const position = { line: node.startPosition.row, character: node.startPosition.column };
                    const symbolKey = `${symbolName}@${position.line}:${position.character}:${node.type}`;

                    if (!processedKeys.has(symbolKey)) {
                        foundSymbols.push({ symbolName, symbolType: node.type, position });
                        processedKeys.add(symbolKey);
                    }
                }
            }
            return foundSymbols.sort((a, b) => {
                if (a.position.line !== b.position.line) {
                    return a.position.line - b.position.line;
                }
                return a.position.character - b.position.character;
            });
        } catch (error) {
            console.error(`Error finding symbols in ${languageId} code:`, error);
            return [];
        } finally {
            tree.delete();
        }
    }

    private _extractNodeName(node: Node, language: string): string | undefined {
        // Language-specific overrides first
        if (language === 'csharp' && node.type === 'indexer_declaration') {
            return 'this';
        }

        const identifierTypes = ['identifier', 'property_identifier', 'type_identifier', 'field_identifier', 'namespace_identifier'];

        // Priority 1: Check common named fields (e.g., 'name', 'id', 'identifier')
        const commonFields = ['name', 'id', 'identifier'];
        for (const fieldName of commonFields) {
            const nameNode = node.childForFieldName(fieldName);
            if (nameNode && identifierTypes.includes(nameNode.type)) {
                return nameNode.text;
            }
        }

        // Priority 2: Declarator Logic (common in C-like languages)
        // A declarator node often wraps the actual identifier.
        const declaratorNode = node.childForFieldName('declarator');
        if (declaratorNode) {
            // Search for the first identifier within the declarator's direct children.
            let identifier = declaratorNode.children.find(child => child && identifierTypes.includes(child.type));
            if (identifier) {
                return identifier.text;
            }
            // Fallback: first identifier descendant in declarator if no direct child works.
            identifier = declaratorNode.descendantsOfType(identifierTypes)[0];
            if (identifier) {
                return identifier.text;
            }
        }

        // Priority 3: Type Sibling Logic (find identifier immediately after a 'type' field)
        const typeNode = node.childForFieldName('type');
        if (typeNode) {
            let sibling = typeNode.nextSibling;
            while (sibling) {
                if (identifierTypes.includes(sibling.type)) {
                    return sibling.text;
                }
                // Handle pointers/references between type and name, e.g., int * name;
                if (sibling.type === 'pointer_declarator' || sibling.type === 'reference_declarator') {
                    const nameInside = sibling.descendantsOfType(identifierTypes)[0];
                    if (nameInside) {
                        return nameInside.text;
                    }
                }
                // Skip over non-identifier, non-empty nodes like qualifiers, comments, etc.
                if (sibling.text.trim() === '' || sibling.type === 'comment') {
                    sibling = sibling.nextSibling;
                    continue;
                }
                // If we hit something substantial that isn't the identifier or a pointer/reference, stop.
                if (!identifierTypes.includes(sibling.type) &&
                    sibling.type !== 'pointer_declarator' &&
                    sibling.type !== 'reference_declarator') {
                    break;
                }
                sibling = sibling.nextSibling;
            }
        }

        // Priority 4: Heuristic for function-like structures (identifier followed by parameters/arguments)
        // This is a simplified version of a more general child search.
        for (const child of node.children) {
            if (child && identifierTypes.includes(child.type)) {
                if (child.nextSibling?.type === 'parameter_list' ||
                    child.nextSibling?.type === 'formal_parameters' ||
                    child.nextSibling?.type === 'arguments') {
                    return child.text;
                }
            }
        }

        // Priority 5: Fallback - Find the LAST identifier that is a DIRECT CHILD of the node.
        // This can be useful for some structures where the name appears late.
        let lastDirectIdentifierChild: Node | null = null;
        for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i);
            if (child && identifierTypes.includes(child.type)) {
                lastDirectIdentifierChild = child;
                break;
            }
        }
        if (lastDirectIdentifierChild) {
            return lastDirectIdentifierChild.text;
        }

        // Priority 6: If the node itself is an identifier type (can happen with some queries)
        if (identifierTypes.includes(node.type)) {
            return node.text;
        }

        // Priority 7: For anonymous functions assigned to variables (e.g. const myFunc = () => {})
        // This is a common pattern, especially in JavaScript/TypeScript.
        if (node.type.includes('function') || node.type === 'arrow_function' || node.type === 'function_expression') {
            let parent = node.parent;
            // Traverse up to find common assignment patterns
            while (parent) {
                if (parent.type === 'variable_declarator' || parent.type === 'pair' || parent.type === 'assignment_expression') {
                    // Check 'name' for variable_declarator, 'key' for pair (objects), 'left' for assignment
                    const nameNode = parent.childForFieldName('name') || parent.childForFieldName('key') || parent.childForFieldName('left');
                    if (nameNode && identifierTypes.includes(nameNode.type)) {
                        return nameNode.text;
                    }
                    // For assignment_expression, the name might be the whole left side if it's an identifier
                    if (parent.type === 'assignment_expression' && nameNode && nameNode.type === 'identifier') {
                        return nameNode.text;
                    }
                }
                // Stop if we hit a statement or declaration that isn't part of the assignment
                if (parent.type.endsWith('_statement') || parent.type.endsWith('_declaration')) {
                    break;
                }
                parent = parent.parent;
            }
        }

        // Priority 8: CSS rule sets (get selectors)
        if (node.type === 'rule_set' || node.type.includes('selector')) {
            const selectorsNode = node.childForFieldName('selectors');
            if (selectorsNode) {
                return selectorsNode.text;
            }
        }

        return undefined; // No name found
    }

    private runQuery(rootNode: Node, language: Language, queryStrings: string[]): Node[] {
        const nodes: Node[] = [];
        const processedNodeIds = new Set<number>();

        for (const queryString of queryStrings) {
            let query: Query | null = null;
            try {
                query = new Query(language, queryString);
                const matches = query.matches(rootNode);
                for (const match of matches) {
                    // Prefer a capture named 'capture' if available, otherwise use the first capture.
                    const capturedNode = match.captures.find(c => c.name === 'capture')?.node || match.captures[0]?.node;
                    if (capturedNode && !processedNodeIds.has(capturedNode.id)) {
                        nodes.push(capturedNode);
                        processedNodeIds.add(capturedNode.id);
                    }
                }
            } catch (error) {
                console.error(`Error running query "${queryString}":`, error);
            } finally {
                if (query) {
                    query.delete();
                }
            }
        }
        return nodes;
    }

    public extractPointsOfInterest(rootNode: Node, language: Language, langId: string): Node[] {
        const queries = LANGUAGE_QUERIES[langId]?.pointsOfInterest;
        if (!queries) {
            return [];
        }
        return this.runQuery(rootNode, language, queries);
    }

    public extractComments(rootNode: Node, language: Language, langId: string): Node[] {
        const queries = LANGUAGE_QUERIES[langId]?.comments;
        if (!queries) {
            return [];
        }
        return this.runQuery(rootNode, language, queries);
    }

    public async getLinesForPointsOfInterest(code: string, fileExtension: string): Promise<number[]> {
        const langDetails = getLanguageForExtension(fileExtension);
        if (!langDetails) {
            return [];
        }

        const tree = await this.parseCode(code, langDetails.language, langDetails.variant);
        if (!tree) {
            return [];
        }

        try {
            const langParser = await this.getLanguageParser(langDetails.language, langDetails.variant);
            const pointsOfInterest = this.extractPointsOfInterest(tree.rootNode, langParser, langDetails.language);
            const codeLines = code.split('\n');
            const adjustedLines = new Set<number>();

            for (const poi of pointsOfInterest) {
                let currentNode = poi;
                let associatedCommentStartLine = poi.startPosition.row;

                // Traverse backwards from the POI to find the start of its comment block.
                while (currentNode.previousSibling) {
                    const previousNode = currentNode.previousSibling;

                    // Stop if there's a blank line between the nodes.
                    let hasBlankLine = false;
                    for (let i = previousNode.endPosition.row + 1; i < currentNode.startPosition.row; i++) {
                        if (i < codeLines.length && codeLines[i].trim() === '') {
                            hasBlankLine = true;
                            break;
                        }
                    }
                    if (hasBlankLine) {
                        break;
                    }

                    // If the previous sibling is a comment, associate it and continue searching up.
                    if (previousNode.type === 'comment' || previousNode.type.includes('_comment')) {
                        associatedCommentStartLine = previousNode.startPosition.row;
                        currentNode = previousNode;
                    } else if (previousNode.text.trim() === '' || previousNode.type === 'decorator') {
                        // Skip whitespace-only nodes and decorators
                        currentNode = previousNode;
                    } else {
                        // It's a non-comment, non-whitespace node, so stop.
                        break;
                    }
                }
                adjustedLines.add(associatedCommentStartLine + 1); // Convert to 1-based line number
            }

            return Array.from(adjustedLines).sort((a, b) => a - b);
        } catch (error) {
            console.error('Error extracting lines for points of interest:', error);
            return [];
        } finally {
            tree.delete();
        }
    }

    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.parser.delete();
        this.languageParsers.clear();
        this.isDisposed = true;
        console.log('CodeAnalysisService disposed.');
    }
}
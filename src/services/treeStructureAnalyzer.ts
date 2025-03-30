import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { SUPPORTED_LANGUAGES, getLanguageForExtension } from '../types/types';
import {
    TREE_SITTER_LANGUAGE_CONFIGS
} from '../types/treeSitterLanguageConfigs';
import * as path from 'path';

/**
 * Represents a code range in a file
 */
export interface CodeRange {
    startPosition: Parser.Point;
    endPosition: Parser.Point;
}

/**
 * Describes a code structure element (function, class, etc.)
 */
export interface CodeStructure {
    type: string;           // Node type (e.g., "function_declaration", "class_declaration")
    range: CodeRange;       // Position range in the document (including comments/decorators)
    text: string;           // The text content of this structure (including comments/decorators)
    parentContext?: {       // Information about the parent context (class/namespace)
        type: string;       // Type of the parent context
        name?: string;      // Name of the parent context
    };
}

/**
 * Manages a pool of TreeStructureAnalyzer instances
 */
export class TreeStructureAnalyzerPool implements vscode.Disposable {
    private static instance: TreeStructureAnalyzerPool | null = null;
    private readonly analyzers: TreeStructureAnalyzer[] = [];
    private readonly availableAnalyzers: TreeStructureAnalyzer[] = [];
    private isInitialized = false;
    private initPromise: Promise<void> | null = null;
    private readonly maxPoolSize: number;

    // Queue for waiting clients
    private readonly waiting: Array<(analyzer: TreeStructureAnalyzer) => void> = [];

    public static createSingleton(extensionPath: string, maxPoolSize: number = 5): TreeStructureAnalyzerPool {
        if (TreeStructureAnalyzerPool.instance) {
            TreeStructureAnalyzerPool.instance.dispose();
        }
        TreeStructureAnalyzerPool.instance = new TreeStructureAnalyzerPool(extensionPath, maxPoolSize);
        return TreeStructureAnalyzerPool.instance;
    }

    /**
     * Get singleton instance of the pool
     */
    public static getInstance(): TreeStructureAnalyzerPool {
        if (!TreeStructureAnalyzerPool.instance) {
            throw new Error('TreeStructureAnalyzerPool is not initialized. Call createSingleton first.');
        }
        return TreeStructureAnalyzerPool.instance;
    }

    /**
     * Private constructor (use getInstance)
     */
    private constructor(
        private readonly extensionPath: string,
        poolSize: number
    ) {
        this.maxPoolSize = poolSize;
        this.initPromise = this.initialize();
    }

    /**
     * Initialize the pool with Tree-sitter
     */
    private async initialize(): Promise<void> {
        try {
            if (this.isInitialized) return;

            // Initialize web-tree-sitter globally once
            const moduleOptions = {
                locateFile: (pathString: string, _prefixString: string) => {
                    return path.join(this.extensionPath, 'dist', pathString);
                }
            };

            await Parser.init(moduleOptions);
            this.isInitialized = true;
            console.log('TreeStructureAnalyzerPool initialized successfully');
        } catch (error) {
            console.error('Error initializing TreeStructureAnalyzerPool:', error);
            throw error;
        }
    }

    /**
     * Get an analyzer from the pool or create a new one if needed
     */
    public async getAnalyzer(): Promise<TreeStructureAnalyzer> {
        // Wait for initialization if needed
        if (!this.isInitialized && this.initPromise) {
            await this.initPromise;
        }

        // Reuse existing analyzer if available
        if (this.availableAnalyzers.length > 0) {
            const analyzer = this.availableAnalyzers.pop()!;
            return analyzer;
        }

        // Create new analyzer if we haven't reached the pool limit
        if (this.analyzers.length < this.maxPoolSize) {
            const analyzer = new TreeStructureAnalyzer(this.extensionPath);
            await analyzer.initialize();
            this.analyzers.push(analyzer);
            return analyzer;
        }

        // If we've reached the pool limit, wait for an analyzer to become available
        return new Promise<TreeStructureAnalyzer>(resolve => {
            this.waiting.push(resolve);
        });
    }

    /**
     * Return analyzer to the pool when done
     */
    public releaseAnalyzer(analyzer: TreeStructureAnalyzer): void {
        // First check if someone is waiting for an analyzer
        if (this.waiting.length > 0) {
            const nextClient = this.waiting.shift()!;
            nextClient(analyzer);
            return;
        }

        // Otherwise, add it back to the available pool
        if (this.analyzers.includes(analyzer)) {
            this.availableAnalyzers.push(analyzer);
        }
    }

    /**
     * Dispose all resources
     */
    public dispose(): void {
        for (const analyzer of this.analyzers) {
            analyzer.dispose();
        }
        this.analyzers.length = 0;
        this.availableAnalyzers.length = 0;

        // Reject any waiting promises
        for (const waiting of this.waiting) {
            // This is not ideal, but there's no way to properly return
            // an analyzer at this point since we're shutting down
            const dummyAnalyzer = new TreeStructureAnalyzer(this.extensionPath, true);
            waiting(dummyAnalyzer);
            dummyAnalyzer.dispose();
        }
        this.waiting.length = 0;

        TreeStructureAnalyzerPool.instance = null;
    }
}

/**
 * Service to analyze code structure using Tree-sitter
 */
export class TreeStructureAnalyzer implements vscode.Disposable {
    private parser: Parser | null = null;
    private languageParsers: Map<string, Parser.Language> = new Map();
    private isInitialized = false;
    // Promise for initialization
    private pool: TreeStructureAnalyzerPool | null = null;
    private isDisposed = false;

    // Language configurations are defined directly in TREE_SITTER_LANGUAGE_CONFIGS

    /**
     * Constructor - create a new analyzer instance
     * @param extensionPath Path to the extension
     * @param skipPoolRegistration If true, the analyzer won't be registered with a pool
     */
    constructor(
        private readonly extensionPath: string,
        private skipPoolRegistration: boolean = false
    ) {
        if (!skipPoolRegistration) {
            this.pool = TreeStructureAnalyzerPool.getInstance();
        }
    }

    /**
     * Initialize the Tree-sitter parser
     */
    public async initialize(): Promise<void> {
        try {
            if (this.isInitialized || this.isDisposed) return;

            this.parser = new Parser();
            this.isInitialized = true;
            console.log('TreeStructureAnalyzer instance initialized');
        } catch (error) {
            console.error('Error initializing TreeStructureAnalyzer instance:', error);
            throw error;
        }
    }

    /**
     * Ensure the analyzer is initialized before proceeding
     */
    private async ensureInitialized(): Promise<void> {
        if (this.isDisposed) {
            throw new Error('TreeStructureAnalyzer has been disposed');
        }

        if (!this.isInitialized) {
            await this.initialize();
        }

        if (!this.parser) {
            throw new Error('Tree-sitter parser is not available');
        }
    }

    /**
     * Get the path to a WASM grammar file
     * @param grammarName Base name of the grammar file
     * @param variant Optional variant for languages with variants
     * @returns Path to the WASM grammar file
     */
    private getWasmGrammarPath(grammarName: string, variant?: string): string {
        // Base path for grammar files
        const grammarBasePath = path.join(this.extensionPath, 'dist', 'grammars');

        // Use variant if specified
        if (variant) {
            return path.join(grammarBasePath, `${grammarName}-${variant}.wasm`);
        }

        // Default case
        return path.join(grammarBasePath, `${grammarName}.wasm`);
    }

    /**
     * Load a language parser for the given language
     * @param languageId Language identifier (e.g. 'typescript')
     * @param variant Optional variant (e.g. 'tsx')
     * @returns Tree-sitter Language instance
     */
    private async loadLanguageParser(languageId: string, variant?: string): Promise<Parser.Language> {
        // Create a cache key that includes variant information
        const cacheKey = variant ? `${languageId}-${variant}` : languageId;

        if (this.languageParsers.has(cacheKey)) {
            return this.languageParsers.get(cacheKey)!;
        }

        try {
            // Find the language details from SUPPORTED_LANGUAGES
            const supportedLanguage = Object.values(SUPPORTED_LANGUAGES)
                .find(lang => lang.language === languageId &&
                    (!variant || lang.variant === variant));

            if (!supportedLanguage || !supportedLanguage.treeSitterGrammar) {
                throw new Error(`Language '${languageId}${variant ? ' (' + variant + ')' : ''}' is not supported by TreeStructureAnalyzer`);
            }

            // Get the grammar WASM file path
            const wasmPath = this.getWasmGrammarPath(supportedLanguage.treeSitterGrammar, supportedLanguage.variant);

            // Load the language from the WASM file
            const language = await Parser.Language.load(wasmPath);

            // Store the language in cache
            this.languageParsers.set(cacheKey, language);

            return language;
        } catch (error) {
            console.error(`Error loading language parser for ${languageId}${variant ? ' (' + variant + ')' : ''}:`, error);
            throw new Error(`Failed to load language parser: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Get the language for a file based on its extension
     * @param filePath The file path
     * @returns Language identifier and variant or null if not supported
     */
    public getFileLanguage(filePath: string): { language: string, variant?: string } | null {
        const extension = path.extname(filePath).substring(1).toLowerCase();
        const langData = getLanguageForExtension(extension);

        if (!langData) {
            return null;
        }

        return {
            language: langData.language,
            variant: langData.variant
        };
    }

    /**
     * Parse a file content into a tree-sitter tree
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant (like 'tsx')
     * @returns Tree-sitter tree
     */
    public async parseContent(
        content: string,
        language: string,
        variant?: string
    ): Promise<Parser.Tree | null> {
        await this.ensureInitialized();

        let tree: Parser.Tree | null = null;
        try {
            const lang = await this.loadLanguageParser(language, variant);
            this.parser!.setLanguage(lang);
            tree = this.parser!.parse(content);
            return tree;
        } catch (error) {
            console.error(`Error parsing ${language}${variant ? ' (' + variant + ')' : ''} content:`, error);
            if (tree) {
                tree.delete();
            }
            throw new Error(`Parsing error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Find all function declarations in a file
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Array of function structures
     */
    public async findFunctions(
        content: string,
        language: string,
        variant?: string
    ): Promise<CodeStructure[]> {
        return this.findStructures(
            content,
            language,
            'functionQueries',
            [
                'class_specifier', 'struct_specifier', 'namespace_definition',
                'class_declaration', 'struct_declaration', 'interface_declaration',
                'enum_declaration', 'namespace_declaration', 'module',
                'enum_specifier', 'template_declaration'
            ],
            (node) => {
            // Check if this is a function-like node
                return node.type.includes('function') ||
                    node.type.includes('method') ||
                    node.type.includes('procedure');
            },
            variant
        );
    }

    /**
     * Find all class declarations in a file
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Array of class structures
     */
    public async findClasses(
        content: string,
        language: string,
        variant?: string
    ): Promise<CodeStructure[]> {
        return this.findStructures(content, language, 'classQueries', [
            'namespace_definition', 'namespace_declaration', 'module'
        ], (node) => {
            // Check if this is a class-like node
            const isClassLike = node.type.includes('class') ||
                node.type.includes('struct') ||
                node.type.includes('interface') ||
                node.type.includes('enum');

            return isClassLike;
        }, variant);
    }

    /**
     * Generic method to find code structures (functions, classes, etc.) using tree-sitter queries
     * @param content File content
     * @param language Language identifier
     * @param queryType Type of queries to use: 'functionQueries' or 'classQueries'
     * @param contextNodesTypes Types of nodes to consider as potential parents/containers
     * @param contextNodeCheck Function to determine if a node is a child of a context node
     * @param variant Optional language variant
     * @returns Array of code structures
     */
    private async findStructures(
        content: string,
        language: string,
        queryType: 'functionQueries' | 'classQueries',
        contextNodesTypes: string[],
        contextNodeCheck: (node: Parser.SyntaxNode) => boolean,
        variant?: string
    ): Promise<CodeStructure[]> {
        await this.ensureInitialized();

        let tree = null;
        const structures: CodeStructure[] = [];
        // Map to track processed nodes by type+range instead of just text to better handle templates
        const processedNodeMap = new Map<string, boolean>();

        try {
            tree = await this.parseContent(content, language, variant);
            if (!tree) {
                console.error(`Parsing returned null for ${language}${variant ? ' (' + variant + ')' : ''}`);
                return [];
            }

            const config = TREE_SITTER_LANGUAGE_CONFIGS[language];
            if (!config || !config[queryType] || config[queryType].length === 0) {
                console.warn(`No ${queryType} defined for language '${language}'`);
                return [];
            }

            const rootNode = tree.rootNode;

            // Find context nodes (classes, namespaces, etc.) to establish parent relationships
            const contextNodes: Parser.SyntaxNode[] = [];
            this.findNodesOfType(rootNode, contextNodesTypes, contextNodes);

            // Map of node IDs to their parent context
            const nodeContextMap = new Map<number, { node: Parser.SyntaxNode, name?: string, type: string }>();

            // Build a map of parent contexts for faster lookup
            for (const contextNode of contextNodes) {
                const contextName = this.extractNodeName(contextNode, language);
                const contextType = contextNode.type;

                // Find all relevant nodes within this context that should be associated with it
                this.findChildNodesWithinRange(contextNode, (node) => {
                    if (contextNodeCheck(node)) {
                        nodeContextMap.set(node.id, {
                            node: contextNode,
                            name: contextName,
                            type: contextType
                        });
                    }
                    return false; // Continue searching
                });
            }

            // Process each query pattern in the configuration
            for (const queryString of config[queryType]) {
                try {
                    const currentLang = await this.loadLanguageParser(language, variant);
                    const query = currentLang.query(queryString);

                    try {
                        // Get all matches for this query
                        const matches = query.matches(rootNode);

                        // Process each match
                        for (const match of matches) {
                            // Group captures by name
                            const captureMap = new Map<string, Parser.SyntaxNode>();
                            const comments: Parser.SyntaxNode[] = [];
                            const trailingComments: Parser.SyntaxNode[] = [];
                            let captureNode: Parser.SyntaxNode | undefined = undefined;

                            for (const capture of match.captures) {
                                if (capture.name === 'comment') {
                                    comments.push(capture.node);
                                } else if (capture.name === 'trailingComment') {
                                    trailingComments.push(capture.node);
                                } else if (capture.name === 'capture' && !captureNode) {
                                    // Primary 'capture' node takes precedence
                                    captureNode = capture.node;
                                } else {
                                    // Store all other nodes by capture name
                                    captureMap.set(capture.name, capture.node);
                                }
                            }

                            // Determine the main structure node
                            let mainNode: Parser.SyntaxNode | undefined;

                            // Search for the main node in specific order of priority
                            const nodeTypes = ['class', 'function', 'method', 'struct', 'interface',
                                'enum', 'namespace', 'module', 'trait', 'impl'];

                            for (const type of nodeTypes) {
                                if (captureMap.has(type)) {
                                    mainNode = captureMap.get(type);
                                    break;
                                }
                            }

                            // If no specific type found but we have a capture node, use that
                            if (!mainNode && captureNode) {
                                // For template declarations, find the actual class/function inside
                                if (captureNode.type === 'template_declaration') {
                                    // Find the first child that's a class or function
                                    for (let i = 0; i < captureNode.childCount; i++) {
                                        const child = captureNode.child(i);
                                        if (child && (
                                            child.type.includes('class') ||
                                            child.type.includes('struct') ||
                                            child.type.includes('function')
                                        )) {
                                            // Use the template node as mainNode, but store the inner node type
                                            mainNode = captureNode;
                                            break;
                                        }
                                    }
                                } else {
                                    mainNode = captureNode;
                                }
                            }

                            if (!mainNode) continue; // Skip if no suitable node found

                            // Create a unique key for deduplication based on node type and position
                            // This handles template classes properly by including position information
                            const nodeKey = `${mainNode.type}_${mainNode.startPosition.row}_${mainNode.startPosition.column}_${mainNode.endPosition.row}_${mainNode.endPosition.column}`;

                            // Skip if we've already processed this node
                            if (processedNodeMap.has(nodeKey)) continue;
                            processedNodeMap.set(nodeKey, true);

                            // Sort comments by position
                            comments.sort((a, b) => a.startIndex - b.startIndex);
                            trailingComments.sort((a, b) => a.startIndex - b.startIndex);

                            // Determine the full range including comments
                            let startPosition = mainNode.startPosition;
                            if (comments.length > 0 && comments[0].startIndex < mainNode.startIndex) {
                                startPosition = comments[0].startPosition;
                            }

                            let endPosition = mainNode.endPosition;
                            if (trailingComments.length > 0) {
                                const lastTrailingComment = trailingComments[trailingComments.length - 1];
                                endPosition = lastTrailingComment.endPosition;
                            }

                            // Extract the full text content including comments
                            const startOffset = this.positionToOffset(startPosition, content) || mainNode.startIndex;
                            const endOffset = this.positionToOffset(endPosition, content) || mainNode.endIndex;
                            const text = content.substring(startOffset, endOffset);

                            // Find parent context if available
                            let parentContext: { type: string; name?: string } | undefined = undefined;
                            const contextInfo = nodeContextMap.get(mainNode.id);
                            if (contextInfo) {
                                parentContext = {
                                    type: contextInfo.type,
                                    name: contextInfo.name
                                };
                            }

                            // Create and add the structure
                            const structure: CodeStructure = {
                                type: mainNode.type,
                                text: text,
                                range: {
                                    startPosition: startPosition,
                                    endPosition: endPosition,
                                },
                                parentContext: parentContext,
                            };

                            structures.push(structure);
                        }
                    } finally {
                        // Clean up query
                        query.delete();
                    }
                } catch (error) {
                    console.error(`Error running ${queryType} "${queryString}" for ${language}:`, error);
                    // Continue with other queries even if one fails
                }
            }

            return structures;
        } catch (error) {
            console.error(`Error finding structures in ${language}${variant ? ' (' + variant + ')' : ''} content:`, error);
            return [];
        } finally {
            // Clean up tree
            if (tree) {
                tree.delete();
            }
        }
    }

    /**
     * Helper method to find all nodes of specific types
     */
    private findNodesOfType(node: Parser.SyntaxNode, types: string[], result: Parser.SyntaxNode[]): void {
        if (types.includes(node.type)) {
            result.push(node);
        }

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                this.findNodesOfType(child, types, result);
            }
        }
    }

    /**
     * Helper method to find child nodes within a range that match a predicate
     * @param node The parent node to search within
     * @param predicate A function that returns true if the node should be included
     */
    private findChildNodesWithinRange(node: Parser.SyntaxNode, predicate: (node: Parser.SyntaxNode) => boolean): void {
        // Check if this node matches the predicate
        const shouldInclude = predicate(node);

        // If the predicate returns true, we're done with this branch
        if (shouldInclude) {
            return;
        }

        // Otherwise, recursively check all children
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                this.findChildNodesWithinRange(child, predicate);
            }
        }
    }

    /**
     * Helper to convert a Tree-sitter node to a CodeRange
    */
    private nodeToCodeRange(node: Parser.SyntaxNode): CodeRange {
        return {
            startPosition: node.startPosition,
            endPosition: node.endPosition,
        };
    }

    /**
     * Helper to extract a meaningful name from a Tree-sitter node
     */
    private extractNodeName(node: Parser.SyntaxNode, language: string): string | undefined {
        // Common field name patterns to try, in order of preference
        const commonFields = ['name', 'id', 'identifier'];

        // First try direct child field access - most common case
        for (const fieldName of commonFields) {
            const nameNode = node.childForFieldName(fieldName);
            if (nameNode) return nameNode.text;
        }

        // Try to find identifier nodes - common in many languages
        const identifierTypes = ['identifier', 'property_identifier', 'type_identifier', 'field_identifier'];
        const identifiers = node.descendantsOfType(identifierTypes);
        if (identifiers.length > 0) {
            // First identifier is usually the name
            return identifiers[0].text;
        }

        // Special handling for function declarations in languages with complex declarators
        if (node.type.includes('function')) {
            const declarator = node.childForFieldName('declarator');
            if (declarator) {
                // Try to find identifier in the declarator
                const identifiersInDeclarator = declarator.descendantsOfType(identifierTypes);
                if (identifiersInDeclarator.length > 0) {
                    return identifiersInDeclarator[0].text;
                }
            }
        }

        // For anonymous functions assigned to variables, try to find parent variable declarator
        if (node.type.includes('function') || node.type === 'arrow_function') {
            let parent = node.parent;
            while (parent) {
                if (parent.type === 'variable_declarator' || parent.type === 'pair') {
                    const nameNode = parent.childForFieldName('name') || parent.childForFieldName('key');
                    if (nameNode) return nameNode.text;
                }
                parent = parent.parent;
            }
        }

        // For CSS rule sets, get selectors
        if (node.type === 'rule_set' || node.type.includes('selector')) {
            const selectors = node.childForFieldName('selectors');
            if (selectors) return selectors.text;
        }

        // For type declarations that might have a generic type parameter
        if (node.type.includes('class') || node.type.includes('interface') || node.type.includes('type')) {
            // First try direct field access
            const nameNode = node.childForFieldName('name');
            if (nameNode) return nameNode.text;

            // Then try to find a type identifier
            const typeIds = node.descendantsOfType(['type_identifier']);
            if (typeIds.length > 0) {
                return typeIds[0].text;
            }
        }

        return undefined; // Return undefined if no name found
    }

    /**
     * Convert a position to a character offset
     * @param position Position in the document
     * @param content File content
     * @returns Character offset or null if invalid
     */
    public positionToOffset(position: Parser.Point, content: string): number | null {
        const lines = content.split('\n');

        if (position.row >= lines.length) {
            return null; // Row out of bounds
        }

        let offset = 0;
        for (let i = 0; i < position.row; i++) {
            if (lines[i] === undefined) return null; // Should not happen if row is in bounds
            offset += lines[i].length + 1; // +1 for the newline
        }

        // Check column bounds for the target row
        if (lines[position.row] === undefined || position.column > lines[position.row].length) {
            // Allow column to be equal to length (position after last char)
            if (lines[position.row] !== undefined && position.column === lines[position.row].length) {
                // This is valid, position at the end of the line
            } else {
                return null; // Column out of bounds
            }
        }

        offset += position.column;
        // Ensure offset does not exceed content length
        return Math.min(offset, content.length);
    }

    /**
     * Find standalone comments in the code
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Array of comment structures
     */
    public async findStandaloneComments(
        content: string,
        language: string,
        variant?: string
    ): Promise<CodeStructure[]> {
        await this.ensureInitialized();

        let tree = null;
        let query = null;

        try {
            tree = await this.parseContent(content, language, variant);
            if (!tree) {
                console.error(`Parsing returned null for ${language}${variant ? ' (' + variant + ')' : ''}`);
                return [];
            }

            const rootNode = tree.rootNode;
            const comments: CodeStructure[] = [];
            const processedNodes = new Set<number>(); // Keep track of nodes already processed

            // Create a query to find all comments
            const currentLang = await this.loadLanguageParser(language, variant);
            query = currentLang.query('(comment) @comment');

            // Get all comment nodes
            const matches = query.matches(rootNode);

            for (const match of matches) {
                for (const capture of match.captures) {
                    if (capture.name === 'comment') {
                        const commentNode = capture.node;

                        if (!processedNodes.has(commentNode.id)) {
                            processedNodes.add(commentNode.id);

                            const range = this.nodeToCodeRange(commentNode);
                            const commentText = content.substring(commentNode.startIndex, commentNode.endIndex);

                            comments.push({
                                type: 'standalone_comment',
                                range: range,
                                text: commentText,
                            });
                        }
                    }
                }
            }

            return comments;
        } catch (error) {
            console.error(`Error finding standalone comments in ${language}${variant ? ' (' + variant + ')' : ''} content:`, error);
            return [];
        } finally {
            // Clean up resources
            if (tree) {
                tree.delete();
            }
            if (query) {
                query.delete();
            }
        }
    }

    /**
     * Find all major structures (functions, classes, etc.)
     */
    public async findAllStructures(
        content: string,
        language: string,
        variant?: string
    ): Promise<CodeStructure[]> {
        // First, find all functions and classes independently
        // Find all functions and classes using the refined queries
        const functions = await this.findFunctions(content, language, variant);
        const classes = await this.findClasses(content, language, variant);

        // Combine functions and classes into a single list
        let allFoundStructures: CodeStructure[] = [...functions, ...classes];

        // --- Find File Header Comment ---
        let fileHeaderComment: CodeStructure | null = null;
        const tree = await this.parseContent(content, language, variant);
        if (tree) {
            const rootNode = tree.rootNode;
            if (rootNode.childCount > 0) {
                let firstNode = rootNode.child(0);
                // Skip potential BOM or shebang
                while (firstNode && (firstNode.type === 'bom' || firstNode.type === 'hash_bang_line')) {
                    firstNode = firstNode.nextSibling;
                }
                if (firstNode && firstNode.type === 'comment') {
                    // Check if it starts at the beginning of the file
                    if (firstNode.startPosition.row === 0 && firstNode.startPosition.column === 0) {
                        const commentText = content.substring(firstNode.startIndex, firstNode.endIndex);
                        fileHeaderComment = {
                            type: 'file_header_comment',
                            range: this.nodeToCodeRange(firstNode),
                            text: commentText,
                        };
                        // Add header comment to the list if found
                        allFoundStructures.unshift(fileHeaderComment);
                    }
                }
            }
            tree.delete(); // Clean up the tree
        }

        return allFoundStructures;
    }

    /**
     * Find the best breakpoints for chunking code that respect structure boundaries
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Array of recommended break positions sorted by quality
     */
    public async findStructureBreakPoints(
        content: string,
        language: string,
        variant?: string
    ): Promise<Array<{ position: number, quality: number }>> {
        try {
            const breakPoints: Array<{ position: number, quality: number }> = [];

            // Combine all relevant structures
            const structures = await this.findAllStructures(content, language, variant);

            // Add structure start and end points as high-quality break points
            for (const struct of structures) {
                const startOffset = this.positionToOffset(struct.range.startPosition, content);
                const endOffset = this.positionToOffset(struct.range.endPosition, content);

                if (startOffset !== null) {
                    // Break *before* a structure starts (medium quality)
                    breakPoints.push({ position: startOffset, quality: 7 });
                }
                if (endOffset !== null) {
                    // Break *after* a structure ends (high quality)
                    breakPoints.push({ position: endOffset, quality: 10 });
                }
            }

            // Add blank lines as lower quality break points
            const blankLineMatches = content.matchAll(/\n\s*\n/g);
            for (const match of blankLineMatches) {
                if (match.index !== undefined) {
                    // Avoid adding blank line breaks inside structures if possible
                    const breakPos = match.index + match[0].length;
                    const isInStructure = structures.some(s => {
                        const startOffset = this.positionToOffset(s.range.startPosition, content);
                        const endOffset = this.positionToOffset(s.range.endPosition, content);
                        return startOffset !== null && endOffset !== null &&
                            breakPos > startOffset && breakPos < endOffset;
                    });
                    breakPoints.push({
                        position: breakPos,
                        quality: isInStructure ? 3 : 5 // Lower quality if inside a structure
                    });
                }
            }

            // Remove duplicates and sort by position
            const uniqueBreakPoints = Array.from(new Map(breakPoints.map(item => [item.position, item])).values());
            uniqueBreakPoints.sort((a, b) => a.position - b.position);

            return uniqueBreakPoints;
        } catch (error) {
            console.error(`Error finding structure break points:`, error);

            // Fallback to simple line breaks if parsing fails
            const lineBreaks = Array.from(content.matchAll(/;\s*\n|}\s*\n|\n\s*\n/g))
                .filter(match => match.index !== undefined)
                .map(match => ({
                    position: (match.index as number) + match[0].length,
                    quality: 3 // Lower quality
                }));

            return lineBreaks;
        }
    }

    /**
     * Check if a given position is inside any function declaration
     * @param content File content
     * @param language Language identifier
     * @param position Position to check
     * @param variant Optional language variant
     * @returns The function structure if position is inside a function, null otherwise
     */
    public async isPositionInsideFunction(
        content: string,
        language: string,
        position: Parser.Point,
        variant?: string
    ): Promise<CodeStructure | null> {
        try {
            const functions = await this.findFunctions(content, language, variant);

            for (const func of functions) {
                // Use contentRange for checking if position is within the core code
                if (this.isPositionInsideRange(position, func.range)) {
                    return func;
                }
            }

            return null;
        } catch (error) {
            console.error(`Error checking if position is inside function:`, error);
            return null;
        }
    }

    /**
     * Check if a position is inside a range
     * @param position Position to check
     * @param range Range to check against
     * @returns True if position is inside the range
     */
    private isPositionInsideRange(position: Parser.Point, range: CodeRange): boolean {
        // Check if position is after or at the start position
        if (position.row > range.startPosition.row ||
            (position.row === range.startPosition.row && position.column >= range.startPosition.column)) {

            // Check if position is before or at the end position
            if (position.row < range.endPosition.row ||
                (position.row === range.endPosition.row && position.column <= range.endPosition.column)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get the hierarchy of structures at a given position
     * @param content File content
     * @param language Language identifier
     * @param position Position to check
     * @param variant Optional language variant
     * @returns Array of structures from outermost to innermost
     */
    public async getStructureHierarchyAtPosition(
        content: string,
        language: string,
        position: Parser.Point,
        variant?: string
    ): Promise<CodeStructure[]> {
        try {
            const allStructures = await this.findAllStructures(content, language, variant);
            const containingStructures: CodeStructure[] = [];

            // Find all structures that contain this position
            for (const structure of allStructures) {
                if (this.isPositionInsideRange(position, structure.range)) {
                    containingStructures.push(structure);
                }
            }

            // Sort from outermost to innermost
            containingStructures.sort((a, b) => {
                // Calculate size of each range
                const aSize = (a.range.endPosition.row - a.range.startPosition.row) * 10000 +
                    (a.range.endPosition.column - a.range.startPosition.column);
                const bSize = (b.range.endPosition.row - b.range.startPosition.row) * 10000 +
                    (b.range.endPosition.column - b.range.startPosition.column);

                // Larger ranges first (outermost to innermost)
                return bSize - aSize;
            });

            return containingStructures;
        } catch (error) {
            console.error(`Error getting structure hierarchy at position:`, error);
            return [];
        }
    }

    /**
     * Check if a language is supported by the analyzer
     * @param language The language to check
     * @returns True if the language is supported
     */
    public async supportsLanguage(language: string): Promise<boolean> {
        await this.ensureInitialized();

        try {
            // Check if the language is in our language configs
            return language in TREE_SITTER_LANGUAGE_CONFIGS;
        } catch (error) {
            console.error(`Error checking if language ${language} is supported:`, error);
            return false;
        }
    }

    /**
     * Return analyzer to the pool when done
     * Use with resource pattern:
     * const analyzer = await pool.getAnalyzer();
     * try {
     *   // use analyzer
     * } finally {
     *   analyzer.release();
     * }
     */
    public release(): void {
        if (!this.isDisposed && !this.skipPoolRegistration && this.pool) {
            this.pool.releaseAnalyzer(this);
        }
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        if (this.isDisposed) return;

        if (this.parser) {
            try {
                this.parser.delete();
            } catch (error) {
                console.error('Error disposing Tree-sitter parser:', error);
            }
            this.parser = null;
        }

        // Clear language parsers cache
        this.languageParsers.clear();
        this.isInitialized = false;
        this.isDisposed = true;
        // Reset initialization state
    }
}

/**
 * Resource manager for TreeStructureAnalyzer to ensure proper cleanup
 * Usage:
 * async function example() {
 *   const resource = await TreeStructureAnalyzerResource.create();
 *   try {
 *     const analyzer = resource.instance;
 *     // use analyzer methods
 *   } finally {
 *     resource.dispose();
 *   }
 * }
 */
export class TreeStructureAnalyzerResource implements vscode.Disposable {
    private constructor(
        public readonly instance: TreeStructureAnalyzer
    ) { }

    /**
     * Create a new analyzer resource
     */
    public static async create(): Promise<TreeStructureAnalyzerResource> {
        const pool = TreeStructureAnalyzerPool.getInstance();
        const analyzer = await pool.getAnalyzer();
        return new TreeStructureAnalyzerResource(analyzer);
    }

    /**
     * Dispose the analyzer by returning it to the pool
     */
    public dispose(): void {
        this.instance.release();
    }
}

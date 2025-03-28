import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { SUPPORTED_LANGUAGES, getLanguageForExtension } from '../types/types';
import * as path from 'path';

/**
 * Represents a code node position in a file
 */
export interface CodePosition {
    row: number;    // 0-based row
    column: number; // 0-based column
}

/**
 * Represents a code range in a file
 */
export interface CodeRange {
    startPosition: CodePosition;
    endPosition: CodePosition;
}

/**
 * Describes a code structure element (function, class, etc.)
 */
export interface CodeStructure {
    type: string;           // Node type (e.g., "function_declaration", "class_declaration")
    name?: string;          // Name of the node if available
    range: CodeRange;       // Position range in the document (including comments/decorators)
    contentRange: CodeRange; // Position range of the core code content (excluding comments/decorators)
    children: CodeStructure[]; // Child structures
    parent?: CodeStructure; // Parent structure
    text: string;           // The text content of this structure (including comments/decorators)
    comment?: string;       // Associated comment text, if found
}

/**
 * Language-specific configuration for tree-sitter parsing
 */
export interface LanguageConfig {
    functionQueries: string[];    // Queries to find function declarations
    classQueries: string[];       // Queries to find class declarations
    methodQueries: string[];      // Queries to find method declarations
    blockQueries: string[];       // Queries to find block statements
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
            waiting(new TreeStructureAnalyzer(this.extensionPath, true));
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
    private initPromise: Promise<void> | null = null;
    private pool: TreeStructureAnalyzerPool | null = null;
    private isDisposed = false;

    // Language configurations for tree-sitter
    // Queries aim to capture the main node (@...) and optionally preceding comments (@comment) or decorators (@decorator)
    // A @capture node can be used to define the overall range including comments/decorators
    private readonly languageConfigs: Record<string, LanguageConfig> = {
        'javascript': {
            functionQueries: [
                `
                (program . (comment)* . (function_declaration) @function) @capture
                `,
                `
                (program . (comment)* . (export_statement . (function_declaration) @function)) @capture
                `,
                `
                (program . (comment)* . (expression_statement (assignment_expression
                    left: (_)
                    right: [(arrow_function) (function)] @function
                ))) @capture
                `,
                `
                (program . (comment)* . (lexical_declaration (variable_declarator
                    name: (_)
                    value: [(arrow_function) (function)] @function
                ))) @capture
                `,
                // Method definitions within classes
                `
                (class_body . (comment)* . (method_definition) @function) @capture
                `
            ],
            classQueries: [
                `
                (program . (comment)* . (decorator)* . (class_declaration) @class) @capture
                `,
                `
                (program . (comment)* . (export_statement . (decorator)* . (class_declaration) @class)) @capture
                `
                // Note: Simple objects `(object) @object` are less useful as top-level structures
            ],
            // Method queries are implicitly covered by function queries within class_body
            methodQueries: [],
            blockQueries: ['(statement_block) @block']
        },
        'typescript': {
            functionQueries: [
                `
                (program . (comment)* . (function_declaration) @function) @capture
                `,
                `
                (program . (comment)* . (export_statement . (function_declaration) @function)) @capture
                `,
                `
                (program . (comment)* . (expression_statement (assignment_expression
                    left: (_)
                    right: [(arrow_function) (function)] @function
                ))) @capture
                `,
                `
                (program . (comment)* . (lexical_declaration (variable_declarator
                    name: (_)
                    value: [(arrow_function) (function)] @function
                ))) @capture
                `,
                // Method definitions within classes/interfaces
                `
                (_ . (comment)* . (method_definition) @function) @capture
                `,
                `
                (_ . (comment)* . (method_signature) @function) @capture
                `
            ],
            classQueries: [
                `
                (program . (comment)* . (decorator)* . (class_declaration) @class) @capture
                `,
                `
                (program . (comment)* . (export_statement . (decorator)* . (class_declaration) @class)) @capture
                `,
                `
                (program . (comment)* . (interface_declaration) @interface) @capture
                `,
                `
                (program . (comment)* . (export_statement . (interface_declaration) @interface)) @capture
                `,
                `
                (program . (comment)* . (enum_declaration) @enum) @capture
                `,
                `
                (program . (comment)* . (export_statement . (enum_declaration) @enum)) @capture
                `,
                `
                (program . (comment)* . (type_alias_declaration) @type) @capture
                `,
                `
                (program . (comment)* . (export_statement . (type_alias_declaration) @type)) @capture
                `
            ],
            // Method queries are implicitly covered by function queries within class_body/interface_body
            methodQueries: [],
            blockQueries: ['(statement_block) @block']
        },
        'python': {
            // Includes decorators and preceding comments
            functionQueries: [`((comment)* . (decorator)* . (function_definition) @function) @capture`],
            classQueries: [`((comment)* . (decorator)* . (class_definition) @class) @capture`],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'java': {
            // Includes annotations and preceding comments
            functionQueries: [`((comment)* . (marker_annotation)* . (method_declaration) @function) @capture`, `((comment)* . (marker_annotation)* . (constructor_declaration) @function) @capture`],
            classQueries: [`((comment)* . (marker_annotation)* . (class_declaration) @class) @capture`, `((comment)* . (marker_annotation)* . (interface_declaration) @interface) @capture`, `((comment)* . (marker_annotation)* . (enum_declaration) @enum) @capture`],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'cpp': {
            // Includes preceding comments
            functionQueries: [`((comment)* . (function_definition) @function) @capture`, `((comment)* . (declaration type: (_) declarator: (function_declarator)) @function) @capture`],
            classQueries: [`((comment)* . (class_specifier) @class) @capture`, `((comment)* . (struct_specifier) @struct) @capture`, `((comment)* . (namespace_definition) @namespace) @capture`],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(compound_statement) @block']
        },
        'c': {
            // Includes preceding comments
            functionQueries: [`((comment)* . (function_definition) @function) @capture`, `((comment)* . (declaration type: (_) declarator: (function_declarator)) @function) @capture`],
            classQueries: [`((comment)* . (struct_specifier) @struct) @capture`, `((comment)* . (enum_specifier) @enum) @capture`],
            methodQueries: [],
            blockQueries: ['(compound_statement) @block']
        },
        'csharp': {
            // Includes attributes and preceding comments
            functionQueries: [`((comment)* . (attribute_list)* . (method_declaration) @function) @capture`, `((comment)* . (attribute_list)* . (constructor_declaration) @function) @capture`],
            classQueries: [`((comment)* . (attribute_list)* . (class_declaration) @class) @capture`, `((comment)* . (attribute_list)* . (interface_declaration) @interface) @capture`, `((comment)* . (attribute_list)* . (struct_declaration) @struct) @capture`, `((comment)* . (attribute_list)* . (enum_declaration) @enum) @capture`, `((comment)* . (namespace_declaration) @namespace) @capture`],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'go': {
            // Includes preceding comments
            functionQueries: [`((comment)* . (function_declaration) @function) @capture`, `((comment)* . (method_declaration) @method) @capture`],
            classQueries: [`((comment)* . (type_declaration) @type) @capture`, `((comment)* . (struct_type) @struct) @capture`],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'ruby': {
            // Includes preceding comments
            functionQueries: [`((comment)* . (method) @function) @capture`, `((comment)* . (singleton_method) @function) @capture`],
            classQueries: [`((comment)* . (class) @class) @capture`, `((comment)* . (module) @module) @capture`],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(do_block) @block', '(block) @block']
        },
        'rust': {
            // Includes attributes and preceding comments
            functionQueries: [`((comment)* . (attribute_item)* . (function_item) @function) @capture`, `((comment)* . (attribute_item)* . (function_signature_item) @function) @capture`],
            classQueries: [`((comment)* . (attribute_item)* . (struct_item) @struct) @capture`, `((comment)* . (attribute_item)* . (trait_item) @trait) @capture`, `((comment)* . (attribute_item)* . (impl_item) @impl) @capture`, `((comment)* . (attribute_item)* . (enum_item) @enum) @capture`, `((comment)* . (attribute_item)* . (mod_item) @module) @capture`],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'css': {
            functionQueries: [], // CSS doesn't have functions in the typical sense
            classQueries: [`((comment)* . (rule_set) @rule) @capture`, `((comment)* . (at_rule) @at_rule) @capture`], // Treat rules like structures
            methodQueries: [],
            blockQueries: ['(block) @block']
        }
    };

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
        await this.ensureInitialized();

        let tree = null;
        let queries = [];

        try {
            tree = await this.parseContent(content, language, variant);
            if (!tree) {
                console.error(`Parsing returned null for ${language}${variant ? ' (' + variant + ')' : ''}`);
                return [];
            }

            const config = this.languageConfigs[language];
            if (!config || !config.functionQueries) { // Check if functionQueries exists
                console.warn(`No function queries defined for language '${language}'`);
                return [];
            }

            const rootNode = tree.rootNode;
            const functions: CodeStructure[] = [];
            const processedNodes = new Set<number>(); // Keep track of nodes already processed

            for (const queryString of config.functionQueries) {
                try {
                    const currentLang = await this.loadLanguageParser(language, variant);
                    const query = currentLang.query(queryString);
                    queries.push(query);

                    // Use matches() which provides more context than captures()
                    const matches = query.matches(rootNode);

                    for (const match of matches) {
                        let functionNode: Parser.SyntaxNode | null = null;
                        let commentNode: Parser.SyntaxNode | null = null;
                        let captureNode: Parser.SyntaxNode | null = null; // The overall capture, e.g., including comments

                        for (const capture of match.captures) {
                            if (capture.name === 'function') {
                                functionNode = capture.node;
                            } else if (capture.name === 'comment') {
                                // Capture the first comment node found before the function
                                if (!commentNode) commentNode = capture.node;
                            } else if (capture.name === 'capture') {
                                captureNode = capture.node;
                            }
                        }

                        if (functionNode && !processedNodes.has(functionNode.id)) {
                            processedNodes.add(functionNode.id);

                            // Determine the full range (including comments/decorators if captured)
                            const contentRange = this.nodeToCodeRange(functionNode);
                            const range = captureNode ? this.nodeToCodeRange(captureNode) : contentRange;
                            const commentText = commentNode ? content.substring(commentNode.startIndex, commentNode.endIndex) : undefined;

                            // Find the function name
                            let name = this.extractNodeName(functionNode, language);

                            functions.push({
                                type: functionNode.type,
                                name: name,
                                range: range,
                                contentRange: contentRange, // Add contentRange
                                children: [],
                                text: content.substring(this.positionToOffset(range.startPosition, content)!, this.positionToOffset(range.endPosition, content)!), // Correctly use range offsets for text
                                comment: commentText
                            });
                        }
                    }
                } catch (error) {
                    console.error(`Error running function query "${queryString}" for ${language}:`, error);
                    // Continue with other queries even if one fails
                }
            }

            return functions;
        } catch (error) {
            console.error(`Error finding functions in ${language}${variant ? ' (' + variant + ')' : ''} content:`, error);
            return [];
        } finally {
            // Clean up resources
            if (tree) {
                tree.delete();
            }

            for (const query of queries) {
                query.delete();
            }
        }
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
        await this.ensureInitialized();

        let tree = null;
        let queries = [];

        try {
            tree = await this.parseContent(content, language, variant);
            if (!tree) {
                console.error(`Parsing returned null for ${language}${variant ? ' (' + variant + ')' : ''}`);
                return [];
            }

            const config = this.languageConfigs[language];
            if (!config || !config.classQueries) { // Check if classQueries exists
                console.warn(`No class/structure queries defined for language '${language}'`);
                return [];
            }

            const rootNode = tree.rootNode;
            const structures: CodeStructure[] = [];
            const processedNodes = new Set<number>(); // Keep track of nodes already processed

            for (const queryString of config.classQueries) { // Includes classes, interfaces, enums, types
                try {
                    const currentLang = await this.loadLanguageParser(language, variant);
                    const query = currentLang.query(queryString);
                    queries.push(query);

                    const matches = query.matches(rootNode);

                    for (const match of matches) {
                        let structureNode: Parser.SyntaxNode | null = null;
                        let commentNode: Parser.SyntaxNode | null = null;
                        let captureNode: Parser.SyntaxNode | null = null; // Overall capture

                        // Find the main structure node (@class, @interface, @enum, @type, etc.)
                        for (const capture of match.captures) {
                            if (['class', 'interface', 'enum', 'type', 'struct', 'trait', 'impl', 'module', 'namespace', 'rule', 'at_rule'].includes(capture.name)) {
                                structureNode = capture.node;
                            } else if (capture.name === 'comment') {
                                if (!commentNode) commentNode = capture.node;
                            } else if (capture.name === 'capture') {
                                captureNode = capture.node;
                            }
                        }

                        if (structureNode && !processedNodes.has(structureNode.id)) {
                            processedNodes.add(structureNode.id);

                            const contentRange = this.nodeToCodeRange(structureNode);
                            const range = captureNode ? this.nodeToCodeRange(captureNode) : contentRange;
                            const commentText = commentNode ? content.substring(commentNode.startIndex, commentNode.endIndex) : undefined;
                            let name = this.extractNodeName(structureNode, language);

                            structures.push({
                                type: structureNode.type,
                                name: name,
                                range: range,
                                contentRange: contentRange, // Add contentRange
                                children: [],
                                text: content.substring(this.positionToOffset(range.startPosition, content)!, this.positionToOffset(range.endPosition, content)!), // Use range offsets for text
                                comment: commentText
                            });
                        }
                    }
                } catch (error) {
                    console.error(`Error running class/structure query "${queryString}" for ${language}:`, error);
                    // Continue with other queries even if one fails
                }
            }

            return structures;
        } catch (error) {
            console.error(`Error finding classes/structures in ${language}${variant ? ' (' + variant + ')' : ''} content:`, error);
            return [];
        } finally {
            // Clean up resources
            if (tree) {
                tree.delete();
            }

            for (const query of queries) {
                query.delete();
            }
        }
    }

    /**
    * Helper to convert a Tree-sitter node to a CodeRange
    */
    private nodeToCodeRange(node: Parser.SyntaxNode): CodeRange {
        return {
            startPosition: {
                row: node.startPosition.row,
                column: node.startPosition.column
            },
            endPosition: {
                row: node.endPosition.row,
                column: node.endPosition.column
            }
        };
    }

    /**
     * Helper to extract a meaningful name from a Tree-sitter node
     */
    private extractNodeName(node: Parser.SyntaxNode, language: string): string | undefined {
        let nameNode: Parser.SyntaxNode | null = null;
        let name: string | undefined = undefined;

        // Common field name for identifiers
        nameNode = node.childForFieldName('name');
        if (nameNode) return nameNode.text;

        // Language-specific patterns
        switch (language) {
            case 'javascript':
            case 'typescript':
                if (node.type === 'arrow_function') {
                    let parent = node.parent;
                    while (parent) {
                        if (parent.type === 'variable_declarator' || parent.type === 'pair') {
                            nameNode = parent.childForFieldName('name') || parent.childForFieldName('key');
                            if (nameNode) return nameNode.text;
                        }
                        parent = parent.parent;
                    }
                } else if (node.type === 'method_definition' || node.type === 'method_signature' || node.type === 'function_declaration' || node.type === 'class_declaration' || node.type === 'interface_declaration' || node.type === 'enum_declaration' || node.type === 'type_alias_declaration') {
                    nameNode = node.childForFieldName('name');
                    if (nameNode) return nameNode.text;
                }
                break;
            case 'python':
                nameNode = node.childForFieldName('name');
                if (nameNode) return nameNode.text;
                break;
            case 'java':
            case 'csharp':
                nameNode = node.childForFieldName('name');
                if (nameNode) return nameNode.text;
                // For constructors
                if (node.type === 'constructor_declaration') {
                    nameNode = node.childForFieldName('name'); // C#
                    if (nameNode) return nameNode.text;
                    // Java constructor name matches class name, find parent class
                    let parent = node.parent;
                    while (parent && parent.type !== 'class_declaration') {
                        parent = parent.parent;
                    }
                    if (parent) {
                        nameNode = parent.childForFieldName('name');
                        if (nameNode) return nameNode.text;
                    }
                }
                break;
            case 'c':
            case 'cpp':
                if (node.type === 'function_definition') {
                    const declarator = node.childForFieldName('declarator');
                    // Look for identifier within declarator (might be pointer_declarator etc.)
                    nameNode = declarator?.descendantsOfType('identifier')[0] || null;
                    if (nameNode) return nameNode.text;
                } else if (node.type === 'struct_specifier' || node.type === 'class_specifier' || node.type === 'namespace_definition' || node.type === 'enum_specifier') {
                    nameNode = node.childForFieldName('name');
                    if (nameNode) return nameNode.text;
                }
                break;
            case 'rust':
                nameNode = node.childForFieldName('name');
                if (nameNode) return nameNode.text;
                // For impl blocks, try to get the type name
                if (node.type === 'impl_item') {
                    nameNode = node.childForFieldName('type');
                    if (nameNode) return nameNode.text;
                }
                break;
            case 'go':
                nameNode = node.childForFieldName('name');
                if (nameNode) return nameNode.text;
                // For method declarations, get receiver type
                if (node.type === 'method_declaration') {
                    const receiver = node.childForFieldName('receiver');
                    if (receiver) {
                        // Find type identifier within receiver parameters
                        const typeIdentifier = receiver.descendantsOfType('type_identifier')[0];
                        if (typeIdentifier) return typeIdentifier.text;
                    }
                }
                break;
            case 'ruby':
                nameNode = node.childForFieldName('name');
                if (nameNode) return nameNode.text;
                // For singleton methods, name might be different
                if (node.type === 'singleton_method') {
                    nameNode = node.childForFieldName('name');
                    if (nameNode) return nameNode.text;
                }
                break;
            case 'css':
                if (node.type === 'rule_set') {
                    const selectors = node.childForFieldName('selectors');
                    if (selectors) return selectors.text;
                } else if (node.type === 'at_rule') {
                    nameNode = node.childForFieldName('name');
                    if (nameNode) return nameNode.text;
                }
                break;
            // Add other languages as needed
        }

        return name; // Return undefined if no name found
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
        position: CodePosition,
        variant?: string
    ): Promise<CodeStructure | null> {
        try {
            const functions = await this.findFunctions(content, language, variant);

            for (const func of functions) {
                // Use contentRange for checking if position is within the core code
                if (this.isPositionInsideRange(position, func.contentRange)) {
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
     * Check if a given position is inside any class declaration
     * @param content File content
     * @param language Language identifier
     * @param position Position to check
     * @param variant Optional language variant
     * @returns The class structure if position is inside a class, null otherwise
     */
    public async isPositionInsideClass(
        content: string,
        language: string,
        position: CodePosition,
        variant?: string
    ): Promise<CodeStructure | null> {
        try {
            const classes = await this.findClasses(content, language, variant);

            for (const cls of classes) {
                // Use contentRange for checking if position is within the core code
                if (this.isPositionInsideRange(position, cls.contentRange)) {
                    return cls;
                }
            }

            return null;
        } catch (error) {
            console.error(`Error checking if position is inside class:`, error);
            return null;
        }
    }

    /**
     * Get all structure node boundaries for a file content
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Map of node types to arrays of node boundaries
     */
    public async getAllStructureBoundaries(
        content: string,
        language: string,
        variant?: string
    ): Promise<Map<string, CodeRange[]>> {
        try {
            const result = new Map<string, CodeRange[]>();

            // Get functions
            const functions = await this.findFunctions(content, language, variant);
            result.set('function', functions.map(f => f.range)); // Use full range for boundaries

            // Get classes/structures
            const classes = await this.findClasses(content, language, variant);
            result.set('class', classes.map(c => c.range)); // Use full range for boundaries

            // Add other structure types if needed (e.g., namespaces, modules)
            // const namespaces = await this.findNamespaces(content, language, variant);
            // result.set('namespace', namespaces.map(n => n.range));

            return result;
        } catch (error) {
            console.error(`Error getting structure boundaries:`, error);
            return new Map();
        }
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

            // Add internal breakpoints (e.g., between methods in a class) - Requires more specific queries or tree traversal
            // Example placeholder:
            // const internalBreaks = await this.findInternalBreakpoints(content, language, variant);
            // breakPoints.push(...internalBreaks);

            // Add blank lines as lower quality break points
            const blankLineMatches = content.matchAll(/\n\s*\n/g);
            for (const match of blankLineMatches) {
                if (match.index !== undefined) {
                    // Avoid adding blank line breaks inside structures if possible
                    const breakPos = match.index + match[0].length;
                    const isInStructure = structures.some(s =>
                        breakPos > this.positionToOffset(s.range.startPosition, content)! &&
                        breakPos < this.positionToOffset(s.range.endPosition, content)!
                    );
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
    * Helper to find all major structures (functions, classes, etc.)
    */
    public async findAllStructures(
        content: string,
        language: string,
        variant?: string
    ): Promise<CodeStructure[]> {
        const functions = await this.findFunctions(content, language, variant);
        const classes = await this.findClasses(content, language, variant);
        // Add calls to findNamespaces, findTestCases etc. here if implemented
        return [...functions, ...classes]; // Combine results
    }


    /**
     * Get the full structure hierarchy at a given position
     * @param content File content
     * @param language Language identifier
     * @param position Position to check
     * @param variant Optional language variant
     * @returns Array of structures from outermost to innermost
     */
    public async getStructureHierarchyAtPosition(
        content: string,
        language: string,
        position: CodePosition,
        variant?: string
    ): Promise<CodeStructure[]> {
        await this.ensureInitialized();

        let tree = null;
        try {
            tree = await this.parseContent(content, language, variant);
            if (tree === null) {
                return [];
            }

            const offset = this.positionToOffset(position, content);
            if (offset === null) {
                return [];
            }

            const hierarchy: CodeStructure[] = [];
            let currentNode = tree.rootNode.descendantForIndex(offset);

            while (currentNode) {
                const contentRange = this.nodeToCodeRange(currentNode);
                // For hierarchy, range and contentRange are the same
                hierarchy.push({
                    type: currentNode.type,
                    name: this.extractNodeName(currentNode, language), // Try to get name
                    range: contentRange,
                    contentRange: contentRange, // Add contentRange
                    children: [],
                    text: content.substring(this.positionToOffset(contentRange.startPosition, content)!, this.positionToOffset(contentRange.endPosition, content)!)
                    // Comment association is harder for arbitrary hierarchy nodes
                });

                // Fix: Handle potentially null parent
                const parentNode = currentNode.parent;
                if (!parentNode) {
                    break;
                }
                currentNode = parentNode;
            }

            return hierarchy.reverse(); // Outermost first
        } catch (error) {
            console.error(`Error getting structure hierarchy:`, error);
            return [];
        } finally {
            // Clean up resources
            if (tree) {
                tree.delete();
            }
        }
    }

    /**
     * Convert a position to a character offset
     * @param position Position in the document
     * @param content File content
     * @returns Character offset or null if invalid
     */
    private positionToOffset(position: CodePosition, content: string): number | null {
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
     * Convert a character offset to a position
     * @param offset Character offset
     * @param content File content
     * @returns Position in the document or null if invalid
     */
    private offsetToPosition(offset: number, content: string): CodePosition | null {
        if (offset < 0 || offset > content.length) {
            return null;
        }

        let row = 0;
        let column = 0;
        let currentOffset = 0;

        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const lineLength = lines[i].length;
            const lineEndOffset = currentOffset + lineLength;

            if (offset <= lineEndOffset) {
                row = i;
                column = offset - currentOffset;
                return { row, column };
            }

            currentOffset += lineLength + 1; // +1 for the newline
        }

        // Should not be reached if offset <= content.length, but handle defensively
        return null;
    }


    /**
     * Convert a range to an offset range
     * @param range CodeRange
     * @param content File content
     * @returns Start and end offsets or null if invalid
     */
    private rangeToOffsets(range: CodeRange, content: string): { start: number, end: number } | null {
        const start = this.positionToOffset(range.startPosition, content);
        const end = this.positionToOffset(range.endPosition, content);

        if (start === null || end === null || start > end) {
            return null;
        }
        return { start, end };
    }


    /**
     * Check if a position is inside a range
     * @param position Position to check
     * @param range Range to check against
     * @returns True if position is inside the range
     */
    private isPositionInsideRange(position: CodePosition, range: CodeRange): boolean {
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
     * Get the complete content of any function containing the given position
     * @param content File content
     * @param language Language identifier
     * @param position Position within the function
     * @param variant Optional language variant
     * @returns The complete function text or null if not in a function
     */
    public async getFunctionAtPosition(
        content: string,
        language: string,
        position: CodePosition,
        variant?: string
    ): Promise<string | null> {
        const func = await this.isPositionInsideFunction(content, language, position, variant);

        if (!func) {
            return null;
        }

        return func.text; // Return the full text including comments/decorators
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
        this.initPromise = null;
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

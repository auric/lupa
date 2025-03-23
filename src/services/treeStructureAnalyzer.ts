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
    range: CodeRange;       // Position range in the document
    children: CodeStructure[]; // Child structures
    parent?: CodeStructure; // Parent structure
    text: string;           // The text content of this structure
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
    private readonly languageConfigs: Record<string, LanguageConfig> = {
        'javascript': {
            functionQueries: ['(function_declaration) @function', '(arrow_function) @function', '(method_definition) @function'],
            classQueries: ['(class_declaration) @class', '(object) @object'],
            methodQueries: ['(method_definition) @method'],
            blockQueries: ['(statement_block) @block']
        },
        'typescript': {
            functionQueries: ['(function_declaration) @function', '(arrow_function) @function', '(method_definition) @function'],
            classQueries: ['(class_declaration) @class', '(interface_declaration) @interface'],
            methodQueries: ['(method_definition) @method'],
            blockQueries: ['(statement_block) @block']
        },
        'python': {
            functionQueries: ['(function_definition) @function'],
            classQueries: ['(class_definition) @class'],
            methodQueries: ['(function_definition) @method'],
            blockQueries: ['(block) @block']
        },
        'java': {
            functionQueries: ['(method_declaration) @function', '(constructor_declaration) @function'],
            classQueries: ['(class_declaration) @class', '(interface_declaration) @interface'],
            methodQueries: ['(method_declaration) @method'],
            blockQueries: ['(block) @block']
        },
        'cpp': {
            functionQueries: ['(function_definition) @function', '(declaration (function_declarator)) @function'],
            classQueries: ['(class_specifier) @class', '(struct_specifier) @struct'],
            methodQueries: ['(function_definition) @method'],
            blockQueries: ['(compound_statement) @block']
        },
        'c': {
            functionQueries: ['(function_definition) @function', '(declaration (function_declarator)) @function'],
            classQueries: ['(struct_specifier) @struct'],
            methodQueries: ['(function_definition) @method'],
            blockQueries: ['(compound_statement) @block']
        },
        'csharp': {
            functionQueries: ['(method_declaration) @function', '(constructor_declaration) @function'],
            classQueries: ['(class_declaration) @class', '(interface_declaration) @interface'],
            methodQueries: ['(method_declaration) @method'],
            blockQueries: ['(block) @block']
        },
        'go': {
            functionQueries: ['(function_declaration) @function', '(method_declaration) @method'],
            classQueries: ['(type_declaration) @type'],
            methodQueries: ['(method_declaration) @method'],
            blockQueries: ['(block) @block']
        },
        'ruby': {
            functionQueries: ['(method) @function', '(singleton_method) @function'],
            classQueries: ['(class) @class', '(module) @module'],
            methodQueries: ['(method) @method'],
            blockQueries: ['(do_block) @block', '(block) @block']
        },
        'rust': {
            functionQueries: ['(function_item) @function', '(function_signature_item) @function'],
            classQueries: ['(struct_item) @struct', '(trait_item) @trait', '(impl_item) @impl'],
            methodQueries: ['(function_item) @method'],
            blockQueries: ['(block) @block']
        },
        'css': {
            functionQueries: ['(function_name) @function'],
            classQueries: ['(rule_set) @rule', '(keyframe_block) @keyframe'],
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
            if (!config) {
                throw new Error(`Language '${language}' is not supported`);
            }

            const rootNode = tree.rootNode;
            const functions: CodeStructure[] = [];

            for (const queryString of config.functionQueries) {
                try {
                    // Get the currently set language from the parser
                    const currentLang = await this.loadLanguageParser(language, variant);
                    const query = currentLang.query(queryString);
                    queries.push(query);

                    // For older web-tree-sitter API, we need to use captures()
                    // instead of matches()
                    const captures = query.captures(rootNode);

                    // The older API returns an array of capture objects
                    for (let i = 0; i < captures.length; i++) {
                        const capture = captures[i];
                        const node = capture.node;

                        // Find the function name
                        let name = "anonymous";

                        // Different languages have different patterns for function names
                        switch (language) {
                            case 'javascript':
                            case 'typescript':
                                // For function declarations
                                if (node.type === 'function_declaration') {
                                    const nameNode = node.childForFieldName('name');
                                    if (nameNode) {
                                        name = nameNode.text;
                                    }
                                }
                                // For method definitions
                                else if (node.type === 'method_definition') {
                                    const nameNode = node.childForFieldName('name');
                                    if (nameNode) {
                                        name = nameNode.text;
                                    }
                                }
                                // For arrow functions
                                else if (node.type === 'arrow_function') {
                                    // Try to find a parent assignment or variable declaration
                                    let parent = node.parent;
                                    while (parent) {
                                        if (parent.type === 'variable_declarator') {
                                            const nameNode = parent.childForFieldName('name');
                                            if (nameNode) {
                                                name = nameNode.text;
                                                break;
                                            }
                                        }
                                        parent = parent.parent;
                                    }
                                }
                                break;

                            case 'python':
                                if (node.type === 'function_definition') {
                                    const nameNode = node.childForFieldName('name');
                                    if (nameNode) {
                                        name = nameNode.text;
                                    }
                                }
                                break;

                            case 'java':
                            case 'csharp':
                                if (node.type === 'method_declaration') {
                                    const nameNode = node.childForFieldName('name');
                                    if (nameNode) {
                                        name = nameNode.text;
                                    }
                                }
                                break;

                            case 'c':
                            case 'cpp':
                                if (node.type === 'function_definition') {
                                    const declarator = node.childForFieldName('declarator');
                                    if (declarator) {
                                        const nameNodes = declarator.descendantsOfType('identifier');
                                        if (nameNodes.length > 0) {
                                            name = nameNodes[0].text;
                                        }
                                    }
                                }
                                break;

                            case 'rust':
                                if (node.type === 'function_item') {
                                    const nameNode = node.childForFieldName('name');
                                    if (nameNode) {
                                        name = nameNode.text;
                                    }
                                }
                                break;

                            case 'css':
                                if (node.type === 'function_name') {
                                    name = node.text;
                                }
                                break;
                        }

                        functions.push({
                            type: node.type,
                            name: name,
                            range: {
                                startPosition: {
                                    row: node.startPosition.row,
                                    column: node.startPosition.column
                                },
                                endPosition: {
                                    row: node.endPosition.row,
                                    column: node.endPosition.column
                                }
                            },
                            children: [],
                            text: content.substring(node.startIndex, node.endIndex)
                        });
                    }
                } catch (error) {
                    console.error(`Error running query "${queryString}" for ${language}:`, error);
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
            if (!config) {
                throw new Error(`Language '${language}' is not supported`);
            }

            const rootNode = tree.rootNode;
            const classes: CodeStructure[] = [];

            for (const queryString of config.classQueries) {
                try {
                    // Get the currently set language from the parser
                    const currentLang = await this.loadLanguageParser(language, variant);
                    const query = currentLang.query(queryString);
                    queries.push(query);

                    // Use the captures method with the rootNode
                    const captures = query.captures(rootNode);

                    for (const capture of captures) {
                        const node = capture.node;

                        // Find the class name
                        let name = "anonymous";

                        // Different languages have different patterns for class names
                        if (language === 'javascript' || language === 'typescript') {
                            if (node.type === 'class_declaration') {
                                const nameNode = node.childForFieldName('name');
                                if (nameNode) {
                                    name = nameNode.text;
                                }
                            } else if (node.type === 'interface_declaration') {
                                const nameNode = node.childForFieldName('name');
                                if (nameNode) {
                                    name = nameNode.text;
                                }
                            }
                        } else if (language === 'python') {
                            if (node.type === 'class_definition') {
                                const nameNode = node.childForFieldName('name');
                                if (nameNode) {
                                    name = nameNode.text;
                                }
                            }
                        } else if (language === 'java' || language === 'csharp') {
                            if (node.type.includes('class_declaration') || node.type.includes('interface_declaration')) {
                                const nameNode = node.childForFieldName('name');
                                if (nameNode) {
                                    name = nameNode.text;
                                }
                            }
                        } else if (language === 'c' || language === 'cpp') {
                            if (node.type === 'struct_specifier' || node.type === 'class_specifier') {
                                const nameNode = node.childForFieldName('name');
                                if (nameNode) {
                                    name = nameNode.text;
                                }
                            }
                        } else if (language === 'rust') {
                            if (node.type === 'struct_item' || node.type === 'trait_item') {
                                const nameNode = node.childForFieldName('name');
                                if (nameNode) {
                                    name = nameNode.text;
                                }
                            }
                        } else if (language === 'css') {
                            if (node.type === 'rule_set') {
                                const selectors = node.childForFieldName('selectors');
                                if (selectors) {
                                    name = selectors.text;
                                }
                            }
                        }
                        // Additional language handlers would go here

                        classes.push({
                            type: node.type,
                            name: name,
                            range: {
                                startPosition: {
                                    row: node.startPosition.row,
                                    column: node.startPosition.column
                                },
                                endPosition: {
                                    row: node.endPosition.row,
                                    column: node.endPosition.column
                                }
                            },
                            children: [],
                            text: content.substring(node.startIndex, node.endIndex)
                        });
                    }
                } catch (error) {
                    console.error(`Error running query "${queryString}" for ${language}:`, error);
                    // Continue with other queries even if one fails
                }
            }

            return classes;
        } catch (error) {
            console.error(`Error finding classes in ${language}${variant ? ' (' + variant + ')' : ''} content:`, error);
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
                if (this.isPositionInsideRange(position, cls.range)) {
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
            result.set('function', functions.map(f => f.range));

            // Get classes
            const classes = await this.findClasses(content, language, variant);
            result.set('class', classes.map(c => c.range));

            // Additional structure types could be added here

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

            // Get functions and classes
            const functions = await this.findFunctions(content, language, variant);
            const classes = await this.findClasses(content, language, variant);

            // Function endings make excellent break points
            for (const func of functions) {
                const endPos = this.rangeToOffset(func.range.endPosition, content);
                if (endPos !== null) {
                    breakPoints.push({
                        position: endPos,
                        quality: 10 // Highest quality
                    });
                }
            }

            // Class endings also make excellent break points
            for (const cls of classes) {
                const endPos = this.rangeToOffset(cls.range.endPosition, content);
                if (endPos !== null) {
                    breakPoints.push({
                        position: endPos,
                        quality: 9 // Very high quality
                    });
                }
            }

            // Add blank lines as lower quality break points
            const blankLineMatches = content.matchAll(/\n\s*\n/g);
            for (const match of blankLineMatches) {
                if (match.index !== undefined) {
                    breakPoints.push({
                        position: match.index + match[0].length,
                        quality: 5 // Medium quality
                    });
                }
            }

            // Sort by position
            breakPoints.sort((a, b) => a.position - b.position);

            return breakPoints;
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
                hierarchy.push({
                    type: currentNode.type,
                    range: {
                        startPosition: {
                            row: currentNode.startPosition.row,
                            column: currentNode.startPosition.column
                        },
                        endPosition: {
                            row: currentNode.endPosition.row,
                            column: currentNode.endPosition.column
                        }
                    },
                    children: [],
                    text: content.substring(currentNode.startIndex, currentNode.endIndex)
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
            return null;
        }

        let offset = 0;
        for (let i = 0; i < position.row; i++) {
            offset += lines[i].length + 1; // +1 for the newline
        }

        if (position.column > lines[position.row].length) {
            return null;
        }

        offset += position.column;
        return offset;
    }

    /**
     * Convert a position to a character offset
     * @param position Position in the document
     * @param content File content
     * @returns Character offset or null if invalid
     */
    private rangeToOffset(position: CodePosition, content: string): number | null {
        return this.positionToOffset(position, content);
    }

    /**
     * Check if a position is inside a range
     * @param position Position to check
     * @param range Range to check against
     * @returns True if position is inside the range
     */
    private isPositionInsideRange(position: CodePosition, range: CodeRange): boolean {
        // Check if position is after the start position
        if (position.row > range.startPosition.row ||
            (position.row === range.startPosition.row && position.column >= range.startPosition.column)) {

            // Check if position is before the end position
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

        return func.text;
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
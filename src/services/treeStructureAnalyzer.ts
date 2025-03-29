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
    id?: string;            // Unique identifier for the structure
    parentContext?: {       // Information about the parent context (class/namespace)
        type: string;       // Type of the parent context
        name?: string;      // Name of the parent context
    };
    trailingComment?: string; // Trailing comment like "} // namespace foo"
}

/**
 * Language-specific configuration for tree-sitter parsing
 */
export interface LanguageConfig {
    functionQueries: string[];    // Queries to find function declarations
    classQueries: string[];       // Queries to find class declarations
    methodQueries: string[];      // Queries to find method declarations
    blockQueries: string[];       // Queries to find block statements
    // commentQueries removed - comments are captured with structures
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
    // Promise for initialization
    private pool: TreeStructureAnalyzerPool | null = null;
    private isDisposed = false;

    // Language configurations for tree-sitter
    // Queries aim to capture the main node (@...) and optionally preceding comments (@comment) or decorators (@decorator)
    // A @capture node can be used to define the overall range including comments/decorators
    private readonly languageConfigs: Record<string, LanguageConfig> = {
        'javascript': {
            functionQueries: [
                // Function declaration with preceding comments (handles multiple comments and blank lines)
                `((comment)+ @comment . (function_declaration) @func) @capture`,
                // Exported function declaration with preceding comments
                `((comment)+ @comment . (export_statement . (function_declaration) @func)) @capture`,
                // Function expression assigned to variable with preceding comments
                `((comment)+ @comment . (expression_statement (assignment_expression
                    left: (_)
                    right: [(arrow_function) (function_expression)] @func
                ))) @capture`,
                // Arrow function assigned to variable with preceding comments
                `((comment)+ @comment . (lexical_declaration (variable_declarator
                    name: (_)
                    value: [(arrow_function) (function_expression)] @func
                ))) @capture`,
                // Method definition within class with preceding comments
                `((class_body . (comment)+ @comment . (method_definition) @func)) @capture`
            ],
            classQueries: [
                // Class declaration with preceding comments
                `((comment)+ @comment . (class_declaration) @class) @capture`,
                // Exported class declaration with preceding comments
                `((comment)+ @comment . (export_statement . (class_declaration) @class)) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(statement_block) @block']
        },
        'typescript': {
            functionQueries: [
                // Function declaration with preceding comments
                `((comment)+ @comment . (function_declaration) @func) @capture`,
                // Exported function declaration with preceding comments
                `((comment)+ @comment . (export_statement . (function_declaration) @func)) @capture`,
                // Function expression assigned to variable with preceding comments
                `((comment)+ @comment . (expression_statement (assignment_expression
                    left: (_)
                    right: [(arrow_function) (function_expression)] @func
                ))) @capture`,
                // Arrow function assigned to variable with preceding comments
                `((comment)+ @comment . (lexical_declaration (variable_declarator
                    name: (_)
                    value: [(arrow_function) (function_expression)] @func
                ))) @capture`,
                // Method definition within class/interface with preceding comments
                `((class_body . (comment)+ @comment . (method_definition) @func)) @capture`,
                // Method signature within interface with preceding comments
                `((object_type . (comment)+ @comment . (method_signature) @func)) @capture`
            ],
            classQueries: [
                // Class declaration with decorators and preceding comments
                `((comment)+ @comment . (decorator)* . (class_declaration) @class) @capture`,
                // Exported class declaration with decorators and preceding comments
                `((comment)+ @comment . (export_statement . (decorator)* . (class_declaration) @class)) @capture`,
                // Interface declaration with preceding comments
                `((comment)+ @comment . (interface_declaration) @interface) @capture`,
                // Exported interface declaration with preceding comments
                `((comment)+ @comment . (export_statement . (interface_declaration) @interface)) @capture`,
                // Enum declaration with preceding comments
                `((comment)+ @comment . (enum_declaration) @enum) @capture`,
                // Exported enum declaration with preceding comments
                `((comment)+ @comment . (export_statement . (enum_declaration) @enum)) @capture`,
                // Type alias declaration with preceding comments
                `((comment)+ @comment . (type_alias_declaration) @type) @capture`,
                // Exported type alias declaration with preceding comments
                `((comment)+ @comment . (export_statement . (type_alias_declaration) @type)) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(statement_block) @block']
        },
        'python': {
            functionQueries: [
                // Function definition with decorators and preceding comments
                `((comment)+ @comment . (decorator)* . (function_definition) @function) @capture`
            ],
            classQueries: [
                // Class definition with decorators and preceding comments
                `((comment)+ @comment . (decorator)* . (class_definition) @class) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'java': {
            functionQueries: [
                // Method declaration with annotations and preceding comments
                `((comment)+ @comment . (marker_annotation)* . (method_declaration) @function) @capture`,
                // Constructor declaration with annotations and preceding comments
                `((comment)+ @comment . (marker_annotation)* . (constructor_declaration) @function) @capture`
            ],
            classQueries: [
                // Class declaration with annotations and preceding comments
                `((comment)+ @comment . (marker_annotation)* . (class_declaration) @class) @capture`,
                // Interface declaration with annotations and preceding comments
                `((comment)+ @comment . (marker_annotation)* . (interface_declaration) @interface) @capture`,
                // Enum declaration with annotations and preceding comments
                `((comment)+ @comment . (marker_annotation)* . (enum_declaration) @enum) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'cpp': {
            functionQueries: [
                // Standalone function definition with preceding comments
                `((comment)+ @comment . (function_definition) @function) @capture`,
                // Standalone function declaration with preceding comments
                `((comment)+ @comment . (declaration type: (_) declarator: (function_declarator)) @function) @capture`,
                // Templated function definition with preceding comments
                `((comment)+ @comment . (template_declaration . (function_definition) @function)) @capture`,
                // Templated function declaration with preceding comments
                `((comment)+ @comment . (template_declaration . (declaration type: (_) declarator: (function_declarator)) @function)) @capture`
            ],
            classQueries: [
                // Class specifier with preceding comments
                `((comment)+ @comment . (class_specifier) @class) @capture`,
                // Struct specifier with preceding comments
                `((comment)+ @comment . (struct_specifier) @struct) @capture`,
                // Namespace definition with preceding comments
                `((comment)+ @comment . (namespace_definition) @namespace) @capture`,
                // Templated class specifier with preceding comments
                `((comment)+ @comment . (template_declaration . (class_specifier) @class)) @capture`,
                // Templated struct specifier with preceding comments
                `((comment)+ @comment . (template_declaration . (struct_specifier) @struct)) @capture`,
                // Enum specifier with preceding comments
                `((comment)+ @comment . (enum_specifier) @enum) @capture`
            ],
            methodQueries: [
                // Method definition within class/struct body with preceding comments
                `(field_declaration_list . ((comment)+ @comment . (function_definition) @method)) @capture`,
                // Templated method definition within class/struct body with preceding comments
                `(field_declaration_list . ((comment)+ @comment . (template_declaration . (function_definition) @method))) @capture`,
                // Field declaration within class/struct body with preceding comments
                `(field_declaration_list . ((comment)+ @comment . (field_declaration) @field)) @capture`
            ],
            blockQueries: [
                '(compound_statement) @block',
                '(namespace_definition body: (declaration_list) @block)',
                '(class_specifier body: (field_declaration_list) @block)',
                '(struct_specifier body: (field_declaration_list) @block)'
            ]
        },
        'c': {
            functionQueries: [
                // Function definition with preceding comments
                `((comment)+ @comment . (function_definition) @function) @capture`,
                // Function declaration with preceding comments
                `((comment)+ @comment . (declaration type: (_) declarator: (function_declarator)) @function) @capture`
            ],
            classQueries: [
                // Struct specifier with preceding comments
                `((comment)+ @comment . (struct_specifier) @struct) @capture`,
                // Enum specifier with preceding comments
                `((comment)+ @comment . (enum_specifier) @enum) @capture`
            ],
            methodQueries: [],
            blockQueries: ['(compound_statement) @block']
        },
        'csharp': {
            functionQueries: [
                // Method declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (method_declaration) @function) @capture`,
                // Constructor declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (constructor_declaration) @function) @capture`,
                // Destructor declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (destructor_declaration) @function) @capture`,
                // Operator declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (operator_declaration) @function) @capture`
            ],
            classQueries: [
                // Class declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (class_declaration) @class) @capture`,
                // Interface declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (interface_declaration) @interface) @capture`,
                // Struct declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (struct_declaration) @struct) @capture`,
                // Enum declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (enum_declaration) @enum) @capture`,
                // Namespace declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (namespace_declaration) @namespace) @capture`,
                // Delegate declaration with attributes and preceding comments
                `((comment)+ @comment . (attribute_list)* . (delegate_declaration) @delegate) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'go': {
            functionQueries: [
                // Function declaration with preceding comments
                `((comment)+ @comment . (function_declaration) @function) @capture`,
                // Method declaration with preceding comments
                `((comment)+ @comment . (method_declaration) @method) @capture`
            ],
            classQueries: [
                // Type declaration with preceding comments
                `((comment)+ @comment . (type_declaration) @type) @capture`,
                // Struct type definition with preceding comments
                `((comment)+ @comment . (struct_type) @struct) @capture`,
                // Interface type definition with preceding comments
                `((comment)+ @comment . (interface_type) @interface) @capture`,
                // Type specifier with preceding comments
                `((comment)+ @comment . (type_spec) @type) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'ruby': {
            functionQueries: [
                // Method definition with preceding comments
                `((comment)+ @comment . (method) @function) @capture`,
                // Singleton method definition with preceding comments
                `((comment)+ @comment . (singleton_method) @function) @capture`
            ],
            classQueries: [
                // Class definition with preceding comments
                `((comment)+ @comment . (class) @class) @capture`,
                // Module definition with preceding comments
                `((comment)+ @comment . (module) @module) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(do_block) @block', '(block) @block']
        },
        'rust': {
            functionQueries: [
                // Function item with attributes and preceding comments
                `((comment)+ @comment . (attribute_item)* . (function_item) @function) @capture`,
                // Function signature item with attributes and preceding comments
                `((comment)+ @comment . (attribute_item)* . (function_signature_item) @function) @capture`
            ],
            classQueries: [
                // Struct item with attributes and preceding comments
                `((comment)+ @comment . (attribute_item)* . (struct_item) @struct) @capture`,
                // Trait item with attributes and preceding comments
                `((comment)+ @comment . (attribute_item)* . (trait_item) @trait) @capture`,
                // Impl item with attributes and preceding comments
                `((comment)+ @comment . (attribute_item)* . (impl_item) @impl) @capture`,
                // Enum item with attributes and preceding comments
                `((comment)+ @comment . (attribute_item)* . (enum_item) @enum) @capture`,
                // Mod item with attributes and preceding comments
                `((comment)+ @comment . (attribute_item)* . (mod_item) @module) @capture`
            ],
            methodQueries: [], // Covered by functionQueries
            blockQueries: ['(block) @block']
        },
        'css': {
            functionQueries: [], // CSS doesn't have functions in the typical sense
            classQueries: [
                // Rule set with preceding comments
                `((comment)+ @comment . (rule_set) @rule) @capture`,
                // At-rule with preceding comments
                `((comment)+ @comment . (at_rule) @at_rule) @capture`
            ],
            methodQueries: [],
            blockQueries: ['(block) @block']
        }
    };

    // Language configurations are defined directly in languageConfigs

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
        let queries: Parser.Query[] = [];

        try {
            tree = await this.parseContent(content, language, variant);
            if (!tree) {
                console.error(`Parsing returned null for ${language}${variant ? ' (' + variant + ')' : ''}`);
                return [];
            }

            const config = this.languageConfigs[language];
            if (!config || !config[queryType] || config[queryType].length === 0) {
                console.warn(`No ${queryType} defined for language '${language}'`);
                return [];
            }

            const rootNode = tree.rootNode;
            const structures: CodeStructure[] = [];
            const processedNodes = new Set<number>(); // Keep track of nodes already processed

            // Find context nodes (classes, namespaces, etc.)
            const contextNodes: Parser.SyntaxNode[] = [];
            this.findNodesOfType(rootNode, contextNodesTypes, contextNodes);

            // Map of node IDs to their parent context
            const nodeContextMap = new Map<number, { node: Parser.SyntaxNode, name?: string, type: string }>();

            // Build a map of parent contexts
            for (const contextNode of contextNodes) {
                const contextName = this.extractNodeName(contextNode, language);
                const contextType = contextNode.type;

                // Find all relevant nodes within this context
                this.findChildNodesWithinRange(contextNode, (node) => {
                    // Check if this node should be associated with this context
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

            // Process all queries
            for (const queryString of config[queryType]) {
                try {
                    const currentLang = await this.loadLanguageParser(language, variant);
                    const query = currentLang.query(queryString);
                    queries.push(query);

                    // Use matches() which provides more context than captures()
                    const matches = query.matches(rootNode);

                    for (const match of matches) {
                        let mainNode: Parser.SyntaxNode | null = null;
                        let commentNode: Parser.SyntaxNode | null = null;
                        let captureNode: Parser.SyntaxNode | null = null; // The overall capture, e.g., including comments

                        // Based on query type, determine what capture names to look for
                        const mainCaptureNames = queryType === 'functionQueries'
                            ? ['function', 'func', 'method']
                            : ['class', 'struct', 'interface', 'namespace', 'enum', 'type'];

                        for (const capture of match.captures) {
                            const isMainCapture = mainCaptureNames.some(name =>
                                capture.name === name || capture.name.includes(name));

                            if (isMainCapture) {
                                mainNode = capture.node;
                            } else if (capture.name === 'comment' || capture.name.includes('comment')) {
                                // Capture the first comment node
                                if (!commentNode) commentNode = capture.node;
                            } else if (capture.name === 'capture') {
                                captureNode = capture.node;
                            }
                        }

                        if (mainNode && !processedNodes.has(mainNode.id)) {
                            processedNodes.add(mainNode.id);

                            // Determine the full range (including comments/decorators if captured)
                            const contentRange = this.nodeToCodeRange(mainNode);
                            const range = captureNode ? this.nodeToCodeRange(captureNode) : contentRange;

                            // Find the name
                            let name = this.extractNodeName(mainNode, language);

                            // Extract text and comment based on captured nodes
                            let structureText = "";
                            let commentText = "";
                            let firstCommentNode = commentNode; // Keep track of the first comment

                            // Find the actual first comment node if multiple were captured implicitly by (comment)+
                            let tempNode = mainNode.previousSibling;
                            while (tempNode && tempNode.type === 'comment') {
                                firstCommentNode = tempNode;
                                tempNode = tempNode.previousSibling;
                            }

                            // Also check preceding sibling of capture node if different
                            if (captureNode && captureNode !== mainNode && captureNode.previousSibling && captureNode.previousSibling.type === 'comment') {
                                let capPrevNode = captureNode.previousSibling;
                                while (capPrevNode && capPrevNode.type === 'comment') {
                                    firstCommentNode = capPrevNode;
                                    // Check for null before assignment
                                    const capPrevSibling = capPrevNode.previousSibling;
                                    if (!capPrevSibling) {
                                        break;
                                    }
                                    capPrevNode = capPrevSibling;
                                }
                            }

                            // Determine the start index for the full text (structureText)
                            let textStartIndex = mainNode.startIndex;
                            if (captureNode) {
                                textStartIndex = captureNode.startIndex;
                            } else if (firstCommentNode) {
                                textStartIndex = firstCommentNode.startIndex;
                            }

                            // Extract the structure text
                            structureText = content.substring(textStartIndex, mainNode.endIndex);

                            // Extract comment text
                            if (firstCommentNode) {
                                commentText = this.cleanCommentText(content.substring(firstCommentNode.startIndex, mainNode.startIndex));
                            } else if (commentNode) { // Fallback
                                commentText = this.cleanCommentText(content.substring(commentNode.startIndex, commentNode.endIndex));
                            }

                            // Check for trailing comments like "} // namespace foo"
                            let trailingComment = undefined;
                            if (mainNode.type === 'namespace_definition') {
                                // Look for comment on the same line after the closing brace
                                const lineEndOffset = content.indexOf('\n', mainNode.endIndex);
                                const endOfLineText = content.substring(mainNode.endIndex, lineEndOffset !== -1 ? lineEndOffset : content.length);
                                const namespaceCommentMatch = endOfLineText.match(/^\s*\/\/\s*namespace\s+([\w:]+)/);
                                if (namespaceCommentMatch) {
                                    // Only capture the comment itself, not leading whitespace
                                    trailingComment = namespaceCommentMatch[0].trim();
                                    // Adjust the overall range and text to include this trailing comment
                                    const expectedEndIndex = mainNode.endIndex + endOfLineText.indexOf(trailingComment) + trailingComment.length;
                                    range.endPosition = this.offsetToPosition(content, expectedEndIndex) || range.endPosition;
                                    // Recalculate structureText based on the potentially expanded range
                                    structureText = content.substring(textStartIndex, expectedEndIndex);
                                }
                            }

                            // Check if this node is part of a context (class/namespace)
                            let parentContext: { node: Parser.SyntaxNode, name?: string, type: string } | undefined;
                            if (nodeContextMap.has(mainNode.id)) {
                                parentContext = nodeContextMap.get(mainNode.id);
                            }

                            // Create a unique ID
                            let structureId: string;
                            if (parentContext && parentContext.name) {
                                structureId = `${parentContext.type}:${parentContext.name}:${mainNode.type}:${name || mainNode.id}`;
                            } else {
                                structureId = `${mainNode.type}:${name || mainNode.id}`;
                            }

                            // Create the structure object
                            const structure: CodeStructure = {
                                type: mainNode.type,
                                name: name,
                                range: range,
                                contentRange: contentRange,
                                children: [],
                                text: structureText.trim(),
                                comment: commentText || undefined,
                                id: structureId,
                                parentContext: parentContext ? {
                                    type: parentContext.type,
                                    name: parentContext.name
                                } : undefined,
                                trailingComment
                            };

                            structures.push(structure);
                        }
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
     * Convert offset to position (row, column)
     * @param content Source text
     * @param offset Character offset
     * @returns Position or null if invalid
     */
    private offsetToPosition(content: string, offset: number): CodePosition | null {
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

            currentOffset = lineEndOffset + 1; // +1 for newline
        }

        return null;
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
     * Convert a position to a character offset
     * @param position Position in the document
     * @param content File content
     * @returns Character offset or null if invalid
     */
    public positionToOffset(position: CodePosition, content: string): number | null {
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
                                contentRange: range,
                                children: [],
                                text: commentText,
                                comment: commentText,
                                id: `comment:${commentNode.id}`
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
                            name: 'file_header',
                            range: this.nodeToCodeRange(firstNode),
                            contentRange: this.nodeToCodeRange(firstNode),
                            children: [],
                            text: commentText,
                            comment: this.cleanCommentText(commentText),
                            id: 'file_header'
                        };
                        // Add header comment to the list if found
                        allFoundStructures.unshift(fileHeaderComment);
                    }
                }
            }
            tree.delete(); // Clean up the tree
        }

        // --- Find Standalone Comments ---
        const associatedCommentRanges = new Set<string>();
        allFoundStructures.forEach(s => {
            if (s.comment) {
                // Mark the range of the associated comment to avoid double-counting
                const commentStartOffset = s.text.indexOf(s.comment);
                if (commentStartOffset !== -1) {
                    const commentStartPos = this.offsetToPosition(content, s.range.startPosition.row === 0 && s.range.startPosition.column === 0 ? commentStartOffset : s.range.startPosition.row + commentStartOffset); // Adjust offset calculation
                    if (commentStartPos) {
                        const commentEndPos = this.offsetToPosition(content, commentStartPos.row + s.comment.length); // Adjust offset calculation
                        if (commentEndPos) {
                            associatedCommentRanges.add(`${commentStartPos.row}:${commentStartPos.column}-${commentEndPos.row}:${commentEndPos.column}`);
                        }
                    }
                }
            }
        });

        const standaloneComments = await this.findStandaloneComments(content, language, variant);
        const uniqueStandaloneComments = standaloneComments.filter(c => {
            const rangeKey = `${c.range.startPosition.row}:${c.range.startPosition.column}-${c.range.endPosition.row}:${c.range.endPosition.column}`;
            // Filter out comments already associated with structures or the header
            return !associatedCommentRanges.has(rangeKey) && c.id !== 'file_header';
        });

        // Combine all structures
        let structures: CodeStructure[] = [...allFoundStructures, ...uniqueStandaloneComments];

        // Filter out forward declarations for all languages
        const implementations = new Map<string, CodeStructure>();

        // First pass: identify implementations
        for (const struct of structures) {
            // Check if this is an implementation (has a body)
            const isImplementation =
                (struct.type.includes('definition') ||
                    struct.type.includes('specifier')) &&
                struct.name !== undefined;

            if (isImplementation && struct.name) {
                implementations.set(struct.name, struct);
            }
        }

        // Second pass: filter out forward declarations that have implementations
        structures = structures.filter(struct => {
            // Check if this is a forward declaration
            const isForwardDeclaration =
                (struct.type.includes('declaration') &&
                    !struct.type.includes('definition') &&
                    !struct.type.includes('specifier')) &&
                struct.name !== undefined;

            // Also check for simple forward declarations like "class X;" or "template<typename T> class X;"
            const isSimpleForwardDeclaration =
                struct.text && (
                    (struct.text.match(/\bclass\s+\w+\s*;/)) ||
                    (struct.text.match(/\bstruct\s+\w+\s*;/)) ||
                    (struct.text.match(/\btemplate\s*<[^>]*>\s*class\s+\w+\s*;/))
                );

            if ((isForwardDeclaration && struct.name && implementations.has(struct.name)) ||
                isSimpleForwardDeclaration) {
                // This is a forward declaration, filter it out
                return false;
            }

            return true;
        });

        // Build the structure hierarchy
        this.buildStructureHierarchy(structures);

        // Assign unique IDs to structures if not already assigned
        this.assignStructureIds(structures);

        return structures;
    }

    /**
     * Helper method to find the end position of a string
     */
    private findEndPosition(str: string): CodePosition {
        const lines = str.split('\n');
        const lastLineIndex = lines.length - 1;
        const lastLineLength = lines[lastLineIndex].length;

        return {
            row: lastLineIndex,
            column: lastLineLength
        };
    }

    /**
     * Build parent-child relationships between structures using a stack-based approach.
     * @param structures Array of code structures.
     */
    private buildStructureHierarchy(structures: CodeStructure[]): void {
        // Sort structures primarily by start position ascending,
        // then by end position descending (larger ranges first for ties at the same start)
        structures.sort((a, b) => {
            const startDiff = a.range.startPosition.row - b.range.startPosition.row ||
                a.range.startPosition.column - b.range.startPosition.column;
            if (startDiff !== 0) {
                return startDiff;
            }
            return b.range.endPosition.row - a.range.endPosition.row ||
                b.range.endPosition.column - a.range.endPosition.column;
        });

        // First clear any existing parent-child relationships that might have been
        // established by previous operations to prevent duplicates or conflicts
        for (const structure of structures) {
            structure.parent = undefined;
            structure.children = [];
        }

        const stack: CodeStructure[] = []; // Stack to keep track of potential parent structures

        for (const currentStructure of structures) {
            // Remove structures from the stack that end before or exactly where the current one starts
            while (stack.length > 0) {
                const topOfStack = stack[stack.length - 1];
                if (this.isRangeBeforeOrEqual(topOfStack.range.endPosition, currentStructure.range.startPosition)) {
                    stack.pop();
                } else {
                    break; // The top of the stack is a potential parent or ancestor
                }
            }

            // If the stack is not empty, the top element is the immediate parent
            if (stack.length > 0) {
                const parent = stack[stack.length - 1];
                // Check for strict containment (parent range must fully contain child range)
                // and avoid self-parenting
                if (parent !== currentStructure && this.isRangeContained(currentStructure.range, parent.range)) {
                    // Set up parent-child relationship
                    currentStructure.parent = parent;
                    parent.children.push(currentStructure);
                }
            }

            // Push the current structure onto the stack. It might be a parent for subsequent structures.
            stack.push(currentStructure);
        }
    }

    /**
     * Helper to check if position1 is before or equal to position2
     */
    private isRangeBeforeOrEqual(pos1: CodePosition, pos2: CodePosition): boolean {
        return pos1.row < pos2.row || (pos1.row === pos2.row && pos1.column <= pos2.column);
    }

    /**
     * Checks if outerRange completely contains innerRange.
     */
    private isRangeContained(innerRange: CodeRange, outerRange: CodeRange): boolean {
        const innerStart = innerRange.startPosition;
        const innerEnd = innerRange.endPosition;
        const outerStart = outerRange.startPosition;
        const outerEnd = outerRange.endPosition;

        const startsAfterOrAtOuterStart = innerStart.row > outerStart.row || (innerStart.row === outerStart.row && innerStart.column >= outerStart.column);
        const endsBeforeOrAtOuterEnd = innerEnd.row < outerEnd.row || (innerEnd.row === outerEnd.row && innerEnd.column <= outerEnd.column);

        return startsAfterOrAtOuterStart && endsBeforeOrAtOuterEnd;
    }

    /**
     * Checks if a range contains a specific position.
     */
    private doesRangeContain(range: CodeRange, position: CodePosition): boolean {
        const startsBeforeOrAtPos = range.startPosition.row < position.row || (range.startPosition.row === position.row && range.startPosition.column <= position.column);
        const endsAfterOrAtPos = range.endPosition.row > position.row || (range.endPosition.row === position.row && range.endPosition.column >= position.column);
        return startsBeforeOrAtPos && endsAfterOrAtPos;
    }

    /**
     * Assign unique IDs to structures if not already assigned
     * @param structures Array of code structures
     */
    private assignStructureIds(structures: CodeStructure[]): void {
        // Use a non-recursive approach to avoid stack overflow
        const stack: CodeStructure[] = [...structures];
        const processed = new Set<CodeStructure>();

        while (stack.length > 0) {
            const structure = stack.pop()!;

            // Skip if already processed to avoid circular references
            if (processed.has(structure)) {
                continue;
            }

            processed.add(structure);

            if (!structure.id) {
                // Create an ID based on type and name if available
                if (structure.name) {
                    structure.id = `${structure.type}:${structure.name}`;
                } else {
                    // Use position as a fallback for unnamed structures
                    const pos = structure.range.startPosition;
                    structure.id = `${structure.type}:${pos.row}:${pos.column}`;
                }
            }

            // Add children to the stack
            if (structure.children && structure.children.length > 0) {
                for (const child of structure.children) {
                    if (!processed.has(child)) {
                        stack.push(child);
                    }
                }
            }
        }
    }

    /**
     * Check if one structure is contained within another
     */
    private isStructureContainedIn(inner: CodeStructure, outer: CodeStructure): boolean {
        const innerStartRow = inner.range.startPosition.row;
        const innerStartCol = inner.range.startPosition.column;
        const innerEndRow = inner.range.endPosition.row;
        const innerEndCol = inner.range.endPosition.column;

        const outerStartRow = outer.range.startPosition.row;
        const outerStartCol = outer.range.startPosition.column;
        const outerEndRow = outer.range.endPosition.row;
        const outerEndCol = outer.range.endPosition.column;

        // Check if inner structure is completely within outer structure
        if (innerStartRow > outerStartRow || (innerStartRow === outerStartRow && innerStartCol >= outerStartCol)) {
            if (innerEndRow < outerEndRow || (innerEndRow === outerEndRow && innerEndCol <= outerEndCol)) {
                return true;
            }
        }

        return false;
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
     * Find partial structures in a code snippet, useful for handling incomplete code fragments
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Array of partial structure information
     */
    public async findPartialStructures(
        _content: string,
        _language: string,
        _variant?: string
    ): Promise<CodeStructure[]> {
        // For now, return an empty array as we'll rely on the existing structure detection
        return [];
    }

    /**
     * Get all structures in a hierarchical format
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Array of top-level structures with children properly nested
     */
    public async getStructureHierarchy(
        content: string,
        language: string,
        variant?: string
    ): Promise<CodeStructure[]> {
        // Find all structures first
        const allStructures = await this.findAllStructures(content, language, variant);

        // Filter to only return top-level structures (those without parents)
        return allStructures.filter(structure => !structure.parent);
    }

    /**
     * Get a flat list of all structures with parent references
     * @param content File content
     * @param language Language identifier
     * @param variant Optional language variant
     * @returns Flat array of all structures with parent references
     */
    public async getFlatStructureList(
        content: string,
        language: string,
        variant?: string
    ): Promise<CodeStructure[]> {
        // This returns all structures with parent references set
        return await this.findAllStructures(content, language, variant);
    }

    // supportsLanguage is implemented below

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
        position: CodePosition,
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
            return language in this.languageConfigs;
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

    /**
     * Helper to clean comment text by removing comment markers and extra whitespace
     * @param commentText The raw comment text with comment markers
     * @returns Formatted comment text without markers
     */
    private cleanCommentText(commentText: string): string {
        // Check if input is empty or undefined
        if (!commentText) return '';

        // Preserve the original structure of comments, including blank lines
        const lines = commentText.split('\n');
        const cleanedLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // Remove line comment markers (// ...)
            line = line.replace(/^\s*\/\/\s?/, '');

            // Remove block comment start marker (/* or /**)
            line = line.replace(/^\s*\/\*\*?/, '');

            // Remove block comment end marker (*/)
            line = line.replace(/\*\/\s*$/, '');

            // Remove leading asterisks from block comments (* ...)
            line = line.replace(/^\s*\*\s?/, '');

            cleanedLines.push(line);
        }

        // Join the cleaned lines, preserving the original line structure
        return cleanedLines.join('\n');
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

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

// Language configurations for tree-sitter
// Queries aim to capture the main node (@...) and optionally preceding comments (@comment) or decorators (@decorator)
// A @capture node can be used to define the overall range including comments/decorators
export const TREE_SITTER_LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
    'javascript': {
        functionQueries: [
            // Function declaration with preceding comments (handles multiple comments and blank lines)
            `((comment)* @comment . (function_declaration) @function) @capture`,
            // Exported function declaration with preceding comments
            `((comment)* @comment . (export_statement . (function_declaration) @function)) @capture`,
            // Function expression assigned to variable with preceding comments
            `((comment)* @comment . (expression_statement (assignment_expression
                    left: (_)
                    right: [(arrow_function) (function_expression)] @function
                ))) @capture`,
            // Arrow function assigned to variable with preceding comments
            `((comment)* @comment . (lexical_declaration (variable_declarator
                    name: (_)
                    value: [(arrow_function) (function_expression)] @function
                ))) @capture`,
            // Method definition within class with preceding comments
            `((class_body . (comment)* @comment . (method_definition) @function)) @capture`
        ],
        classQueries: [
            // Class declaration with preceding comments
            `((comment)* @comment . (class_declaration) @class) @capture`,
            // Exported class declaration with preceding comments
            `((comment)* @comment . (export_statement . (class_declaration) @class)) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(statement_block) @block']
    },
    'typescript': {
        functionQueries: [
            // Function declaration with preceding comments
            `((comment)* @comment . (function_declaration) @function) @capture`,
            // Exported function declaration with preceding comments
            `((comment)* @comment . (export_statement . (function_declaration) @function)) @capture`,
            // Function expression assigned to variable with preceding comments
            `((comment)* @comment . (variable_declaration
                    (variable_declarator
                      name: (_)
                      value: [(arrow_function) (function_expression)] @function))) @capture`,
            // Arrow function assigned to variable with preceding comments
            `((comment)* @comment . (lexical_declaration
                    (variable_declarator
                      name: (_)
                      value: [(arrow_function) (function_expression)] @function))) @capture`,
            // Method definition within class with preceding comments
            `((comment)* @comment . (decorator)* @decorator . (method_definition) @method) @capture`,
            // Method definition within class (no scope access)
            `(class_body . ((comment)* @comment . (method_definition) @method)) @capture`,
            // Method definition in interface with preceding comments
            `(object_type . ((comment)* @comment . (method_signature) @method)) @capture`
        ],
        classQueries: [
            // Class declaration with decorators and preceding comments
            `((comment)* @comment . (decorator)* @decorator . (class_declaration) @class) @capture`,
            // Exported class declaration with decorators and preceding comments
            `((comment)* @comment . (export_statement . ((decorator)* @decorator . (class_declaration) @class))) @capture`,
            // Interface declaration with preceding comments
            `((comment)* @comment . (interface_declaration) @interface) @capture`,
            // Exported interface declaration with preceding comments
            `((comment)* @comment . (export_statement . (interface_declaration) @interface)) @capture`,
            // Enum declaration with preceding comments
            `((comment)* @comment . (enum_declaration) @enum) @capture`,
            // Exported enum declaration with preceding comments
            `((comment)* @comment . (export_statement . (enum_declaration) @enum)) @capture`,
            // Type alias declaration with preceding comments
            `((comment)* @comment . (type_alias_declaration) @type) @capture`,
            // Exported type alias declaration with preceding comments
            `((comment)* @comment . (export_statement . (type_alias_declaration) @type)) @capture`,
            // Module declaration with preceding comments
            `((comment)* @comment . (module) @module) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(statement_block) @block']
    },
    'python': {
        functionQueries: [
            // Function definition with decorators and preceding comments
            `((comment)* @comment . (decorator)* @decorator . (function_definition) @function) @capture`,
            // Method definition in class with decorators and preceding comments
            `(class_definition
                    body: (block . ((comment)* @comment . (decorator)* @decorator . (function_definition) @method))) @capture`
        ],
        classQueries: [
            // Class definition with decorators and preceding comments
            `((comment)* @comment . (decorator)* @decorator . (class_definition) @class) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(block) @block']
    },
    'java': {
        functionQueries: [
            // Method declaration with annotations and preceding comments
            `((comment)* @comment . (marker_annotation)* . (method_declaration) @function) @capture`,
            // Constructor declaration with annotations and preceding comments
            `((comment)* @comment . (marker_annotation)* . (constructor_declaration) @function) @capture`
        ],
        classQueries: [
            // Class declaration with annotations and preceding comments
            `((comment)* @comment . (marker_annotation)* . (class_declaration) @class) @capture`,
            // Interface declaration with annotations and preceding comments
            `((comment)* @comment . (marker_annotation)* . (interface_declaration) @interface) @capture`,
            // Enum declaration with annotations and preceding comments
            `((comment)* @comment . (marker_annotation)* . (enum_declaration) @enum) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(block) @block']
    },
    'cpp': {
        functionQueries: [
            // Standalone function definition with preceding comments
            `((comment)* @comment . (function_definition) @function) @capture`,
            // Standalone function declaration with preceding comments
            `((comment)* @comment . (declaration
                    type: (_)
                    declarator: (function_declarator)) @function) @capture`,
            // Template function definition with preceding comments
            `((comment)* @comment . (template_declaration) @template_decl . (function_definition) @function) @capture`,
            // Templated function declaration with preceding comments
            `((comment)* @comment . (template_declaration) @template_decl . (declaration
                    type: (_)
                    declarator: (function_declarator)) @function) @capture`,
            // Method definition within class/struct body with preceding comments
            `(field_declaration_list . ((comment)* @comment . (function_definition) @method)) @capture`,
            // Template method definition within class/struct body with preceding comments
            `(field_declaration_list . ((comment)* @comment . (template_declaration) @template_decl . (function_definition) @method)) @capture`,
            // Field declaration within class/struct body with preceding comments
            `(field_declaration_list . ((comment)* @comment . (field_declaration) @field)) @capture`
        ],
        classQueries: [
            // Template class declaration with preceding comments - capture the template node
            `((comment)* @comment . (template_declaration)) @capture`,
            // Class specifier with preceding comments
            `((comment)* @comment . (class_specifier) @class) @capture`,
            // Struct specifier with preceding comments
            `((comment)* @comment . (struct_specifier) @struct) @capture`,
            // Enum specifier with preceding comments
            `((comment)* @comment . (enum_specifier) @enum) @capture`,
            // Namespace definition with preceding comments and trailing comment
            `((comment)* @comment . (namespace_definition) @namespace . (comment)* @trailingComment) @capture`,
            // Namespace definition with just preceding comments
            `((comment)* @comment . (namespace_definition) @namespace) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
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
            `((comment)* @comment . (function_definition) @function) @capture`,
            // Function declaration with preceding comments
            `((comment)* @comment . (declaration type: (_) declarator: (function_declarator)) @function) @capture`
        ],
        classQueries: [
            // Struct specifier with preceding comments
            `((comment)* @comment . (struct_specifier) @struct) @capture`,
            // Enum specifier with preceding comments
            `((comment)* @comment . (enum_specifier) @enum) @capture`
        ],
        methodQueries: [],
        blockQueries: ['(compound_statement) @block']
    },
    'csharp': {
        functionQueries: [
            // Method declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (method_declaration) @function) @capture`,
            // Constructor declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (constructor_declaration) @function) @capture`,
            // Destructor declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (destructor_declaration) @function) @capture`,
            // Operator declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (operator_declaration) @function) @capture`
        ],
        classQueries: [
            // Class declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (class_declaration) @class) @capture`,
            // Interface declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (interface_declaration) @interface) @capture`,
            // Struct declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (struct_declaration) @struct) @capture`,
            // Enum declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (enum_declaration) @enum) @capture`,
            // Namespace declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (namespace_declaration) @namespace) @capture`,
            // Delegate declaration with attributes and preceding comments
            `((comment)* @comment . (attribute_list)* . (delegate_declaration) @delegate) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(block) @block']
    },
    'go': {
        functionQueries: [
            // Function declaration with preceding comments
            `((comment)* @comment . (function_declaration) @function) @capture`,
            // Method declaration with preceding comments
            `((comment)* @comment . (method_declaration) @method) @capture`
        ],
        classQueries: [
            // Type declaration with preceding comments
            `((comment)* @comment . (type_declaration) @type) @capture`,
            // Struct type definition with preceding comments
            `((comment)* @comment . (struct_type) @struct) @capture`,
            // Interface type definition with preceding comments
            `((comment)* @comment . (interface_type) @interface) @capture`,
            // Type specifier with preceding comments
            `((comment)* @comment . (type_spec) @type) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(block) @block']
    },
    'ruby': {
        functionQueries: [
            // Method definition with preceding comments
            `((comment)* @comment . (method) @function) @capture`,
            // Singleton method definition with preceding comments
            `((comment)* @comment . (singleton_method) @function) @capture`
        ],
        classQueries: [
            // Class definition with preceding comments
            `((comment)* @comment . (class) @class) @capture`,
            // Module definition with preceding comments
            `((comment)* @comment . (module) @module) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(do_block) @block', '(block) @block']
    },
    'rust': {
        functionQueries: [
            // Function item with attributes and preceding comments
            `((comment)* @comment . (attribute_item)* . (function_item) @function) @capture`,
            // Function signature item with attributes and preceding comments
            `((comment)* @comment . (attribute_item)* . (function_signature_item) @function) @capture`
        ],
        classQueries: [
            // Struct item with attributes and preceding comments
            `((comment)* @comment . (attribute_item)* . (struct_item) @struct) @capture`,
            // Trait item with attributes and preceding comments
            `((comment)* @comment . (attribute_item)* . (trait_item) @trait) @capture`,
            // Impl item with attributes and preceding comments
            `((comment)* @comment . (attribute_item)* . (impl_item) @impl) @capture`,
            // Enum item with attributes and preceding comments
            `((comment)* @comment . (attribute_item)* . (enum_item) @enum) @capture`,
            // Mod item with attributes and preceding comments
            `((comment)* @comment . (attribute_item)* . (mod_item) @module) @capture`
        ],
        methodQueries: [], // Covered by functionQueries
        blockQueries: ['(block) @block']
    },
    'css': {
        functionQueries: [], // CSS doesn't have functions in the typical sense
        classQueries: [
            // Rule set with preceding comments
            `((comment)* @comment . (rule_set) @rule) @capture`,
            // At-rule with preceding comments
            `((comment)* @comment . (at_rule) @at_rule) @capture`
        ],
        methodQueries: [],
        blockQueries: ['(block) @block']
    }
};
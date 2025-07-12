export interface LanguageQueryConfig {
    /** Queries to find significant code structures that should be treated as breakpoints. */
    pointsOfInterest: string[];
    /** Queries to find comments, decorators, or attributes that often precede points of interest. */
    comments: string[];
}

/**
 * A centralized configuration for Tree-sitter queries across different languages.
 * This configuration separates queries into two main types:
 * - pointsOfInterest: Nodes that represent logical breakpoints for code chunking (e.g., function/class definitions).
 * - comments: Nodes that represent comments or decorators, used to adjust the start line of a point of interest.
 * The '@capture' name is used to designate the primary node for a match.
 */
export const LANGUAGE_QUERIES: Record<string, LanguageQueryConfig> = {
    javascript: {
        pointsOfInterest: [
            '(class_declaration) @capture',
            '(function_declaration) @capture',
            '(variable_declarator value: (arrow_function)) @capture',
            '(export_statement) @capture',
            '(method_definition) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(decorator) @capture',
        ],
    },
    typescript: {
        pointsOfInterest: [
            '(internal_module) @capture',
            '(class_declaration) @capture',
            '(function_declaration) @capture',
            '(variable_declarator value: (arrow_function)) @capture',
            '(export_statement) @capture',
            '(method_definition) @capture',
            '(interface_declaration) @capture',
            '(type_alias_declaration) @capture',
            '(enum_declaration) @capture',
            '(module) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(decorator) @capture',
        ],
    },
    python: {
        pointsOfInterest: [
            '(decorated_definition) @capture',
            '(class_definition) @capture',
            '(function_definition) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(decorator) @capture',
        ],
    },
    java: {
        pointsOfInterest: [
            '(class_declaration) @capture',
            '(interface_declaration) @capture',
            '(enum_declaration) @capture',
            '(method_declaration) @capture',
            '(constructor_declaration) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(marker_annotation) @capture',
        ],
    },
    cpp: {
        pointsOfInterest: [
            '(namespace_definition) @capture',
            // A template declaration is a wrapper, we want the thing inside it
            '(template_declaration . (class_specifier) @capture)',
            '(template_declaration . (struct_specifier) @capture)',
            '(template_declaration . (function_definition) @capture)',
            // Standalone definitions
            '(class_specifier) @capture',
            '(struct_specifier) @capture',
            '(enum_specifier) @capture',
            '(function_definition) @capture',
            // Capture out-of-line method definitions
            '(declaration declarator: (function_declarator)) @capture'
        ],
        comments: ['(comment) @capture'],
    },
    c: {
        pointsOfInterest: [
            '(function_definition) @capture',
            '(declaration declarator: (function_declarator)) @capture',
            '(struct_specifier) @capture',
            '(enum_specifier) @capture',
        ],
        comments: ['(comment) @capture'],
    },
    csharp: {
        pointsOfInterest: [
            '(namespace_declaration) @capture',
            '(class_declaration) @capture',
            '(struct_declaration) @capture',
            '(interface_declaration) @capture',
            '(enum_declaration) @capture',
            '(delegate_declaration) @capture',
            '(method_declaration) @capture',
            '(constructor_declaration) @capture',
            '(property_declaration) @capture',
            '(destructor_declaration) @capture',
            '(operator_declaration) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(attribute_list) @capture',
        ],
    },
    go: {
        pointsOfInterest: [
            '(package_clause) @capture',
            '(function_declaration) @capture',
            '(method_declaration) @capture',
            '(type_declaration) @capture',
            '(struct_type) @capture',
            '(interface_type) @capture',
        ],
        comments: ['(comment) @capture'],
    },
    ruby: {
        pointsOfInterest: [
            '(class) @capture',
            '(module) @capture',
            '(method) @capture',
            '(singleton_method) @capture',
        ],
        comments: ['(comment) @capture'],
    },
    rust: {
        pointsOfInterest: [
            '(mod_item) @capture',
            '(struct_item) @capture',
            '(enum_item) @capture',
            '(trait_item) @capture',
            '(impl_item) @capture',
            '(function_item) @capture',
            '(function_signature_item) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(attribute_item) @capture',
        ],
    },
    css: {
        pointsOfInterest: [
            '(at_rule) @capture',
            '(media_statement) @capture',
            '(namespace_statement) @capture',
            '(keyframes_statement) @capture',
            '(rule_set) @capture',
        ],
        comments: ['(comment) @capture'],
    }
};
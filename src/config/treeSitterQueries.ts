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
            '(import_statement) @capture',
            '(export_statement) @capture',
            '(class_declaration) @capture',
            '(function_declaration) @capture',
            '(arrow_function) @capture',
            '(method_definition) @capture',
            '(statement_block) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(decorator) @capture',
        ],
    },
    typescript: {
        pointsOfInterest: [
            '(import_statement) @capture',
            '(export_statement) @capture',
            '(class_declaration) @capture',
            '(function_declaration) @capture',
            '(arrow_function) @capture',
            '(method_definition) @capture',
            '(interface_declaration) @capture',
            '(type_alias_declaration) @capture',
            '(enum_declaration) @capture',
            '(module) @capture',
            '(statement_block) @capture',
        ],
        comments: [
            '(comment) @capture',
            '(decorator) @capture',
        ],
    },
    python: {
        pointsOfInterest: [
            '(import_statement) @capture',
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
            '(import_declaration) @capture',
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
            '(preproc_include) @capture',
            '(namespace_definition) @capture',
            '(class_specifier) @capture',
            '(struct_specifier) @capture',
            '(enum_specifier) @capture',
            '(function_definition) @capture',
            '(template_declaration) @capture',
            '(declaration) @capture',
            '(field_declaration) @capture',
        ],
        comments: ['(comment) @capture'],
    },
    c: {
        pointsOfInterest: [
            '(preproc_include) @capture',
            '(function_definition) @capture',
            '(declaration declarator: (function_declarator)) @capture',
            '(struct_specifier) @capture',
            '(enum_specifier) @capture',
            '(declaration) @capture',
            '(field_declaration) @capture',
        ],
        comments: ['(comment) @capture'],
    },
    csharp: {
        pointsOfInterest: [
            '(using_directive) @capture',
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
            '(import_declaration) @capture',
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
            '(require) @capture',
            '(class) @capture',
            '(module) @capture',
            '(method) @capture',
            '(singleton_method) @capture',
        ],
        comments: ['(comment) @capture'],
    },
    rust: {
        pointsOfInterest: [
            '(use_declaration) @capture',
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
            '(rule_set) @capture',
            '(@at_rule) @capture',
        ],
        comments: ['(comment) @capture'],
    }
};
/**
 * Supported languages for indexing and analysis
 */
export interface SupportedLanguage {
    extension: string;
    language: string;
    treeSitterGrammar?: string; // The tree-sitter grammar module name
    variant?: string; // For languages with variants like TypeScript/TSX
}

/**
 * Map of supported file extensions to language details
 */
export const SUPPORTED_LANGUAGES: Record<string, SupportedLanguage> = {
    'js': { extension: 'js', language: 'javascript', treeSitterGrammar: 'tree-sitter-javascript' },
    'jsx': { extension: 'jsx', language: 'javascript', treeSitterGrammar: 'tree-sitter-javascript' },
    'ts': { extension: 'ts', language: 'typescript', treeSitterGrammar: 'tree-sitter-typescript' },
    'tsx': { extension: 'tsx', language: 'typescript', treeSitterGrammar: 'tree-sitter-typescript', variant: 'tsx' },
    'py': { extension: 'py', language: 'python', treeSitterGrammar: 'tree-sitter-python' },
    'pyw': { extension: 'pyw', language: 'python', treeSitterGrammar: 'tree-sitter-python' },
    'java': { extension: 'java', language: 'java', treeSitterGrammar: 'tree-sitter-java' },
    'c': { extension: 'c', language: 'c', treeSitterGrammar: 'tree-sitter-cpp' },
    'cpp': { extension: 'cpp', language: 'cpp', treeSitterGrammar: 'tree-sitter-cpp' },
    'h': { extension: 'h', language: 'cpp', treeSitterGrammar: 'tree-sitter-cpp' },
    'hpp': { extension: 'hpp', language: 'cpp', treeSitterGrammar: 'tree-sitter-cpp' },
    'cs': { extension: 'cs', language: 'csharp', treeSitterGrammar: 'tree-sitter-c-sharp' },
    'go': { extension: 'go', language: 'go', treeSitterGrammar: 'tree-sitter-go' },
    'rb': { extension: 'rb', language: 'ruby', treeSitterGrammar: 'tree-sitter-ruby' },
    'rs': { extension: 'rs', language: 'rust', treeSitterGrammar: 'tree-sitter-rust' },
    'css': { extension: 'css', language: 'css', treeSitterGrammar: 'tree-sitter-css' },
};

/**
 * Get a glob pattern for finding supported source files
 * @returns A glob pattern matching all supported file extensions
 */
export function getSupportedFilesGlob(): string {
    const extensions = Object.keys(SUPPORTED_LANGUAGES).join(',');
    return `**/*.{${extensions}}`;
}

/**
 * Get a VS Code exclude pattern for filtering out non-source directories
 * @returns A pattern to exclude common non-source directories
 */
export function getExcludePattern(): string {
    return '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**';
}

/**
 * Get language data for a file extension
 * @param extension The file extension (without dot)
 * @returns The language data or undefined if not supported
 */
export function getLanguageForExtension(extension: string): SupportedLanguage | undefined {
    return SUPPORTED_LANGUAGES[extension];
}

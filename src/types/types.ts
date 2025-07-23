/**
 * Supported languages for indexing and analysis
 */
export interface SupportedLanguage {
    extension: string;
    language: string;
    treeSitterGrammar?: string; // The tree-sitter grammar module name
    variant?: string; // For languages with variants like TypeScript/TSX
    lineCommentMarker: string | undefined; // The marker for single-line comments
}

/**
 * Map of supported file extensions to language details
 */
export const SUPPORTED_LANGUAGES: Record<string, SupportedLanguage> = {
    'js': { extension: 'js', language: 'javascript', treeSitterGrammar: 'tree-sitter-javascript', lineCommentMarker: '//' },
    'jsx': { extension: 'jsx', language: 'javascript', treeSitterGrammar: 'tree-sitter-javascript', lineCommentMarker: '//' },
    'ts': { extension: 'ts', language: 'typescript', treeSitterGrammar: 'tree-sitter-typescript', lineCommentMarker: '//' },
    'tsx': { extension: 'tsx', language: 'typescript', treeSitterGrammar: 'tree-sitter-typescript', variant: 'tsx', lineCommentMarker: '//' },
    'py': { extension: 'py', language: 'python', treeSitterGrammar: 'tree-sitter-python', lineCommentMarker: '#' },
    'pyw': { extension: 'pyw', language: 'python', treeSitterGrammar: 'tree-sitter-python', lineCommentMarker: '#' },
    'java': { extension: 'java', language: 'java', treeSitterGrammar: 'tree-sitter-java', lineCommentMarker: '//' },
    'c': { extension: 'c', language: 'c', treeSitterGrammar: 'tree-sitter-cpp', lineCommentMarker: '//' },
    'cpp': { extension: 'cpp', language: 'cpp', treeSitterGrammar: 'tree-sitter-cpp', lineCommentMarker: '//' },
    'h': { extension: 'h', language: 'cpp', treeSitterGrammar: 'tree-sitter-cpp', lineCommentMarker: '//' },
    'hpp': { extension: 'hpp', language: 'cpp', treeSitterGrammar: 'tree-sitter-cpp', lineCommentMarker: '//' },
    'cs': { extension: 'cs', language: 'csharp', treeSitterGrammar: 'tree-sitter-c-sharp', lineCommentMarker: '//' },
    'go': { extension: 'go', language: 'go', treeSitterGrammar: 'tree-sitter-go', lineCommentMarker: '//' },
    'rb': { extension: 'rb', language: 'ruby', treeSitterGrammar: 'tree-sitter-ruby', lineCommentMarker: '#' },
    'rs': { extension: 'rs', language: 'rust', treeSitterGrammar: 'tree-sitter-rust', lineCommentMarker: '//' },
    'css': { extension: 'css', language: 'css', treeSitterGrammar: 'tree-sitter-css', lineCommentMarker: undefined },
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

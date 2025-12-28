/**
 * Supported languages for analysis
 */
export interface SupportedLanguage {
    extension: string;
    language: string;
    variant?: string; // For languages with variants like TypeScript/TSX
    lineCommentMarker: string | undefined; // The marker for single-line comments
}

/**
 * Map of supported file extensions to language details
 */
export const SUPPORTED_LANGUAGES: Record<string, SupportedLanguage> = {
    js: { extension: 'js', language: 'javascript', lineCommentMarker: '//' },
    jsx: { extension: 'jsx', language: 'javascript', lineCommentMarker: '//' },
    ts: { extension: 'ts', language: 'typescript', lineCommentMarker: '//' },
    tsx: {
        extension: 'tsx',
        language: 'typescript',
        variant: 'tsx',
        lineCommentMarker: '//',
    },
    py: { extension: 'py', language: 'python', lineCommentMarker: '#' },
    pyw: { extension: 'pyw', language: 'python', lineCommentMarker: '#' },
    java: { extension: 'java', language: 'java', lineCommentMarker: '//' },
    c: { extension: 'c', language: 'c', lineCommentMarker: '//' },
    cpp: { extension: 'cpp', language: 'cpp', lineCommentMarker: '//' },
    h: { extension: 'h', language: 'cpp', lineCommentMarker: '//' },
    hpp: { extension: 'hpp', language: 'cpp', lineCommentMarker: '//' },
    cs: { extension: 'cs', language: 'csharp', lineCommentMarker: '//' },
    go: { extension: 'go', language: 'go', lineCommentMarker: '//' },
    rb: { extension: 'rb', language: 'ruby', lineCommentMarker: '#' },
    rs: { extension: 'rs', language: 'rust', lineCommentMarker: '//' },
    css: { extension: 'css', language: 'css', lineCommentMarker: undefined },
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
export function getLanguageForExtension(
    extension: string
): SupportedLanguage | undefined {
    return SUPPORTED_LANGUAGES[extension];
}

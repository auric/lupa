
/**
 * Supported languages for indexing and analysis
 */
export interface SupportedLanguage {
    extension: string;
    language: string;
}

/**
 * Map of supported file extensions to language names
 */
export const SUPPORTED_LANGUAGES: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'cpp',
    'hpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rb': 'ruby',
    'php': 'php'
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

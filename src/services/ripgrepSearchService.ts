import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodeFileDetector } from '../utils/codeFileDetector';

/**
 * Gets the path to ripgrep binary bundled with VS Code.
 *
 * VS Code ships with ripgrep in one of two locations:
 * - node_modules/@vscode/ripgrep/bin/ (standard installation)
 * - node_modules.asar.unpacked/@vscode/ripgrep/bin/ (asar-packed builds)
 *
 * This function checks both paths and returns the first one that exists.
 *
 * If VS Code changes this path in the future, the extension should fall back
 * to platform-specific packaging with @vscode/ripgrep as a bundled dependency.
 * See: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions
 */
function getVSCodeRipgrepPath(): string {
    const rgBinary = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const appRoot = vscode.env.appRoot;

    // Try both possible locations
    const candidatePaths = [
        path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', rgBinary),
        path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', rgBinary),
    ];

    for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    // Return the first path for error messaging (will fail validation)
    return candidatePaths[0]!;
}

/**
 * Validates that the VS Code ripgrep binary exists at the expected path.
 * @returns true if the binary exists, false otherwise
 */
export function validateRipgrepPath(rgPath: string): boolean {
    return fs.existsSync(rgPath);
}

export interface RipgrepMatch {
    filePath: string;
    lineNumber: number;
    content: string;
    isContext: boolean;
}

export interface RipgrepFileResult {
    filePath: string;
    matches: RipgrepMatch[];
}

export interface RipgrepSearchOptions {
    pattern: string;
    cwd: string;
    searchPath?: string;
    linesBefore?: number;
    linesAfter?: number;
    caseSensitive?: boolean;
    includeGlob?: string;
    excludeGlob?: string;
    codeFilesOnly?: boolean;
    multiline: boolean;
}

interface RipgrepJsonMessage {
    type: 'begin' | 'match' | 'context' | 'end' | 'summary';
    data: RipgrepBeginData | RipgrepMatchData | RipgrepContextData | RipgrepEndData | RipgrepSummaryData;
}

interface RipgrepBeginData {
    path: { text?: string; bytes?: string };
}

interface RipgrepMatchData {
    path: { text?: string; bytes?: string };
    lines: { text?: string; bytes?: string };
    line_number: number;
    absolute_offset: number;
    submatches: Array<{ match: { text?: string }; start: number; end: number }>;
}

interface RipgrepContextData {
    path: { text?: string; bytes?: string };
    lines: { text?: string; bytes?: string };
    line_number: number;
    absolute_offset: number;
    submatches: Array<{ match: { text?: string }; start: number; end: number }>;
}

interface RipgrepEndData {
    path: { text?: string; bytes?: string };
    binary_offset: number | null;
    stats: {
        elapsed: { secs: number; nanos: number; human: string };
        searches: number;
        searches_with_match: number;
        bytes_searched: number;
        bytes_printed: number;
        matched_lines: number;
        matches: number;
    };
}

interface RipgrepSummaryData {
    elapsed_total: { secs: number; nanos: number; human: string };
    stats: {
        searches: number;
        searches_with_match: number;
        bytes_searched: number;
        bytes_printed: number;
        matched_lines: number;
        matches: number;
    };
}

export class RipgrepSearchService {
    private readonly rgPath: string;

    constructor() {
        this.rgPath = getVSCodeRipgrepPath();

        // Validate ripgrep binary exists at startup
        if (!validateRipgrepPath(this.rgPath)) {
            const errorMsg = `VS Code ripgrep binary not found at: ${this.rgPath}. ` +
                `This may indicate VS Code has changed its internal structure. ` +
                `Please report this issue at https://github.com/auric/lupa/issues`;
            throw new Error(errorMsg);
        }
    }

    async search(options: RipgrepSearchOptions): Promise<RipgrepFileResult[]> {
        const args = this.buildArgs(options);

        return new Promise((resolve, reject) => {
            const results = new Map<string, RipgrepMatch[]>();
            let stderr = '';

            const rg: ChildProcess = spawn(this.rgPath, args, {
                cwd: options.cwd,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let buffer = '';

            rg.stdout?.on('data', (data: Buffer) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.trim()) {continue;}

                    try {
                        const message = JSON.parse(line) as RipgrepJsonMessage;
                        this.processMessage(message, results, options.cwd);
                    } catch {
                        // Skip malformed JSON lines
                    }
                }
            });

            rg.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            rg.on('close', (code: number | null) => {
                // Process remaining buffer
                if (buffer.trim()) {
                    try {
                        const message = JSON.parse(buffer) as RipgrepJsonMessage;
                        this.processMessage(message, results, options.cwd);
                    } catch {
                        // Skip malformed JSON
                    }
                }

                // ripgrep exit codes: 0 = matches found, 1 = no matches, 2 = error
                if (code === 2) {
                    reject(new Error(`ripgrep error: ${stderr}`));
                    return;
                }

                const fileResults: RipgrepFileResult[] = [];
                for (const [filePath, matches] of results) {
                    fileResults.push({ filePath, matches });
                }

                resolve(fileResults);
            });

            rg.on('error', (err: Error) => {
                reject(new Error(`Failed to spawn ripgrep: ${err.message}`));
            });
        });
    }

    private buildArgs(options: RipgrepSearchOptions): string[] {
        const args: string[] = [
            '--json',
            '--no-heading',
            '--line-number',
            '--with-filename'
        ];

        if (!options.caseSensitive) {
            args.push('--ignore-case');
        } else {
            args.push('--case-sensitive');
        }

        if (options.linesBefore && options.linesBefore > 0) {
            args.push('--before-context', String(options.linesBefore));
        }

        if (options.linesAfter && options.linesAfter > 0) {
            args.push('--after-context', String(options.linesAfter));
        }

        if (options.multiline) {
            args.push('--multiline');
        }

        if (options.includeGlob) {
            args.push('--glob', options.includeGlob);
        }

        if (options.excludeGlob) {
            args.push('--glob', `!${options.excludeGlob}`);
        }

        if (options.codeFilesOnly) {
            args.push('--glob', CodeFileDetector.getGlobPattern());
            for (const filename of CodeFileDetector.getSupportedFilenames()) {
                args.push('--glob', filename);
            }
        }

        args.push('--regexp', options.pattern);

        // Search target: file path, directory path, or '.' for entire project
        args.push(options.searchPath || '.');

        return args;
    }

    private processMessage(
        message: RipgrepJsonMessage,
        results: Map<string, RipgrepMatch[]>,
        cwd: string
    ): void {
        if (message.type === 'match' || message.type === 'context') {
            const data = message.data as RipgrepMatchData | RipgrepContextData;
            const filePath = this.extractText(data.path);
            if (!filePath) {return;}

            const relativePath = this.normalizeFilePath(filePath, cwd);
            const lineContent = this.extractText(data.lines)?.replace(/\n$/, '') ?? '';

            const match: RipgrepMatch = {
                filePath: relativePath,
                lineNumber: data.line_number,
                content: lineContent,
                isContext: message.type === 'context'
            };

            const existing = results.get(relativePath);
            if (existing) {
                existing.push(match);
            } else {
                results.set(relativePath, [match]);
            }
        }
    }

    private extractText(obj: { text?: string; bytes?: string }): string | undefined {
        if (obj.text) {return obj.text;}
        if (obj.bytes) {
            try {
                return Buffer.from(obj.bytes, 'base64').toString('utf-8');
            } catch {
                return undefined;
            }
        }
        return undefined;
    }

    private normalizeFilePath(filePath: string, _cwd: string): string {
        // Remove leading ./ if present
        let normalized = filePath.replace(/^\.[\\/]/, '');
        // Normalize path separators to forward slashes
        normalized = normalized.replace(/\\/g, '/');
        return normalized;
    }

    formatResults(fileResults: RipgrepFileResult[]): string {
        const lines: string[] = [];

        for (const fileResult of fileResults) {
            lines.push(`=== ${fileResult.filePath} ===`);

            // Sort matches by line number
            const sortedMatches = [...fileResult.matches].sort((a, b) => a.lineNumber - b.lineNumber);

            // Group consecutive lines
            const groups = this.groupConsecutiveLines(sortedMatches);

            for (let i = 0; i < groups.length; i++) {
                const group = groups[i]!;
                for (const match of group) {
                    lines.push(`${match.lineNumber}: ${match.content}`);
                }
                if (i < groups.length - 1) {
                    lines.push('');
                }
            }

            lines.push('');
        }

        return lines.join('\n').trim();
    }

    private groupConsecutiveLines(matches: RipgrepMatch[]): RipgrepMatch[][] {
        if (matches.length === 0) {return [];}

        const firstMatch = matches[0]!;
        const groups: RipgrepMatch[][] = [];
        let currentGroup: RipgrepMatch[] = [firstMatch];

        for (let i = 1; i < matches.length; i++) {
            const current = matches[i]!;
            const previous = currentGroup[currentGroup.length - 1]!;

            // Allow gap of 1 line between groups
            if (current.lineNumber <= previous.lineNumber + 2) {
                currentGroup.push(current);
            } else {
                groups.push(currentGroup);
                currentGroup = [current];
            }
        }

        groups.push(currentGroup);
        return groups;
    }
}

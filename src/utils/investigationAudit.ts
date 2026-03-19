import type { ToolCallRecord } from '../types/toolCallTypes';
import type {
    InvestigationAudit,
    FileReadEntry,
    SymbolResolutionEntry,
    UsageCheckEntry,
    PatternSearchEntry,
    InvestigationDepth,
} from '../types/investigationTypes';

const KNOWN_KINDS = [
    'function',
    'class',
    'interface',
    'method',
    'property',
    'variable',
    'enum',
    'type',
    'module',
    'namespace',
    'constructor',
    'constant',
];
const DEPTH_PER_SIGNAL = 2;
const MAX_DEPTH = 10;

export function flattenToolCalls(
    toolCalls: ToolCallRecord[]
): ToolCallRecord[] {
    const result: ToolCallRecord[] = [];
    for (const call of toolCalls) {
        result.push(call);
        if (call.nestedCalls && call.nestedCalls.length > 0) {
            result.push(...flattenToolCalls(call.nestedCalls));
        }
    }
    return result;
}

function getStringArg(
    args: Record<string, unknown>,
    key: string
): string | undefined {
    const val = args[key];
    return typeof val === 'string' ? val : undefined;
}

function getNumberArg(
    args: Record<string, unknown>,
    key: string
): number | undefined {
    const val = args[key];
    return typeof val === 'number' ? val : undefined;
}

function resultToString(result: string | Record<string, unknown>): string {
    if (typeof result === 'string') {
        return result;
    }
    try {
        return JSON.stringify(result);
    } catch {
        return '';
    }
}

function extractKindFromResult(
    result: string | Record<string, unknown>
): string {
    const text = resultToString(result).toLowerCase();
    for (const kind of KNOWN_KINDS) {
        if (text.includes(kind)) {
            return kind;
        }
    }
    return 'unknown';
}

function extractNumberFromResult(
    result: string | Record<string, unknown>
): number {
    const text = resultToString(result);
    const match = /(\d+)/.exec(text);
    return match?.[1] ? parseInt(match[1], 10) : 0;
}

function parseDiffFilePaths(args: Record<string, unknown>): string[] {
    const filePaths = args['file_paths'];
    if (Array.isArray(filePaths)) {
        return filePaths.filter((p): p is string => typeof p === 'string');
    }
    if (typeof filePaths === 'string') {
        return filePaths
            .split('\n')
            .map((p) => p.trim())
            .filter(Boolean);
    }
    return [];
}

function extractFileReads(calls: ToolCallRecord[]): FileReadEntry[] {
    const entries: FileReadEntry[] = [];
    for (const call of calls) {
        if (call.toolName !== 'read_file') {
            continue;
        }
        const filePath = getStringArg(call.arguments, 'file_path');
        if (!filePath) {
            continue;
        }
        const startLine = getNumberArg(call.arguments, 'start_line') ?? 0;
        const endLine = getNumberArg(call.arguments, 'end_line') ?? 0;
        entries.push({ path: filePath, lineRange: [startLine, endLine] });
    }
    return entries;
}

function extractSymbolsResolved(
    calls: ToolCallRecord[]
): SymbolResolutionEntry[] {
    const entries: SymbolResolutionEntry[] = [];
    for (const call of calls) {
        if (call.toolName !== 'find_symbol') {
            continue;
        }
        const name = getStringArg(call.arguments, 'name_path');
        const file =
            getStringArg(call.arguments, 'relative_path') ??
            getStringArg(call.arguments, 'file_path') ??
            'unknown';
        if (!name) {
            continue;
        }
        const kind = extractKindFromResult(call.result);
        entries.push({ name, file, kind });
    }
    return entries;
}

function extractUsagesChecked(calls: ToolCallRecord[]): UsageCheckEntry[] {
    const entries: UsageCheckEntry[] = [];
    for (const call of calls) {
        if (call.toolName !== 'find_usages') {
            continue;
        }
        const symbol = getStringArg(call.arguments, 'symbol_name');
        if (!symbol) {
            continue;
        }
        const referenceCount = extractNumberFromResult(call.result);
        entries.push({ symbol, referenceCount });
    }
    return entries;
}

function extractPatternsSearched(
    calls: ToolCallRecord[]
): PatternSearchEntry[] {
    const entries: PatternSearchEntry[] = [];
    for (const call of calls) {
        if (call.toolName !== 'search_for_pattern') {
            continue;
        }
        const query = getStringArg(call.arguments, 'pattern');
        if (!query) {
            continue;
        }
        const matchCount = extractNumberFromResult(call.result);
        entries.push({ query, matchCount });
    }
    return entries;
}

function extractDiffsExamined(calls: ToolCallRecord[]): string[] {
    const paths = new Set<string>();
    for (const call of calls) {
        if (call.toolName !== 'get_file_diff') {
            continue;
        }
        for (const p of parseDiffFilePaths(call.arguments)) {
            paths.add(p);
        }
    }
    return [...paths];
}

function computeDepthScores(
    filesRead: FileReadEntry[],
    diffsExamined: string[],
    symbolsResolved: SymbolResolutionEntry[],
    usagesChecked: UsageCheckEntry[],
    patternsSearched: PatternSearchEntry[]
): Map<string, InvestigationDepth> {
    const scores = new Map<string, InvestigationDepth>();

    const allFiles = new Set<string>();
    for (const f of filesRead) {
        allFiles.add(f.path);
    }
    for (const d of diffsExamined) {
        allFiles.add(d);
    }
    for (const s of symbolsResolved) {
        allFiles.add(s.file);
    }

    const diffSet = new Set(diffsExamined);
    const readSet = new Set(filesRead.map((f) => f.path));
    const symbolFiles = new Set(symbolsResolved.map((s) => s.file));

    const usageSymbols = new Set(usagesChecked.map((u) => u.symbol));
    const symbolToFile = new Map<string, Set<string>>();
    for (const s of symbolsResolved) {
        if (!symbolToFile.has(s.name)) {
            symbolToFile.set(s.name, new Set());
        }
        symbolToFile.get(s.name)!.add(s.file);
    }

    for (const file of allFiles) {
        let score = 0;
        const parts: string[] = [];

        if (diffSet.has(file)) {
            score += DEPTH_PER_SIGNAL;
            parts.push('diff');
        }
        if (readSet.has(file)) {
            score += DEPTH_PER_SIGNAL;
            parts.push('read');
        }
        if (symbolFiles.has(file)) {
            score += DEPTH_PER_SIGNAL;
            parts.push('symbols');
        }

        let hasUsageForFile = false;
        for (const [sym, files] of symbolToFile) {
            if (files.has(file) && usageSymbols.has(sym)) {
                hasUsageForFile = true;
                break;
            }
        }
        if (hasUsageForFile) {
            score += DEPTH_PER_SIGNAL;
            parts.push('usages');
        }

        if (
            patternsSearched.length > 0 &&
            (readSet.has(file) || diffSet.has(file))
        ) {
            score += DEPTH_PER_SIGNAL;
            parts.push('patterns');
        }

        score = Math.min(score, MAX_DEPTH);
        scores.set(file, { score, breakdown: parts.join(' + ') });
    }

    return scores;
}

export function buildInvestigationAudit(
    toolCalls: ToolCallRecord[]
): InvestigationAudit {
    if (toolCalls.length === 0) {
        return {
            filesRead: [],
            symbolsResolved: [],
            usagesChecked: [],
            patternsSearched: [],
            diffsExamined: [],
            depthScores: new Map(),
        };
    }

    const flat = flattenToolCalls(toolCalls);
    const filesRead = extractFileReads(flat);
    const symbolsResolved = extractSymbolsResolved(flat);
    const usagesChecked = extractUsagesChecked(flat);
    const patternsSearched = extractPatternsSearched(flat);
    const diffsExamined = extractDiffsExamined(flat);
    const depthScores = computeDepthScores(
        filesRead,
        diffsExamined,
        symbolsResolved,
        usagesChecked,
        patternsSearched
    );

    return {
        filesRead,
        symbolsResolved,
        usagesChecked,
        patternsSearched,
        diffsExamined,
        depthScores,
    };
}

/**
 * Return a one-line audit summary without per-file breakdown.
 * Used for subagent results where the parent already knows which files were assigned.
 */
export function formatCompactAudit(audit: InvestigationAudit): string {
    const fileCount = new Set([
        ...audit.filesRead.map((f) => f.path),
        ...audit.diffsExamined,
    ]).size;

    if (fileCount === 0) {
        return '';
    }

    const scores = [...audit.depthScores.entries()];
    const avgDepth =
        scores.length > 0
            ? (
                  scores.reduce((sum, [, d]) => sum + d.score, 0) /
                  scores.length
              ).toFixed(1)
            : '0.0';

    return (
        `\nAudit: ${fileCount} files, avg depth ${avgDepth}/${MAX_DEPTH}. ` +
        `Symbols: ${audit.symbolsResolved.length}, ` +
        `Usages: ${audit.usagesChecked.length}, ` +
        `Patterns: ${audit.patternsSearched.length}`
    );
}

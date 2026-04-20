interface FileHandle {
    readAll(): string;
    close(): void;
}

declare function openFile(path: string): FileHandle;

export interface ProcessResult {
    lineCount: number;
    firstLine: string;
}

export function processFile(path: string): ProcessResult {
    const handle = openFile(path);
    try {
        const content = handle.readAll();
        const lines = content.split('\n');
        if (lines.length === 0) {
            return { lineCount: 0, firstLine: '' };
        }
        return { lineCount: lines.length, firstLine: lines[0] };
    } finally {
        handle.close();
    }
}

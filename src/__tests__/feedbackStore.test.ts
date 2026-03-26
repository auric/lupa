import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { FeedbackStore, FeedbackFile } from '../services/feedbackStore';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

const mockFeedbackUri = {
    fsPath: '/mock/.vscode/lupa-feedback.json',
    toString: () => '/mock/.vscode/lupa-feedback.json',
};

const mockFolder: vscode.WorkspaceFolder = {
    uri: { fsPath: '/mock', scheme: 'file', path: '/mock' } as any,
    name: 'mock',
    index: 0,
};

function makeFeedbackFile(entries: FeedbackFile['entries']): FeedbackFile {
    return { version: 1, entries };
}

function encodeFeedbackFile(file: FeedbackFile): Uint8Array {
    return Buffer.from(JSON.stringify(file));
}

describe('FeedbackStore', () => {
    let mockReadFile: ReturnType<typeof vi.fn>;
    let mockWriteFile: ReturnType<typeof vi.fn>;
    let mockDelete: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();

        // Override Uri.joinPath to return a simple mock URI
        vi.mocked(vscode.Uri.joinPath).mockReturnValue(mockFeedbackUri as any);

        mockReadFile = vi.mocked(vscode.workspace.fs.readFile);
        mockWriteFile = vi.mocked(vscode.workspace.fs.writeFile);
        mockDelete = vi.mocked(vscode.workspace.fs.delete);

        // Default: file not found
        mockReadFile.mockRejectedValue(
            vscode.FileSystemError.FileNotFound('not found')
        );
        mockWriteFile.mockResolvedValue(undefined);
        mockDelete.mockResolvedValue(undefined);
    });

    it('record() adds entry with generated id and timestamp', async () => {
        const store = new FeedbackStore(mockFolder);
        await store.load();

        await store.record({
            category: 'security',
            severity: 'HIGH',
            modelFamily: 'gpt-4',
            verdict: 'accepted',
        });

        const entries = store.getAll();
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBeDefined();
        expect(entries[0].id.length).toBeGreaterThan(0);
        expect(entries[0].timestamp).toBeDefined();
        expect(entries[0].category).toBe('security');
        expect(entries[0].verdict).toBe('accepted');
    });

    it('getAll() returns all entries', async () => {
        const store = new FeedbackStore(mockFolder);
        await store.load();

        await store.record({
            category: 'a',
            severity: 'LOW',
            modelFamily: 'm1',
            verdict: 'accepted',
        });
        await store.record({
            category: 'b',
            severity: 'HIGH',
            modelFamily: 'm2',
            verdict: 'rejected',
        });

        expect(store.getAll()).toHaveLength(2);
    });

    it('getStats() correctly counts by category and modelFamily', async () => {
        const store = new FeedbackStore(mockFolder);
        await store.load();

        await store.record({
            category: 'perf',
            severity: 'MEDIUM',
            modelFamily: 'gpt-4',
            verdict: 'accepted',
        });
        await store.record({
            category: 'perf',
            severity: 'MEDIUM',
            modelFamily: 'gpt-4',
            verdict: 'rejected',
        });
        await store.record({
            category: 'perf',
            severity: 'MEDIUM',
            modelFamily: 'gpt-4',
            verdict: 'rejected',
        });
        await store.record({
            category: 'perf',
            severity: 'MEDIUM',
            modelFamily: 'gpt-4',
            verdict: 'dismissed',
        });
        // Different model family — should not count
        await store.record({
            category: 'perf',
            severity: 'MEDIUM',
            modelFamily: 'claude',
            verdict: 'rejected',
        });

        const stats = store.getStats('perf', 'gpt-4');
        expect(stats.accepted).toBe(1);
        expect(stats.rejected).toBe(2);
        expect(stats.dismissed).toBe(1);
        expect(stats.total).toBe(4);
    });

    it('getRejectionRate() returns ratio', async () => {
        const store = new FeedbackStore(mockFolder);
        await store.load();

        await store.record({
            category: 'sec',
            severity: 'HIGH',
            modelFamily: 'gpt-4',
            verdict: 'rejected',
        });
        await store.record({
            category: 'sec',
            severity: 'HIGH',
            modelFamily: 'gpt-4',
            verdict: 'accepted',
        });

        expect(store.getRejectionRate('sec', 'gpt-4')).toBe(0.5);
    });

    it('getRejectionRate() returns 0 for unknown category', () => {
        const store = new FeedbackStore(mockFolder);
        expect(store.getRejectionRate('nonexistent', 'gpt-4')).toBe(0);
    });

    it('load() parses valid JSON from disk', async () => {
        const file = makeFeedbackFile([
            {
                id: 'existing-1',
                category: 'bug',
                severity: 'HIGH',
                modelFamily: 'gpt-4',
                verdict: 'accepted',
                timestamp: '2025-01-01T00:00:00.000Z',
            },
        ]);
        mockReadFile.mockResolvedValue(encodeFeedbackFile(file));

        const store = new FeedbackStore(mockFolder);
        await store.load();

        expect(store.getAll()).toHaveLength(1);
        expect(store.getAll()[0].id).toBe('existing-1');
    });

    it('load() handles missing file gracefully', async () => {
        mockReadFile.mockRejectedValue(
            vscode.FileSystemError.FileNotFound('not found')
        );

        const store = new FeedbackStore(mockFolder);
        await store.load();

        expect(store.getAll()).toHaveLength(0);
    });

    it('load() handles corrupt JSON gracefully', async () => {
        mockReadFile.mockResolvedValue(Buffer.from('not json'));

        const store = new FeedbackStore(mockFolder);
        await store.load();

        expect(store.getAll()).toHaveLength(0);
    });

    it('load() handles invalid schema gracefully', async () => {
        mockReadFile.mockResolvedValue(
            Buffer.from(JSON.stringify({ version: 99, entries: 'bad' }))
        );

        const store = new FeedbackStore(mockFolder);
        await store.load();

        expect(store.getAll()).toHaveLength(0);
    });

    it('load() is idempotent', async () => {
        const file = makeFeedbackFile([
            {
                id: '1',
                category: 'x',
                severity: 'LOW',
                modelFamily: 'm',
                verdict: 'accepted',
                timestamp: '2025-01-01T00:00:00.000Z',
            },
        ]);
        mockReadFile.mockResolvedValue(encodeFeedbackFile(file));

        const store = new FeedbackStore(mockFolder);
        await store.load();
        await store.load();

        expect(mockReadFile).toHaveBeenCalledTimes(1);
        expect(store.getAll()).toHaveLength(1);
    });

    it('clear() removes all entries', async () => {
        const store = new FeedbackStore(mockFolder);
        await store.load();

        await store.record({
            category: 'a',
            severity: 'LOW',
            modelFamily: 'm',
            verdict: 'accepted',
        });
        expect(store.getAll()).toHaveLength(1);

        await store.clear();

        expect(store.getAll()).toHaveLength(0);
        expect(mockDelete).toHaveBeenCalled();
    });

    it('operates in memory when no workspace folder', async () => {
        const store = new FeedbackStore(undefined);
        await store.load();

        await store.record({
            category: 'a',
            severity: 'LOW',
            modelFamily: 'm',
            verdict: 'accepted',
        });

        expect(store.getAll()).toHaveLength(1);
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('trims oldest entries beyond MAX_ENTRIES', async () => {
        // Load 1000 existing entries
        const existingEntries = Array.from({ length: 1000 }, (_, i) => ({
            id: `old-${i}`,
            category: 'bulk',
            severity: 'LOW',
            modelFamily: 'gpt-4',
            verdict: 'accepted' as const,
            timestamp: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }));
        mockReadFile.mockResolvedValue(
            encodeFeedbackFile(makeFeedbackFile(existingEntries))
        );

        const store = new FeedbackStore(mockFolder);
        await store.load();
        expect(store.getAll()).toHaveLength(1000);

        // Record one more — should trim oldest
        await store.record({
            category: 'new',
            severity: 'HIGH',
            modelFamily: 'gpt-4',
            verdict: 'rejected',
        });

        const all = store.getAll();
        expect(all).toHaveLength(1000);
        // First entry should be old-1 (old-0 trimmed)
        expect(all[0].id).toBe('old-1');
        // Last entry should be the new one
        expect(all[all.length - 1].category).toBe('new');
    });

    it('record() persists to disk via writeFile', async () => {
        const store = new FeedbackStore(mockFolder);
        await store.load();

        await store.record({
            category: 'x',
            severity: 'LOW',
            modelFamily: 'm',
            verdict: 'accepted',
        });

        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        const writtenData = mockWriteFile.mock.calls[0][1] as Buffer;
        const parsed = JSON.parse(Buffer.from(writtenData).toString('utf-8'));
        expect(parsed.version).toBe(1);
        expect(parsed.entries).toHaveLength(1);
    });
});

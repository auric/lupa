import * as vscode from 'vscode';
import { z } from 'zod';
import { Log } from './loggingService';

export type FeedbackVerdict = 'accepted' | 'rejected' | 'dismissed';

export interface FeedbackEntry {
    id: string;
    category: string;
    severity: string;
    modelFamily: string;
    verdict: FeedbackVerdict;
    timestamp: string;
    reason?: string;
}

const FeedbackEntrySchema = z.object({
    id: z.string(),
    category: z.string(),
    severity: z.string(),
    modelFamily: z.string(),
    verdict: z.enum(['accepted', 'rejected', 'dismissed']),
    timestamp: z.string(),
    reason: z.string().optional(),
});

const FeedbackFileSchema = z.object({
    version: z.literal(1),
    entries: z.array(FeedbackEntrySchema),
});

export type FeedbackFile = z.infer<typeof FeedbackFileSchema>;

const MAX_ENTRIES = 1000;
const FEEDBACK_PATH = '.vscode/lupa-feedback.json';

export class FeedbackStore {
    private entries: FeedbackEntry[] = [];
    private loaded = false;

    constructor(private readonly workspaceFolder?: vscode.WorkspaceFolder) {}

    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;

        if (!this.workspaceFolder) {
            return;
        }

        try {
            const uri = vscode.Uri.joinPath(
                this.workspaceFolder.uri,
                FEEDBACK_PATH
            );
            const data = await vscode.workspace.fs.readFile(uri);
            const json = JSON.parse(Buffer.from(data).toString('utf-8'));
            const parsed = FeedbackFileSchema.safeParse(json);
            if (parsed.success) {
                this.entries = parsed.data.entries;
            } else {
                Log.warn('Invalid feedback file, starting fresh');
                this.entries = [];
            }
        } catch {
            this.entries = [];
        }
    }

    async record(
        entry: Omit<FeedbackEntry, 'id' | 'timestamp'>
    ): Promise<void> {
        const full: FeedbackEntry = {
            ...entry,
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
        };
        this.entries.push(full);

        if (this.entries.length > MAX_ENTRIES) {
            this.entries = this.entries.slice(
                this.entries.length - MAX_ENTRIES
            );
        }

        await this.persist();
    }

    getAll(): readonly FeedbackEntry[] {
        return this.entries;
    }

    getStats(
        category: string,
        modelFamily: string
    ): {
        accepted: number;
        rejected: number;
        dismissed: number;
        total: number;
    } {
        const matching = this.entries.filter(
            (e) => e.category === category && e.modelFamily === modelFamily
        );
        let accepted = 0;
        let rejected = 0;
        let dismissed = 0;
        for (const e of matching) {
            if (e.verdict === 'accepted') {
                accepted++;
            } else if (e.verdict === 'rejected') {
                rejected++;
            } else {
                dismissed++;
            }
        }
        return { accepted, rejected, dismissed, total: matching.length };
    }

    getRejectionRate(category: string, modelFamily: string): number {
        const stats = this.getStats(category, modelFamily);
        if (stats.total === 0) {
            return 0;
        }
        return stats.rejected / stats.total;
    }

    async clear(): Promise<void> {
        this.entries = [];

        if (!this.workspaceFolder) {
            return;
        }

        try {
            const uri = vscode.Uri.joinPath(
                this.workspaceFolder.uri,
                FEEDBACK_PATH
            );
            await vscode.workspace.fs.delete(uri);
        } catch {
            // File may not exist
        }
    }

    private async persist(): Promise<void> {
        if (!this.workspaceFolder) {
            return;
        }

        try {
            const uri = vscode.Uri.joinPath(
                this.workspaceFolder.uri,
                FEEDBACK_PATH
            );
            const file: FeedbackFile = { version: 1, entries: this.entries };
            const content = Buffer.from(JSON.stringify(file, null, 2), 'utf-8');
            await vscode.workspace.fs.writeFile(uri, content);
        } catch (error) {
            Log.error('Failed to persist feedback', error);
        }
    }
}

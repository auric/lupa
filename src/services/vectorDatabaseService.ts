import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { hash } from 'crypto';
import Database from 'better-sqlite3';
import SQL from 'sql-template-strings';
import { v4 as uuidv4 } from 'uuid';
import { similarity } from 'ml-distance';
import {
    FileRecord,
    ChunkRecord,
    EmbeddingRecord,
    SimilaritySearchOptions,
    SimilaritySearchResult,
    DatabaseConfig,
    StorageStats
} from '../models/types';

/**
 * VectorDatabaseService implements a SQLite-based storage system for code embeddings
 * with efficient similarity search capabilities.
 */
export class VectorDatabaseService implements vscode.Disposable {
    private db: Database.Database;
    private readonly config: Required<DatabaseConfig>;
    private static instance: VectorDatabaseService | null = null;

    // Default configuration values
    private static readonly DEFAULT_CONFIG: Required<Omit<DatabaseConfig, 'dbPath'>> = {
        maxConnections: 10,
        busyTimeout: 5000,
        migrationsPath: ''
    };

    /**
     * Get singleton instance of VectorDatabaseService
     */
    public static getInstance(context: vscode.ExtensionContext): VectorDatabaseService {
        if (!VectorDatabaseService.instance) {
            // Create database in workspace's .vscode directory if available, otherwise use extension's global storage
            const dbPath = VectorDatabaseService.getDatabasePath(context);
            VectorDatabaseService.instance = new VectorDatabaseService({ dbPath });
        }
        return VectorDatabaseService.instance;
    }

    /**
     * Get the database path based on current workspace
     */
    private static getDatabasePath(context: vscode.ExtensionContext): string {
        // If we have an active workspace, store the database in .vscode folder
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceFolder = vscode.workspace.workspaceFolders[0];
            const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');

            // Ensure .vscode directory exists
            if (!fs.existsSync(vscodeDir)) {
                fs.mkdirSync(vscodeDir, { recursive: true });
            }

            return path.join(vscodeDir, 'embeddings.db');
        }

        // Fallback to extension's global storage (for tests or when no workspace is open)
        return path.join(context.globalStorageUri.fsPath, 'embeddings.db');
    }

    /**
     * Create a new VectorDatabaseService
     * @param config Database configuration options
     */
    constructor(config: DatabaseConfig) {
        // Ensure directory exists
        const dbDir = path.dirname(config.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        // Complete the configuration with defaults
        this.config = {
            ...VectorDatabaseService.DEFAULT_CONFIG,
            ...config
        };

        // Initialize database
        console.log(`Initializing vector database at ${this.config.dbPath}`);
        this.db = new Database(this.config.dbPath, {
            fileMustExist: false,
            readonly: false,
            timeout: this.config.busyTimeout
        });

        // Optimize for performance
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = 10000');
        this.db.pragma('foreign_keys = ON');

        // Initialize schema
        this.initializeSchema();
    }

    /**
     * Initialize database schema if it doesn't exist
     */
    private initializeSchema(): void {
        // Files table - stores information about indexed files
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                hash TEXT NOT NULL,
                last_modified INTEGER NOT NULL,
                language TEXT,
                is_indexed BOOLEAN NOT NULL DEFAULT 0,
                size INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
            CREATE INDEX IF NOT EXISTS idx_files_indexed ON files(is_indexed);
        `);

        // Chunks table - stores code chunks from files
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                file_id TEXT NOT NULL,
                content TEXT NOT NULL,
                start_offset INTEGER NOT NULL,
                end_offset INTEGER NOT NULL,
                token_count INTEGER,
                FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
        `);

        // Embeddings table - stores vector embeddings of chunks
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS embeddings (
                id TEXT PRIMARY KEY,
                chunk_id TEXT NOT NULL,
                vector BLOB NOT NULL,
                model TEXT NOT NULL,
                dimension INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);
            CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
        `);

        // Metadata table - stores database metadata
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        console.log('Database schema initialized successfully');
    }

    /**
     * Store file metadata and mark for indexing
     * @param filePath Path to the file
     * @param content File content
     * @returns File record
     */
    async storeFile(filePath: string, content: string): Promise<FileRecord> {
        // Get file metadata
        const fileStats = fs.statSync(filePath);

        // Calculate file hash
        const hashValue = await hash('sha256', content, 'hex');

        // Check if file already exists in database
        const existingFile = this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as FileRecord | undefined;

        if (existingFile && existingFile.hash === hashValue) {
            // File exists and hasn't changed, just return it
            return existingFile;
        }

        // Create file ID if it doesn't exist
        const fileId = existingFile?.id || uuidv4();

        // Determine language from file extension
        const fileExt = path.extname(filePath).toLowerCase();
        const language = this.getLanguageFromExtension(fileExt);

        // Insert or update file
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO files
            (id, path, hash, last_modified, language, is_indexed, size)
            VALUES (?, ?, ?, ?, ?, 0, ?)
        `);

        stmt.run(
            fileId,
            filePath,
            hashValue,
            fileStats.mtimeMs,
            language,
            fileStats.size
        );

        // If file existed before, delete any associated chunks and embeddings
        if (existingFile) {
            this.deleteChunksForFile(fileId);
        }

        return {
            id: fileId,
            path: filePath,
            hash: hashValue,
            lastModified: fileStats.mtimeMs,
            language,
            isIndexed: false,
            size: fileStats.size
        };
    }

    /**
     * Store code chunks for a file
     * @param fileId ID of the file
     * @param chunks Array of code chunks
     * @param offsets Array of offsets for each chunk in the original file
     * @returns Array of chunk records
     */
    storeChunks(fileId: string, chunks: string[], offsets: number[]): ChunkRecord[] {
        if (chunks.length !== offsets.length) {
            throw new Error('Chunks and offsets arrays must have the same length');
        }

        // Begin transaction
        const transaction = this.db.transaction((chunksData: { fileId: string, chunks: string[], offsets: number[] }) => {
            const insertChunk = this.db.prepare(`
                INSERT INTO chunks (id, file_id, content, start_offset, end_offset)
                VALUES (?, ?, ?, ?, ?)
            `);

            const records: ChunkRecord[] = [];

            for (let i = 0; i < chunksData.chunks.length; i++) {
                const chunkId = uuidv4();
                const content = chunksData.chunks[i];
                const startOffset = chunksData.offsets[i];
                const endOffset = startOffset + content.length;

                insertChunk.run(chunkId, chunksData.fileId, content, startOffset, endOffset);

                records.push({
                    id: chunkId,
                    fileId: chunksData.fileId,
                    content,
                    startOffset,
                    endOffset
                });
            }

            return records;
        });

        // Execute the transaction
        return transaction({ fileId, chunks, offsets });
    }

    /**
     * Store embeddings for chunks
     * @param embeddings Array of embedding records
     */
    storeEmbeddings(embeddings: Array<Omit<EmbeddingRecord, 'id' | 'createdAt'>>): void {
        // Begin transaction
        const transaction = this.db.transaction((embeddingsData: Array<Omit<EmbeddingRecord, 'id' | 'createdAt'>>) => {
            const insertEmbedding = this.db.prepare(`
                INSERT INTO embeddings (id, chunk_id, vector, model, dimension, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);

            for (const embedding of embeddingsData) {
                const embeddingId = uuidv4();
                const now = Date.now();

                // Serialize the Float32Array to a Buffer
                const buffer = Buffer.from(embedding.vector.buffer);

                insertEmbedding.run(
                    embeddingId,
                    embedding.chunkId,
                    buffer,
                    embedding.model,
                    embedding.dimension,
                    now
                );
            }
        });

        // Execute the transaction
        transaction(embeddings);
    }

    /**
     * Mark a file as fully indexed
     * @param fileId ID of the file
     */
    markFileAsIndexed(fileId: string): void {
        this.db.prepare('UPDATE files SET is_indexed = 1 WHERE id = ?').run(fileId);
    }

    /**
     * Find similar code to the query using vector similarity search
     * @param queryVector The query vector to find similar code for
     * @param model The model name used for generating embeddings
     * @param options Search options
     * @returns Array of similar code chunks with their similarity scores
     */
    async findSimilarCode(
        queryVector: Float32Array,
        model: string,
        options: SimilaritySearchOptions = {}
    ): Promise<SimilaritySearchResult[]> {
        // Default options
        const limit = options.limit || 5;
        const minScore = options.minScore || 0.65;

        // Retrieve all embeddings for the specified model
        const embeddingsQuery = SQL`
            SELECT e.id, e.chunk_id, e.vector, e.dimension, c.content, c.file_id, c.start_offset, c.end_offset, f.path
            FROM embeddings e
            INNER JOIN chunks c ON e.chunk_id = c.id
            INNER JOIN files f ON c.file_id = f.id
            WHERE e.model = ${model}
        `;

        // Add file filter if provided
        if (options.fileFilter && options.fileFilter.length > 0) {
            embeddingsQuery.append(SQL` AND f.path IN (${options.fileFilter.join(',')})`);
        }

        // Add language filter if provided
        if (options.languageFilter && options.languageFilter.length > 0) {
            embeddingsQuery.append(SQL` AND f.language IN (${options.languageFilter.join(',')})`);
        }

        // Execute the query
        const embeddings = this.db.prepare(embeddingsQuery.text).all(...embeddingsQuery.values) as Array<{
            id: string;
            chunk_id: string;
            vector: Buffer;
            dimension: number;
            content: string;
            file_id: string;
            start_offset: number;
            end_offset: number;
            path: string;
        }>;

        // Calculate similarity scores
        const results: SimilaritySearchResult[] = [];

        for (const embedding of embeddings) {
            // Convert buffer back to Float32Array
            const vectorFloat32 = new Float32Array(
                embedding.vector.buffer.slice(
                    embedding.vector.byteOffset,
                    embedding.vector.byteOffset + embedding.vector.byteLength
                )
            );

            // Calculate cosine similarity
            const score = similarity.cosine(Array.from(queryVector), Array.from(vectorFloat32));

            // Add to results if above threshold
            if (score >= minScore) {
                results.push({
                    chunkId: embedding.chunk_id,
                    fileId: embedding.file_id,
                    filePath: embedding.path,
                    content: embedding.content,
                    startOffset: embedding.start_offset,
                    endOffset: embedding.end_offset,
                    score
                });
            }
        }

        // Sort by score (highest first) and limit results
        return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    /**
     * Get embeddings by chunk ID
     * @param chunkId ID of the chunk
     * @returns Embedding record
     */
    getEmbedding(chunkId: string): EmbeddingRecord | null {
        const embedding = this.db.prepare(`
            SELECT id, chunk_id, vector, model, dimension, created_at
            FROM embeddings
            WHERE chunk_id = ?
        `).get(chunkId) as {
            id: string;
            chunk_id: string;
            vector: Buffer;
            model: string;
            dimension: number;
            created_at: number;
        } | undefined;

        if (!embedding) return null;

        // Convert buffer back to Float32Array
        const vectorFloat32 = new Float32Array(
            embedding.vector.buffer.slice(
                embedding.vector.byteOffset,
                embedding.vector.byteOffset + embedding.vector.byteLength
            )
        );

        return {
            id: embedding.id,
            chunkId: embedding.chunk_id,
            vector: vectorFloat32,
            model: embedding.model,
            dimension: embedding.dimension,
            createdAt: embedding.created_at
        };
    }

    /**
     * Get all files that need to be indexed
     * @returns Array of file records
     */
    getFilesToIndex(): FileRecord[] {
        return this.db.prepare(`
            SELECT id, path, hash, last_modified as lastModified, language, is_indexed as isIndexed, size
            FROM files
            WHERE is_indexed = 0
        `).all() as FileRecord[];
    }

    /**
     * Get all files matching a glob pattern
     * @param globPattern Glob pattern to match file paths
     * @returns Array of file records
     */
    getFilesByGlob(globPattern: string): FileRecord[] {
        // SQLite doesn't have built-in glob support for full paths,
        // so we'll use a simple LIKE pattern as an approximation
        const likePattern = globPattern
            .replace(/\*/g, '%')
            .replace(/\?/g, '_');

        return this.db.prepare(`
            SELECT id, path, hash, last_modified as lastModified, language, is_indexed as isIndexed, size
            FROM files
            WHERE path LIKE ?
        `).all(likePattern) as FileRecord[];
    }

    /**
     * Get a file record by path
     * @param path File path
     * @returns File record or undefined if not found
     */
    getFileByPath(path: string): FileRecord | undefined {
        return this.db.prepare(`
            SELECT id, path, hash, last_modified as lastModified, language, is_indexed as isIndexed, size
            FROM files
            WHERE path = ?
        `).get(path) as FileRecord | undefined;
    }

    /**
     * Get all chunks for a file
     * @param fileId ID of the file
     * @returns Array of chunk records
     */
    getFileChunks(fileId: string): ChunkRecord[] {
        return this.db.prepare(`
            SELECT id, file_id as fileId, content, start_offset as startOffset, end_offset as endOffset, token_count as tokenCount
            FROM chunks
            WHERE file_id = ?
            ORDER BY start_offset ASC
        `).all(fileId) as ChunkRecord[];
    }

    /**
     * Delete chunks and embeddings for a file
     * @param fileId ID of the file
     */
    deleteChunksForFile(fileId: string): void {
        // Due to foreign key constraints, deleting chunks will also delete embeddings
        this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
    }

    /**
     * Delete a file and all associated chunks and embeddings
     * @param filePath Path of the file
     */
    deleteFile(filePath: string): void {
        // Due to foreign key constraints, deleting the file will cascade
        this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    }

    /**
     * Delete all embeddings generated with a specific model
     * @param model Model name
     */
    deleteEmbeddingsByModel(model: string): void {
        this.db.prepare('DELETE FROM embeddings WHERE model = ?').run(model);

        // Reset indexed status for all files
        this.db.prepare('UPDATE files SET is_indexed = 0').run();
    }

    /**
     * Get database storage statistics
     * @returns Storage statistics
     */
    getStorageStats(): StorageStats {
        // Get file count
        const fileCount = this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };

        // Get chunk count
        const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number };

        // Get embedding count
        const embeddingCount = this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };

        // Get last indexed timestamp
        const lastIndexed = this.db.prepare(`
            SELECT value FROM metadata WHERE key = 'last_indexed'
        `).get() as { value: string } | undefined;

        // Get embedding model
        const embeddingModel = this.db.prepare(`
            SELECT value FROM metadata WHERE key = 'embedding_model'
        `).get() as { value: string } | undefined;

        // Get database size
        const dbSizeBytes = fs.statSync(this.config.dbPath).size;

        return {
            fileCount: fileCount.count,
            chunkCount: chunkCount.count,
            embeddingCount: embeddingCount.count,
            databaseSizeBytes: dbSizeBytes,
            lastIndexed: lastIndexed ? parseInt(lastIndexed.value, 10) : null,
            embeddingModel: embeddingModel?.value || 'unknown'
        };
    }

    /**
     * Update last indexing timestamp
     */
    updateLastIndexingTimestamp(): void {
        const now = Date.now();
        this.db.prepare(`
            INSERT OR REPLACE INTO metadata (key, value)
            VALUES ('last_indexed', ?)
        `).run(now.toString());
    }

    /**
     * Set current embedding model
     * @param model Model name
     */
    setEmbeddingModel(model: string): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO metadata (key, value)
            VALUES ('embedding_model', ?)
        `).run(model);
    }

    /**
     * Optimize the database (vacuum and analyze)
     */
    optimizeDatabase(): void {
        console.log('Optimizing database...');
        this.db.pragma('optimize');
        this.db.exec('VACUUM;');
        this.db.exec('ANALYZE;');
        console.log('Database optimization complete');
    }

    /**
     * Get language from file extension
     * @param extension File extension with dot (e.g., '.js')
     */
    private getLanguageFromExtension(extension: string): string {
        const extensionMap: Record<string, string> = {
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.c': 'c',
            '.cpp': 'cpp',
            '.h': 'cpp',
            '.hpp': 'cpp',
            '.cs': 'csharp',
            '.go': 'go',
            '.rb': 'ruby',
            '.php': 'php',
            '.html': 'html',
            '.css': 'css',
            '.json': 'json',
            '.md': 'markdown',
            '.sql': 'sql',
            '.sh': 'shell',
            '.bat': 'batch',
            '.ps1': 'powershell',
            '.yaml': 'yaml',
            '.yml': 'yaml'
        };

        return extensionMap[extension] || 'unknown';
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.db) {
            // Optimize before closing
            try {
                this.optimizeDatabase();
            } catch (error) {
                console.error('Error optimizing database during disposal:', error);
            }

            try {
                this.db.close();
            } catch (error) {
                console.error('Error closing database:', error);
            }
        }

        // Clear singleton instance
        if (VectorDatabaseService.instance === this) {
            VectorDatabaseService.instance = null;
        }
    }
}
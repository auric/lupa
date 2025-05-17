import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import * as sqlite3 from '@vscode/sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { similarity } from 'ml-distance';
import {
    FileRecord,
    ChunkRecord,
    EmbeddingRecord,
    SimilaritySearchOptions,
    SimilaritySearchResult,
    DatabaseConfig,
    StorageStats,
    ChunkingMetadata
} from '../types/embeddingTypes';

/**
 * VectorDatabaseService implements a SQLite-based storage system for code embeddings
 * with efficient similarity search capabilities.
 */
export class VectorDatabaseService implements vscode.Disposable {
    private db: sqlite3.Database | null = null;
    private readonly config: Required<DatabaseConfig>;
    private static instance: VectorDatabaseService | null = null;
    private isInitialized = false;
    private initPromise: Promise<void> | null = null;
    private inTransaction = false; // Track if we're already in a transaction

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
        this.initPromise = this.initializeDatabase();
    }

    /**
     * Initialize the database connection and schema
     */
    private async initializeDatabase(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // Create the database connection
            this.db = new sqlite3.Database(this.config.dbPath, (err) => {
                if (err) {
                    reject(new Error(`Failed to open database: ${err.message}`));
                    return;
                }

                // Configure pragmas for performance
                this.runPragmas().then(() => {
                    // Initialize schema
                    this.initializeSchema()
                        .then(() => {
                            this.isInitialized = true;
                            resolve();
                        })
                        .catch(reject);
                }).catch(reject);
            });
        });
    }

    /**
     * Run database pragmas to optimize performance
     */
    private async runPragmas(): Promise<void> {
        const pragmas = [
            'PRAGMA journal_mode = WAL',
            'PRAGMA synchronous = NORMAL',
            'PRAGMA cache_size = 10000',
            'PRAGMA foreign_keys = ON',
            `PRAGMA busy_timeout = ${this.config.busyTimeout}`
        ];

        for (const pragma of pragmas) {
            await this.run(pragma, []);
        }
    }

    /**
     * Ensure database is initialized before proceeding with operations
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized && this.initPromise) {
            await this.initPromise;
        }

        if (!this.db) {
            throw new Error('Database connection is not available');
        }
    }

    /**
     * Initialize database schema if it doesn't exist
     */
    private async initializeSchema(): Promise<void> {
        // Files table - stores information about indexed files
        await this.run(`
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                hash TEXT NOT NULL,
                last_modified INTEGER NOT NULL,
                language TEXT,
                is_indexed BOOLEAN NOT NULL DEFAULT 0,
                size INTEGER NOT NULL DEFAULT 0
            )
        `, []);

        await this.run('CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)', []);
        await this.run('CREATE INDEX IF NOT EXISTS idx_files_indexed ON files(is_indexed)', []);

        // Chunks table - stores code chunks from files with structure metadata
        await this.run(`
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                file_id TEXT NOT NULL,
                content TEXT NOT NULL,
                start_offset INTEGER NOT NULL,
                end_offset INTEGER NOT NULL,
                token_count INTEGER,
                parent_structure_id TEXT,
                structure_order INTEGER,
                is_oversized BOOLEAN,
                structure_type TEXT,
                FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
            )
        `, []);

        await this.run('CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id)', []);
        await this.run('CREATE INDEX IF NOT EXISTS idx_chunks_parent_structure ON chunks(parent_structure_id)', []);

        // Embeddings table - stores vector embeddings of chunks
        await this.run(`
            CREATE TABLE IF NOT EXISTS embeddings (
                id TEXT PRIMARY KEY,
                chunk_id TEXT NOT NULL,
                vector BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
            )
        `, []);

        await this.run('CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)', []);

        // Metadata table - stores database metadata
        await this.run(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `, []);

        console.log('Database schema initialized successfully');
    }

    /**
     * Helper function to run SQL statements
     */
    private async run(sql: string, params: any[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database connection is not available'));
                return;
            }

            this.db.run(sql, params, function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Helper function to get all rows from a query
     */
    private async all<T>(sql: string, params: any[]): Promise<T[]> {
        return new Promise<T[]>((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database connection is not available'));
                return;
            }

            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows as T[]);
                }
            });
        });
    }

    /**
     * Helper function to get a single row from a query
     */
    private async get<T>(sql: string, params: any[]): Promise<T | undefined> {
        return new Promise<T | undefined>((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database connection is not available'));
                return;
            }

            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row as T | undefined);
                }
            });
        });
    }

    /**
     * Execute a transaction
     */
    private async transaction<T>(callback: () => Promise<T>): Promise<T> {
        await this.ensureInitialized();

        // Check if we're already in a transaction
        const startedTransaction = !this.inTransaction;

        if (startedTransaction) {
            this.inTransaction = true;
            await this.run('BEGIN TRANSACTION', []);
        }

        try {
            const result = await callback();

            // Only commit if we started the transaction
            if (startedTransaction) {
                await this.run('COMMIT', []);
                this.inTransaction = false;
            }

            return result;
        } catch (error) {
            // Only rollback if we started the transaction
            if (startedTransaction) {
                try {
                    await this.run('ROLLBACK', []);
                } catch (rollbackError) {
                    console.error('Error during rollback:', rollbackError);
                } finally {
                    this.inTransaction = false;
                }
            }
            throw error;
        }
    }

    /**
     * Store file metadata and mark for indexing
     * @param filePath Path to the file
     * @param content File content
     * @returns File record
     */
    async storeFile(filePath: string, content: string): Promise<FileRecord> {
        await this.ensureInitialized();

        // Get file metadata
        const fileStats = fs.statSync(filePath);

        // Calculate file hash
        const hashValue = createHash('sha256').update(content).digest('hex');

        // Check if file already exists in database
        const existingFile = await this.get<FileRecord>(
            'SELECT * FROM files WHERE path = ?',
            [filePath]
        );

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
        await this.run(`
            INSERT OR REPLACE INTO files
            (id, path, hash, last_modified, language, is_indexed, size)
            VALUES (?, ?, ?, ?, ?, 0, ?)
        `, [
            fileId,
            filePath,
            hashValue,
            fileStats.mtimeMs,
            language,
            fileStats.size
        ]);

        // If file existed before, delete any associated chunks and embeddings
        if (existingFile) {
            await this.deleteChunksForFile(fileId);
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
    async storeChunks(
        fileId: string,
        chunks: string[],
        offsets: number[],
        metadata: ChunkingMetadata
    ): Promise<ChunkRecord[]> {
        await this.ensureInitialized();

        if (chunks.length !== offsets.length ||
            chunks.length !== metadata.parentStructureIds.length ||
            chunks.length !== metadata.structureOrders.length ||
            chunks.length !== metadata.isOversizedFlags.length ||
            chunks.length !== metadata.structureTypes.length) {
            throw new Error('All arrays in chunks data must have the same length');
        }

        return this.transaction(async () => {
            const records: ChunkRecord[] = [];

            for (let i = 0; i < chunks.length; i++) {
                const chunkId = uuidv4();
                const content = chunks[i];
                const startOffset = offsets[i];
                const endOffset = startOffset + content.length;

                await this.run(`
                    INSERT INTO chunks (
                        id, file_id, content, start_offset, end_offset,
                        parent_structure_id, structure_order, is_oversized, structure_type
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    chunkId,
                    fileId,
                    content,
                    startOffset,
                    endOffset,
                    metadata.parentStructureIds[i],
                    metadata.structureOrders[i],
                    metadata.isOversizedFlags[i],
                    metadata.structureTypes[i]
                ]);

                records.push({
                    id: chunkId,
                    fileId,
                    content,
                    startOffset,
                    endOffset,
                    parentStructureId: metadata.parentStructureIds[i],
                    structureOrder: metadata.structureOrders[i],
                    isOversized: metadata.isOversizedFlags[i],
                    structureType: metadata.structureTypes[i]
                });
            }

            return records;
        });
    }

    /**
     * Store embeddings for chunks
     * @param embeddings Array of embedding records
     */
    async storeEmbeddings(embeddings: Array<Omit<EmbeddingRecord, 'id' | 'createdAt'>>): Promise<void> {
        await this.ensureInitialized();

        return this.transaction(async () => {
            for (const embedding of embeddings) {
                const embeddingId = uuidv4();
                const now = Date.now();

                // Serialize the Float32Array to a Buffer
                const buffer = Buffer.from(embedding.vector.buffer);

                await this.run(`
                    INSERT INTO embeddings (id, chunk_id, vector, created_at)
                    VALUES (?, ?, ?, ?)
                `, [
                    embeddingId,
                    embedding.chunkId,
                    buffer,
                    now
                ]);
            }
        });
    }

    /**
     * Mark a file as fully indexed
     * @param fileId ID of the file
     */
    async markFileAsIndexed(fileId: string): Promise<void> {
        await this.ensureInitialized();
        await this.run('UPDATE files SET is_indexed = 1 WHERE id = ?', [fileId]);
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
        options: SimilaritySearchOptions = {}
    ): Promise<SimilaritySearchResult[]> {
        await this.ensureInitialized();

        // Default options
        const limit = options.limit || 5;
        const minScore = options.minScore || 0.65;

        // Build the query
        let sql = `
            SELECT e.id, e.chunk_id, e.vector, c.content, c.file_id, c.start_offset, c.end_offset, f.path
            FROM embeddings e
            INNER JOIN chunks c ON e.chunk_id = c.id
            INNER JOIN files f ON c.file_id = f.id
        `;

        const params: any[] = [];

        // Add file filter if provided
        if (options.fileFilter && options.fileFilter.length > 0) {
            sql += ` WHERE f.path IN (${options.fileFilter.map(() => '?').join(',')})`;
            params.push(...options.fileFilter);
        }

        // Add language filter if provided
        if (options.languageFilter && options.languageFilter.length > 0) {
            sql += params.length > 0 ? ' AND' : ' WHERE';
            sql += ` f.language IN (${options.languageFilter.map(() => '?').join(',')})`;
            params.push(...options.languageFilter);
        }

        // Execute the query
        type EmbeddingRow = {
            id: string;
            chunk_id: string;
            vector: Buffer;
            content: string;
            file_id: string;
            start_offset: number;
            end_offset: number;
            path: string;
        };

        const embeddings = await this.all<EmbeddingRow>(sql, params);

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
    async getEmbedding(chunkId: string): Promise<EmbeddingRecord | null> {
        await this.ensureInitialized();

        type EmbeddingRow = {
            id: string;
            chunk_id: string;
            vector: Buffer;
            created_at: number;
        };

        const embedding = await this.get<EmbeddingRow>(
            `SELECT id, chunk_id, vector, created_at
             FROM embeddings
             WHERE chunk_id = ?`,
            [chunkId]
        );

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
            createdAt: embedding.created_at
        };
    }

    /**
     * Get all files that need to be indexed
     * @returns Array of file records
     */
    async getFilesToIndex(): Promise<FileRecord[]> {
        await this.ensureInitialized();

        return this.all<FileRecord>(
            `SELECT id, path, hash, last_modified as lastModified, language, is_indexed as isIndexed, size
             FROM files
             WHERE is_indexed = 0`,
            []
        );
    }

    /**
     * Get all files matching a glob pattern
     * @param globPattern Glob pattern to match file paths
     * @returns Array of file records
     */
    async getFilesByGlob(globPattern: string): Promise<FileRecord[]> {
        await this.ensureInitialized();

        // SQLite doesn't have built-in glob support for full paths,
        // so we'll use a simple LIKE pattern as an approximation
        const likePattern = globPattern
            .replace(/\*/g, '%')
            .replace(/\?/g, '_');

        return this.all<FileRecord>(
            `SELECT id, path, hash, last_modified as lastModified, language, is_indexed as isIndexed, size
             FROM files
             WHERE path LIKE ?`,
            [likePattern]
        );
    }

    /**
     * Get a file record by path
     * @param path File path
     * @returns File record or undefined if not found
     */
    async getFileByPath(path: string): Promise<FileRecord | undefined> {
        await this.ensureInitialized();

        return this.get<FileRecord>(
            `SELECT id, path, hash, last_modified as lastModified, language, is_indexed as isIndexed, size
             FROM files
             WHERE path = ?`,
            [path]
        );
    }

    /**
     * Get all chunks for a file
     * @param fileId ID of the file
     * @returns Array of chunk records
     */
    async getFileChunks(fileId: string): Promise<ChunkRecord[]> {
        await this.ensureInitialized();

        return this.all<ChunkRecord>(
            `SELECT id, file_id as fileId, content, start_offset as startOffset, end_offset as endOffset, token_count as tokenCount
             FROM chunks
             WHERE file_id = ?
             ORDER BY start_offset ASC`,
            [fileId]
        );
    }

    /**
     * Get chunks that are adjacent to a given chunk
     * @param chunkId ID of the chunk to find neighbors for
     * @param window Number of adjacent chunks to fetch (before and after)
     * @returns Array of adjacent chunk records
     */
    async getAdjacentChunks(chunkId: string, window: number = 2): Promise<ChunkRecord[]> {
        await this.ensureInitialized();

        // First, get the current chunk to find its position and file
        const currentChunk = await this.get<{
            id: string,
            file_id: string,
            start_offset: number,
            end_offset: number
        }>(
            `SELECT id, file_id, start_offset, end_offset
             FROM chunks
             WHERE id = ?`,
            [chunkId]
        );

        if (!currentChunk) {
            return [];
        }

        // Get adjacent chunks from the same file
        const adjacentChunks = await this.all<ChunkRecord>(
            `SELECT id, file_id as fileId, content, start_offset as startOffset, end_offset as endOffset, token_count as tokenCount
             FROM chunks
             WHERE file_id = ?
               AND id != ?
               AND (
                 -- Chunks that come before the target chunk
                 (end_offset <= ? ORDER BY start_offset DESC LIMIT ?)
                 OR
                 -- Chunks that come after the target chunk
                 (start_offset >= ? ORDER BY start_offset ASC LIMIT ?)
               )
             ORDER BY start_offset ASC`,
            [
                currentChunk.file_id,
                chunkId,
                currentChunk.start_offset, window,
                currentChunk.end_offset, window
            ]
        );

        return adjacentChunks;
    }

    /**
     * Get complete function or class containing a chunk
     * This attempts to find a chunk that contains a complete code structure
     * @param chunkId ID of the chunk that might be part of a larger structure
     * @returns A complete structure chunk if found, or null if not
     */
    async getCompleteStructureForChunk(chunkId: string): Promise<ChunkRecord[] | null> {
        await this.ensureInitialized();

        // First, get the current chunk to check its structure metadata
        const currentChunk = await this.get<ChunkRecord>(
            `SELECT *,
                file_id as fileId,
                start_offset as startOffset,
                end_offset as endOffset,
                token_count as tokenCount,
                parent_structure_id as parentStructureId,
                structure_order as structureOrder,
                is_oversized as isOversized,
                structure_type as structureType
            FROM chunks
            WHERE id = ?`,
            [chunkId]
        );

        if (!currentChunk) {
            return null;
        }

        // If the chunk has a parent structure ID, get all chunks in that structure
        if (currentChunk.parentStructureId) {
            const structureChunks = await this.all<ChunkRecord>(
                `SELECT *,
                    file_id as fileId,
                    start_offset as startOffset,
                    end_offset as endOffset,
                    token_count as tokenCount,
                    parent_structure_id as parentStructureId,
                    structure_order as structureOrder,
                    is_oversized as isOversized,
                    structure_type as structureType
                FROM chunks
                WHERE parent_structure_id = ?
                ORDER BY structure_order ASC`,
                [currentChunk.parentStructureId]
            );

            return structureChunks.length > 0 ? structureChunks : null;
        }

        // If the chunk itself is a complete structure
        if (currentChunk.structureType && !currentChunk.isOversized) {
            return [currentChunk];
        }

        // Try to find a containing chunk that represents a complete structure
        const containerChunks = await this.all<ChunkRecord>(
            `SELECT *,
                file_id as fileId,
                start_offset as startOffset,
                end_offset as endOffset,
                token_count as tokenCount,
                parent_structure_id as parentStructureId,
                structure_order as structureOrder,
                is_oversized as isOversized,
                structure_type as structureType
            FROM chunks
            WHERE file_id = ?
                AND id != ?
                AND start_offset <= ?
                AND end_offset >= ?
                AND structure_type IS NOT NULL
                AND is_oversized = 0
            ORDER BY (end_offset - start_offset) ASC
            LIMIT 1`,
            [
                currentChunk.fileId,
                chunkId,
                currentChunk.startOffset,
                currentChunk.endOffset
            ]
        );

        return containerChunks.length > 0 ? [containerChunks[0]] : null;
    }

    /**
     * Delete chunks and embeddings for a file
     * @param fileId ID of the file
     */
    async deleteChunksForFile(fileId: string): Promise<void> {
        await this.ensureInitialized();

        // Due to foreign key constraints, deleting chunks will also delete embeddings
        await this.run('DELETE FROM chunks WHERE file_id = ?', [fileId]);
    }

    /**
     * Delete a file and all associated chunks and embeddings
     * @param filePath Path of the file
     */
    async deleteFile(filePath: string): Promise<void> {
        await this.ensureInitialized();

        // Due to foreign key constraints, deleting the file will cascade
        await this.run('DELETE FROM files WHERE path = ?', [filePath]);
    }

    /**
     * Delete all embeddings and chunks from the database.
     * This is typically used when the embedding model changes, requiring a full rebuild.
     */
    async deleteAllEmbeddingsAndChunks(): Promise<void> {
        await this.ensureInitialized();

        await this.transaction(async () => {
            await this.run('DELETE FROM embeddings', []);
            await this.run('DELETE FROM chunks', []);
            await this.run('DELETE FROM files', []);
            await this.run('DELETE FROM metadata', []);
            // Files will be re-evaluated and their is_indexed status updated during re-indexing.
        });
        console.log('All embeddings and chunks have been deleted.');
    }

    /**
     * Get database storage statistics
     * @returns Storage statistics
     */
    async getStorageStats(): Promise<StorageStats> {
        await this.ensureInitialized();

        // Get file count
        const fileCount = await this.get<{ count: number }>(
            'SELECT COUNT(*) as count FROM files',
            []
        );

        // Get chunk count
        const chunkCount = await this.get<{ count: number }>(
            'SELECT COUNT(*) as count FROM chunks',
            []
        );

        // Get embedding count
        const embeddingCount = await this.get<{ count: number }>(
            'SELECT COUNT(*) as count FROM embeddings',
            []
        );

        // Get last indexed timestamp
        const lastIndexed = await this.get<{ value: string }>(
            'SELECT value FROM metadata WHERE key = ?',
            ['last_indexed']
        );

        // Get embedding model
        const embeddingModel = await this.get<{ value: string }>(
            'SELECT value FROM metadata WHERE key = ?',
            ['embedding_model']
        );

        // Get database size
        const dbSizeBytes = fs.statSync(this.config.dbPath).size;

        return {
            fileCount: fileCount?.count || 0,
            chunkCount: chunkCount?.count || 0,
            embeddingCount: embeddingCount?.count || 0,
            databaseSizeBytes: dbSizeBytes,
            lastIndexed: lastIndexed ? parseInt(lastIndexed.value, 10) : null,
            embeddingModel: embeddingModel?.value || 'unknown'
        };
    }

    /**
     * Update last indexing timestamp
     */
    async updateLastIndexingTimestamp(): Promise<void> {
        await this.ensureInitialized();

        const now = Date.now();
        await this.run(
            'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
            ['last_indexed', now.toString()]
        );
    }

    /**
     * Set current embedding model
     * @param model Model name
     */
    async setEmbeddingModel(model: string): Promise<void> {
        await this.ensureInitialized();

        await this.run(
            'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
            ['embedding_model', model]
        );
    }

    /**
     * Optimize the database (vacuum and analyze)
     */
    async optimizeDatabase(): Promise<void> {
        await this.ensureInitialized();

        console.log('Optimizing database...');

        try {
            await this.run('PRAGMA optimize', []);
            await this.run('VACUUM', []);
            await this.run('ANALYZE', []);
            console.log('Database optimization complete');
        } catch (error) {
            console.error('Error during database optimization:', error);
            throw error;
        }
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
            '.pyw': 'python',
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
            '.yml': 'yaml',
            '.rs': 'rust'
        };

        return extensionMap[extension] || 'unknown';
    }

    /**
     * Dispose resources
     */
    async dispose(): Promise<void> {
        if (this.db) {
            // Optimize before closing
            try {
                await this.optimizeDatabase();
            } catch (error) {
                console.error('Error optimizing database during disposal:', error);
            }

            // Close the database connection
            return new Promise<void>((resolve) => {
                if (!this.db) {
                    resolve();
                    return;
                }

                this.db.close((err) => {
                    if (err) {
                        console.error('Error closing database:', err);
                    }
                    this.db = null;
                    resolve();
                });
            });
        }

        // Clear singleton instance
        if (VectorDatabaseService.instance === this) {
            VectorDatabaseService.instance = null;
        }
    }
}

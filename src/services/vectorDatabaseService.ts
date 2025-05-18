import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import * as sqlite3 from '@vscode/sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { similarity } from 'ml-distance';
import { HierarchicalNSW } from 'hnswlib-node';
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

// INFO: Dynamic resizing of the HNSW index is implemented in storeEmbeddings using HierarchicalNSW.prototype.resizeIndex
// when the number of elements exceeds the current capacity.
const ANN_MAX_ELEMENTS_CONFIG = 1000000; // Initial max elements for HNSW index

/**
 * VectorDatabaseService implements a SQLite-based storage system for code embeddings
 * with efficient similarity search capabilities using HNSWlib for ANN search.
 */
export class VectorDatabaseService implements vscode.Disposable {
    private db: sqlite3.Database | null = null;
    private readonly config: Required<DatabaseConfig>;
    private static instance: VectorDatabaseService | null = null;
    private isInitialized = false;
    private initPromise: Promise<void> | null = null;
    private inTransaction = false; // Track if we're already in a transaction

    // ANN Index related members
    private annIndex: HierarchicalNSW | null = null;
    private currentModelDimension: number | null = null;
    private annIndexPath: string = '';

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
        this.annIndexPath = path.join(path.dirname(this.config.dbPath), 'embeddings.ann.idx');

        // Initialize database
        console.log(`Initializing vector database at ${this.config.dbPath}`);
        console.log(`ANN index path will be ${this.annIndexPath}`);
        this.initPromise = this.initializeDatabase();
    }

    /**
     * Initialize the database connection and schema
     */
    private async initializeDatabase(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // Create the database connection
            this.db = new sqlite3.Database(this.config.dbPath, (err) => {
                // Arrow function captures `this`
                if (err) {
                    this.db = null; // Ensure db is null on error
                    reject(new Error(`Failed to open database: ${err.message}`));
                    return;
                }

                // Configure pragmas for performance
                this.runPragmas().then(() => {
                    this.initializeSchema().then(() => {
                        this.isInitialized = true;
                        resolve();
                    })
                        .catch(schemaErr => { this.db = null; reject(schemaErr); });
                }).catch(pragmaErr => { this.db = null; reject(pragmaErr); });
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

        // Embeddings table - stores metadata for vector embeddings (vectors stored in ANN index)
        await this.run(`
            CREATE TABLE IF NOT EXISTS embeddings (
                id TEXT PRIMARY KEY,
                chunk_id TEXT NOT NULL UNIQUE,
                label INTEGER UNIQUE NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
            )
        `, []);

        await this.run('CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id)', []);
        await this.run('CREATE INDEX IF NOT EXISTS idx_embeddings_label ON embeddings(label)', []);

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

            // The callback for this.db.run is a standard function,
            // its `this` is bound by sqlite3 to RunResult.
            // We don't need to access VectorDatabaseService's `this` inside it.
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
     * @param embeddings Array of embedding records (vector is part of the input but not stored in SQLite)
     */
    async storeEmbeddings(embeddings: Array<{ chunkId: string; vector: Float32Array; }>): Promise<void> {
        await this.ensureInitialized();

        if (!this.annIndex || this.currentModelDimension === null) {
            throw new Error('ANN index or model dimension is not initialized. Cannot store embeddings.');
        }

        let currentAnnMaxElements = this.annIndex.getMaxElements();
        let nextLabel = this.annIndex.getCurrentCount(); // Labels are 0-indexed

        await this.transaction(async () => {
            const stmt = await this.db!.prepare('INSERT INTO embeddings (id, chunk_id, label, created_at) VALUES (?, ?, ?, ?)');
            try {
                for (const embedding of embeddings) {
                    if (nextLabel >= currentAnnMaxElements) {
                        // Handle ANN index full scenario
                        const newMaxElements = Math.max(currentAnnMaxElements * 2, nextLabel + 1);
                        console.warn(
                            `ANN index is full (current: ${this.annIndex!.getCurrentCount()}, max: ${currentAnnMaxElements}). ` +
                            `Attempting to resize to ${newMaxElements} using resizeIndex.`
                        );
                        // NOTE: `resizeIndex` is used to expand the capacity of the HNSW index.
                        // This operation can be resource-intensive. If `resizeIndex` fails or
                        // has limitations for extreme sizes, a more complex strategy involving
                        // re-initialization and re-adding points might be needed as a fallback,
                        // but `resizeIndex` is the primary mechanism.
                        try {
                            this.annIndex!.resizeIndex(newMaxElements);
                            currentAnnMaxElements = newMaxElements;
                            console.log(`ANN index resized to ${newMaxElements}.`);
                        } catch (resizeError) {
                            console.error(`Failed to resize ANN index. Max elements: ${currentAnnMaxElements}. Current count: ${this.annIndex!.getCurrentCount()}. Error: ${resizeError}`);
                            throw new Error(`ANN index is full and resize failed. Max elements: ${currentAnnMaxElements}. Please increase ANN_MAX_ELEMENTS_CONFIG and rebuild.`);
                        }
                    }

                    const embeddingId = uuidv4();
                    const now = Date.now();
                    const numericalLabel = nextLabel;

                    // Convert Float32Array to number[] for HNSWlib
                    const vectorAsArray = Array.from(embedding.vector);
                    this.annIndex!.addPoint(vectorAsArray, numericalLabel);

                    await new Promise<void>((resolve, reject) => {
                        stmt.run(embeddingId, embedding.chunkId, numericalLabel, now, (err: Error | null) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    nextLabel++;
                }
            } finally {
                await new Promise<void>((resolve, reject) => {
                    stmt.finalize((err: Error | null) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }
        });

        // Save ANN index after transaction
        this.saveAnnIndex();
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

        const limit = options.limit || 5;
        const minScore = options.minScore || 0.65;
        // Fetch more neighbors initially to allow for filtering and still meet the limit.
        // HNSWlib searchKnn is efficient, so over-fetching slightly is generally fine.
        const numNeighborsToFetch = Math.max(limit * 3, 10);


        if (!this.annIndex) {
            console.warn('ANN index is not initialized. Cannot perform similarity search.');
            return [];
        }
        if (this.annIndex.getCurrentCount() === 0) {
            console.log('ANN index is empty. No results to return.');
            return [];
        }

        const queryVectorAsArray = Array.from(queryVector);
        let searchResult;
        try {
            searchResult = this.annIndex.searchKnn(queryVectorAsArray, numNeighborsToFetch);
        } catch (error) {
            console.error('Error during ANN searchKnn:', error);
            return [];
        }

        const { neighbors, distances } = searchResult;

        if (!neighbors || neighbors.length === 0) {
            return [];
        }

        const potentialResults: Array<{ label: number; score: number }> = [];
        for (let i = 0; i < neighbors.length; i++) {
            const label = neighbors[i];
            const distance = distances[i];
            // For cosine space, similarity = 1 - distance.
            // HNSWlib returns distance, so we convert it.
            const score = 1 - distance;

            if (score >= minScore) {
                potentialResults.push({ label, score });
            }
        }

        if (potentialResults.length === 0) {
            return [];
        }

        // Sort by score descending before fetching metadata to prioritize higher scores if DB query is slow
        potentialResults.sort((a, b) => b.score - a.score);

        const labelsToFetch = potentialResults.map(r => r.label);
        const scoresMap = new Map(potentialResults.map(r => [r.label, r.score]));

        // Fetch metadata for these labels from SQLite
        const placeholders = labelsToFetch.map(() => '?').join(',');
        const sql = `
            SELECT e.chunk_id, c.content, c.file_id, c.start_offset, c.end_offset, f.path, f.language, e.label
            FROM embeddings e
            INNER JOIN chunks c ON e.chunk_id = c.id
            INNER JOIN files f ON c.file_id = f.id
            WHERE e.label IN (${placeholders})
        `;

        type EmbeddingMetadataRow = {
            chunk_id: string;
            content: string;
            file_id: string;
            start_offset: number;
            end_offset: number;
            path: string;
            language: string | null;
            label: number;
        };

        let metadataRows: EmbeddingMetadataRow[];
        try {
            metadataRows = await this.all<EmbeddingMetadataRow>(sql, labelsToFetch);
        } catch (error) {
            console.error('Error fetching metadata for ANN results:', error);
            return [];
        }

        const finalResults: SimilaritySearchResult[] = [];
        for (const row of metadataRows) {
            const score = scoresMap.get(row.label);
            if (score === undefined) continue; // Should not happen if SQL is correct

            // Apply file and language filters if provided
            if (options.fileFilter && options.fileFilter.length > 0 && !options.fileFilter.includes(row.path)) {
                continue;
            }
            if (options.languageFilter && options.languageFilter.length > 0 && row.language && !options.languageFilter.includes(row.language)) {
                continue;
            }

            finalResults.push({
                chunkId: row.chunk_id,
                fileId: row.file_id,
                filePath: row.path,
                content: row.content,
                startOffset: row.start_offset,
                endOffset: row.end_offset,
                score: score,
            });
        }

        // The results from DB might not be in the same order as `potentialResults`
        // So, re-sort based on the scores we have and then slice.
        return finalResults.sort((a, b) => b.score - a.score).slice(0, limit);
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
            // vector: Buffer; // Vector is no longer stored in SQLite
            label: number;
            created_at: number;
        };

        const embeddingMeta = await this.get<EmbeddingRow>(
            `SELECT id, chunk_id, label, created_at
             FROM embeddings
             WHERE chunk_id = ?`,
            [chunkId]
        );

        if (!embeddingMeta) return null;

        if (!this.annIndex) {
            console.warn('ANN index not available, cannot retrieve vector for embedding.');
            return { // Return metadata without vector
                id: embeddingMeta.id,
                chunkId: embeddingMeta.chunk_id,
                label: embeddingMeta.label,
                vector: new Float32Array(0), // Placeholder for vector
                createdAt: embeddingMeta.created_at
            };
        }

        try {
            const vector = this.annIndex.getPoint(embeddingMeta.label);
            if (!vector) {
                console.warn(`Vector not found in ANN index for label ${embeddingMeta.label}, chunkId ${chunkId}`);
                return {
                    id: embeddingMeta.id,
                    chunkId: embeddingMeta.chunk_id,
                    label: embeddingMeta.label,
                    vector: new Float32Array(0), // Placeholder
                    createdAt: embeddingMeta.created_at
                };
            }
            return {
                id: embeddingMeta.id,
                chunkId: embeddingMeta.chunk_id,
                label: embeddingMeta.label,
                vector: vector instanceof Float32Array ? vector : new Float32Array(vector), // Ensure it's Float32Array
                createdAt: embeddingMeta.created_at
            };
        } catch (error) {
            console.error(`Error retrieving vector from ANN index for label ${embeddingMeta.label}, chunkId ${chunkId}:`, error);
            return { // Return metadata without vector on error
                id: embeddingMeta.id,
                chunkId: embeddingMeta.chunk_id,
                label: embeddingMeta.label,
                vector: new Float32Array(0), // Placeholder
                createdAt: embeddingMeta.created_at
            };
        }
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

        // Get labels of embeddings associated with chunks of this file
        const embeddingsToDelete = await this.all<{ label: number }>(
            `SELECT e.label FROM embeddings e
             INNER JOIN chunks c ON e.chunk_id = c.id
             WHERE c.file_id = ?`,
            [fileId]
        );

        if (this.annIndex && embeddingsToDelete.length > 0) {
            let markedCount = 0;
            for (const emb of embeddingsToDelete) {
                try {
                    // Check if label exists before marking for deletion
                    // Note: HNSWlib doesn't have a direct `exists(label)` check.
                    // `markDelete` might not error if label doesn't exist, but it's good practice.
                    // We assume if it's in DB, it should be in ANN.
                    this.annIndex.markDelete(emb.label);
                    markedCount++;
                } catch (error) {
                    // Log error if marking for deletion fails for a specific label
                    console.warn(`Failed to mark label ${emb.label} for deletion in ANN index:`, error);
                }
            }
            if (markedCount > 0) {
                console.log(`Marked ${markedCount} embeddings for deletion in ANN index for fileId ${fileId}.`);
                this.saveAnnIndex(); // Persist changes to ANN index
            }
        }

        // Due to foreign key constraints (ON DELETE CASCADE for embeddings referencing chunks),
        // deleting chunks will also delete their corresponding entries in the embeddings table.
        await this.run('DELETE FROM chunks WHERE file_id = ?', [fileId]);
        console.log(`Deleted chunks and associated SQLite embedding metadata for fileId ${fileId}.`);
    }

    /**
     * Delete a file and all associated chunks and embeddings (both in SQLite and ANN index)
     * @param filePath Path of the file
     */
    async deleteFile(filePath: string): Promise<void> {
        await this.ensureInitialized();

        const fileRecord = await this.getFileByPath(filePath);
        if (!fileRecord) {
            console.log(`File ${filePath} not found in database. Nothing to delete.`);
            return;
        }

        // First, handle ANN index deletions by getting all relevant labels
        const embeddingsToDelete = await this.all<{ label: number }>(
            `SELECT e.label FROM embeddings e
             INNER JOIN chunks c ON e.chunk_id = c.id
             WHERE c.file_id = ?`,
            [fileRecord.id]
        );

        if (this.annIndex && embeddingsToDelete.length > 0) {
            let markedCount = 0;
            for (const emb of embeddingsToDelete) {
                try {
                    this.annIndex.markDelete(emb.label);
                    markedCount++;
                } catch (error) {
                    console.warn(`Failed to mark label ${emb.label} for deletion in ANN index for file ${filePath}:`, error);
                }
            }
            if (markedCount > 0) {
                console.log(`Marked ${markedCount} embeddings for deletion in ANN index for file ${filePath}.`);
                this.saveAnnIndex(); // Persist changes to ANN index
            }
        }

        // Due to foreign key constraints (ON DELETE CASCADE for chunks referencing files,
        // and embeddings referencing chunks), deleting the file from the 'files' table
        // will cascade and delete associated chunks and SQLite embedding metadata.
        await this.run('DELETE FROM files WHERE id = ?', [fileRecord.id]);
        console.log(`Deleted file ${filePath} and all associated SQLite data (chunks, embeddings).`);
    }

    /**
     * Delete all embeddings, chunks, files, metadata, and clear the ANN index.
     * This is typically used when the embedding model changes or for a full rebuild.
     */
    async deleteAllEmbeddingsAndChunks(): Promise<void> {
        await this.ensureInitialized();

        await this.transaction(async () => {
            await this.run('DELETE FROM embeddings', []);
            await this.run('DELETE FROM chunks', []);
            await this.run('DELETE FROM files', []);
            await this.run('DELETE FROM metadata', []);
        });

        // Clear the ANN index
        if (this.currentModelDimension && this.annIndex) {
            console.log('Re-initializing existing ANN index to an empty state.');
            this.annIndex.initIndex(ANN_MAX_ELEMENTS_CONFIG); // Clears the current instance
            this.saveAnnIndex(); // Save the now empty index
        } else {
            console.log(`No current ANN dimension or index instance. Attempting to delete index file: ${this.annIndexPath}`);
            if (fs.existsSync(this.annIndexPath)) {
                try {
                    fs.unlinkSync(this.annIndexPath);
                    console.log(`Deleted ANN index file: ${this.annIndexPath}`);
                } catch (e) {
                    console.error(`Failed to delete ANN index file ${this.annIndexPath}:`, e);
                }
            }
            this.annIndex = null; // Ensure it's null
        }
        console.log('All embeddings, chunks, files, metadata, and ANN index data have been cleared/reset.');
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
     * Sets the dimension for the current embedding model and initializes/re-initializes the ANN index.
     * This should be called by the coordinator when the model is selected or changed.
     * @param dimension The dimension of the embedding vectors for the current model.
     */
    public setCurrentModelDimension(dimension: number): void {
        // ensureInitialized is not strictly needed here if annIndexPath is set in constructor
        // and this method is called after VectorDatabaseService constructor has completed.

        if (this.currentModelDimension === dimension && this.annIndex) {
            // console.log(`ANN index dimension ${dimension} already set and index exists.`);
            return; // No change needed
        }

        console.log(`Setting ANN index dimension to ${dimension}. Previous: ${this.currentModelDimension}`);
        this.currentModelDimension = dimension;

        if (!this.currentModelDimension) {
            console.warn('Cannot initialize ANN index without a model dimension.');
            this.annIndex = null;
            // Attempt to delete existing index file if dimension becomes unknown
            if (fs.existsSync(this.annIndexPath)) {
                try {
                    fs.unlinkSync(this.annIndexPath);
                    console.log(`Deleted ANN index file ${this.annIndexPath} as model dimension is now unknown.`);
                } catch (e) {
                    console.error(`Failed to delete ANN index file ${this.annIndexPath}:`, e);
                }
            }
            return;
        }

        // Initialize or re-initialize the ANN index
        console.log(`Initializing HNSW index with space 'cosine' and dimension ${this.currentModelDimension}`);
        this.annIndex = new HierarchicalNSW('cosine', this.currentModelDimension);

        if (this.loadAnnIndex()) { // loadAnnIndex is synchronous
            console.log(`ANN index loaded successfully from ${this.annIndexPath}. Elements: ${this.annIndex.getCurrentCount()}`);
        } else {
            console.log(`Initializing new ANN index at ${this.annIndexPath}. Max elements: ${ANN_MAX_ELEMENTS_CONFIG}`);
            this.annIndex.initIndex(ANN_MAX_ELEMENTS_CONFIG);
            // No need to save here, will be saved on dispose or when data is added.
        }
    }

    /**
     * Loads the ANN index from disk.
     * @returns True if loading was successful, false otherwise.
     */
    private loadAnnIndex(): boolean {
        if (!this.annIndex || !this.annIndexPath || !this.currentModelDimension) {
            console.warn('ANN index, path, or dimension not set. Cannot load index.');
            return false;
        }
        try {
            if (fs.existsSync(this.annIndexPath)) {
                console.log(`Attempting to load ANN index from ${this.annIndexPath}`);
                this.annIndex.readIndexSync(this.annIndexPath); // This might throw if dimensions mismatch
                // It's good practice to check if the loaded index actually has items if it's not empty
                // For example, if an empty index was saved, getCurrentCount() would be 0.
                // If readIndexSync doesn't throw on dimension mismatch, we might need another check here,
                // but typically it should handle it.
                return true;
            }
            console.log(`ANN index file not found at ${this.annIndexPath}. A new index will be used.`);
            return false;
        } catch (error) {
            console.warn(`Failed to load ANN index from ${this.annIndexPath}:`, error);
            // If loading fails, ensure we have a fresh, empty index for the current dimension
            console.log(`Re-initializing a fresh ANN index due to load failure for dimension ${this.currentModelDimension}.`);
            this.annIndex = new HierarchicalNSW('cosine', this.currentModelDimension);
            // this.annIndex.initIndex(ANN_MAX_ELEMENTS_CONFIG); // Caller will init if loadAnnIndex returns false
            return false;
        }
    }

    /**
     * Saves the ANN index to disk.
     */
    private saveAnnIndex(): void {
        if (!this.annIndex || !this.annIndexPath) {
            console.warn('ANN index or path not set. Cannot save index.');
            return;
        }
        try {
            console.log(`Saving ANN index to ${this.annIndexPath}. Elements: ${this.annIndex.getCurrentCount()}`);
            const dir = path.dirname(this.annIndexPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.annIndex.writeIndexSync(this.annIndexPath);
            console.log(`ANN index saved successfully to ${this.annIndexPath}.`);
        } catch (error) {
            console.error(`Failed to save ANN index to ${this.annIndexPath}:`, error);
        }
    }

    /**
     * Provides access to the HNSWLib index instance.
     * @returns The HierarchicalNSW instance or null if not initialized.
     */
    public getAnnIndex(): HierarchicalNSW | null {
        return this.annIndex;
    }

    /**
     * Dispose resources: save ANN index, optimize and close SQLite DB.
     */
    async dispose(): Promise<void> {
        if (this.annIndex) {
            this.saveAnnIndex();
        }

        if (this.db) {
            try {
                await this.optimizeDatabase();
            } catch (error) {
                console.error('Error optimizing database during disposal:', error);
            }

            return new Promise<void>((resolve) => {
                if (!this.db) { // Check again in case it was nulled elsewhere
                    resolve();
                    return;
                }
                this.db.close((err) => {
                    if (err) {
                        console.error('Error closing SQLite database:', err);
                    }
                    this.db = null;
                    console.log('SQLite database closed.');
                    resolve();
                });
            });
        }

        if (VectorDatabaseService.instance === this) {
            VectorDatabaseService.instance = null;
        }
    }
}

/**
 * Hash utility functions for content deduplication and ID generation
 */

/**
 * Generate a simple, fast hash for string content.
 * 
 * This is a basic hash function suitable for deduplication and ID generation
 * within the application. It's not cryptographically secure and should not
 * be used for security purposes.
 * 
 * @param content The string content to hash
 * @returns A 32-bit signed integer hash value
 * 
 * @example
 * ```typescript
 * const hash1 = quickHash("hello world");
 * const hash2 = quickHash("hello world");
 * console.log(hash1 === hash2); // true
 * 
 * const hash3 = quickHash("different content");
 * console.log(hash1 === hash3); // false (very likely)
 * ```
 */
export function quickHash(content: string): number {
    let hash = 0;
    if (content.length === 0) {return hash;}

    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }

    return hash;
}
import * as os from 'os';
import { Log } from './loggingService';

/**
 * Resource detection result
 */
export interface SystemResources {
    /** Total system memory in GB */
    totalMemoryGB: number;
    /** Free system memory in GB */
    freeMemoryGB: number;
    /** Number of CPU cores */
    cpuCount: number;
    /** Memory available for embedding models (free minus reserve) in GB */
    availableMemoryGB: number;
}

/**
 * Options for resource detection
 */
export interface ResourceDetectionOptions {
    /** Memory to reserve for other processes in GB */
    memoryReserveGB?: number;
}

/**
 * Service for detecting system resources to optimize embedding model selection
 * and worker allocation
 */
export class ResourceDetectionService {
    private readonly defaultOptions: Required<ResourceDetectionOptions> = {
        memoryReserveGB: 4 // Default to 4GB reserve for other processes
    };

    private options: Required<ResourceDetectionOptions>;

    /**
     * Creates a new ResourceDetectionService
     * @param options Configuration options
     */
    constructor(options?: ResourceDetectionOptions) {
        this.options = { ...this.defaultOptions, ...options };
    }

    /**
     * Get information about available system resources
     */
    public detectSystemResources(): SystemResources {
        const totalMemoryGB = os.totalmem() / 1024 / 1024 / 1024; // Convert to GB
        const freeMemoryGB = os.freemem() / 1024 / 1024 / 1024; // Convert to GB
        const cpuCount = os.cpus().length;

        // Calculate available memory after reserving some for other processes
        const availableMemoryGB = Math.max(0, freeMemoryGB - this.options.memoryReserveGB);

        return {
            totalMemoryGB,
            freeMemoryGB,
            cpuCount,
            availableMemoryGB
        };
    }

    /**
     * Calculate optimal worker count based on available system resources and model memory requirements
     * @param highMemoryModel Whether we're using the high memory model
     * @param maxWorkers Maximum number of workers to create
     * @returns Optimal number of workers
     */
    public calculateOptimalWorkerCount(highMemoryModel: boolean, maxWorkers: number): number {
        const resources = this.detectSystemResources();

        // Always leave at least one core for the main process
        let workerCount = Math.max(1, Math.min(resources.cpuCount - 1, maxWorkers));

        // For high memory model, each worker needs more memory
        const memoryPerWorker = highMemoryModel ? 3 : 0.1; // GB per worker
        const maxWorkersForMemory = Math.max(1, Math.floor(resources.availableMemoryGB / memoryPerWorker));

        // Take the minimum of CPU-based and memory-based worker counts
        workerCount = Math.min(workerCount, maxWorkersForMemory);

        Log.info(
            `Worker calculation: cpus=${resources.cpuCount}, ` +
            `totalMemoryGB=${resources.totalMemoryGB.toFixed(2)}, ` +
            `availableMemoryGB=${resources.availableMemoryGB.toFixed(2)}, ` +
            `highMemoryModel=${highMemoryModel}, ` +
            `workerCount=${workerCount}`
        );

        return workerCount;
    }

    /**
     * Calculate optimal concurrent tasks based on available system resources
     * @param highMemoryModel Whether we're using a high memory model
     * @returns Optimal number of concurrent tasks
     */
    public calculateOptimalConcurrentTasks(highMemoryModel: boolean): number {
        const resources = this.detectSystemResources();

        // For high memory model, we need more memory per task
        // We're using async processing now, so we need less memory per task
        // but we still need to be cautious with high memory models
        const memoryPerTask = highMemoryModel ? 2 : 0.5; // GB per task (reduced from worker thread values)

        // Calculate based on CPU cores (always leave 1 core for the main thread)
        const cpuBasedCount = Math.max(1, resources.cpuCount - 1);

        // Calculate based on memory
        const memoryBasedCount = Math.max(1, Math.floor(resources.availableMemoryGB / memoryPerTask));

        // Take the minimum of CPU-based and memory-based counts
        const optimalCount = Math.min(cpuBasedCount, memoryBasedCount);

        Log.info(
            `Concurrent tasks calculation: cpus=${resources.cpuCount}, ` +
            `totalMemoryGB=${resources.totalMemoryGB.toFixed(2)}, ` +
            `availableMemoryGB=${resources.availableMemoryGB.toFixed(2)}, ` +
            `highMemoryModel=${highMemoryModel}, ` +
            `optimalCount=${optimalCount}`
        );

        return optimalCount;
    }
}
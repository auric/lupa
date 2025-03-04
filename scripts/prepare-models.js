// Script to download and prepare machine learning models for bundling with the extension
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pipeline, env } = require('@huggingface/transformers');

// Create directory if it doesn't exist
const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

// Setup paths
const rootDir = path.resolve(__dirname, '..');
const modelsDir = path.join(rootDir, 'models');

// Define model information
const PRIMARY_MODEL = 'jinaai/jina-embeddings-v2-base-code';
const FALLBACK_MODEL = 'Xenova/all-MiniLM-L6-v2';

// Main function
async function prepareModels() {
    try {
        console.log('Preparing ML models for bundling with extension...');

        // Configure transformers.js to use our models directory as cache
        env.cacheDir = modelsDir;
        env.allowLocalModels = true;
        env.allowRemoteModels = true;

        // Create directory structure
        ensureDir(modelsDir);

        // Download and cache models using transformers.js itself
        // This is the proper way to get all model files in the correct structure
        console.log(`Downloading primary model: ${PRIMARY_MODEL}`);
        await downloadModel('feature-extraction', PRIMARY_MODEL);

        console.log(`Downloading fallback model: ${FALLBACK_MODEL}`);
        await downloadModel('feature-extraction', FALLBACK_MODEL);

        console.log('Model preparation completed successfully.');
        // List the model files that were downloaded
        listModelFiles();
    } catch (error) {
        console.error('Error preparing models:', error);
        process.exit(1);
    }
}

/**
 * Downloads a model using transformers.js pipeline which handles
 * downloading and caching correctly
 */
async function downloadModel(task, modelName) {
    try {
        // The pipeline call will download and cache the model files
        console.log(`Creating ${task} pipeline with ${modelName}...`);
        const pipe = await pipeline(task, modelName);

        // Test the pipeline with minimal input to ensure it's properly loaded
        console.log('Testing model...');
        await pipe('test', { pooling: 'mean' });

        console.log(`Successfully downloaded and cached ${modelName}`);
    } catch (error) {
        console.error(`Failed to download model ${modelName}:`, error);
        throw error;
    }
}

/**
 * List model files that were downloaded
 */
function listModelFiles() {
    function listDir(dir, indent = '') {
        if (!fs.existsSync(dir)) {
            console.log(`${indent}Directory does not exist: ${dir}`);
            return;
        }

        const items = fs.readdirSync(dir);
        for (const item of items) {
            const itemPath = path.join(dir, item);
            const stats = fs.statSync(itemPath);

            if (stats.isDirectory()) {
                console.log(`${indent}📁 ${item}/`);
                listDir(itemPath, `${indent}  `);
            } else {
                const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
                console.log(`${indent}📄 ${item} (${sizeInMB} MB)`);
            }
        }
    }

    console.log('\nModel Files:');
    listDir(modelsDir);
}

// Execute the main function
prepareModels();
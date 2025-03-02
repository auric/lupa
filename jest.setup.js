// Mock dynamic import for transformers.js
const originalFunction = global.Function;

// Instead of replacing the Function constructor entirely (which causes TypeScript errors),
// we'll just mock the specific case we need while preserving the original functionality
const originalFunctionConstructor = Function;

// Track if we're testing the failure case
global.__testPrimaryModelFailure = false;

global.Function = function (...args) {
    const joinedArgs = args.join(',');
    if (joinedArgs === 'return import("@xenova/transformers")') {
        return async function () {
            // Define a pipeline that can simulate failure on demand
            const mockPipeline = jest.fn().mockImplementation((task, model) => {
                // If we're testing failure and this is the primary model, throw an error
                if (global.__testPrimaryModelFailure && model === 'Xenova/qodo-embed-1-1.5b') {
                    throw new Error('Primary model load failed');
                }
                // Otherwise return a successful pipeline
                return async function (text, options) {
                    return { data: new Float32Array([0.1, 0.2, 0.3]) };
                };
            });

            return {
                pipeline: mockPipeline,
                env: {
                    cacheDir: '',
                    allowLocalModels: true,
                    allowRemoteModels: true
                }
            };
        };
    }
    // Call the original Function constructor for all other cases
    return new originalFunctionConstructor(...args);
};

global.Function.prototype = originalFunctionConstructor.prototype;
Object.setPrototypeOf(global.Function, originalFunctionConstructor);

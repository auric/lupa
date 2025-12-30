import * as z from 'zod';
import { ITool } from '../../tools/ITool';

/**
 * Generates the tool inventory section from available tools.
 * Dynamically creates tool descriptions from Zod schemas.
 */
export function generateToolInventory(tools: ITool[]): string {
    if (tools.length === 0) {
        return '';
    }

    const toolDescriptions = tools
        .map((tool) => formatToolDescription(tool))
        .join('\n\n');

    return `<tool_inventory>
${toolDescriptions}
</tool_inventory>`;
}

/**
 * Format a single tool with its parameters extracted from Zod schema.
 */
function formatToolDescription(tool: ITool): string {
    let description = `**${tool.name}**: ${tool.description}`;

    const params = extractSchemaParams(tool.schema);
    if (params) {
        description += `\n  Parameters: ${params}`;
    }

    return description;
}

/**
 * Extract parameter descriptions from a Zod object schema.
 */
function extractSchemaParams(schema: z.ZodType): string | null {
    try {
        if (schema instanceof z.ZodObject) {
            const shape = schema.shape;
            const params: string[] = [];

            for (const [key, value] of Object.entries(shape)) {
                if (value instanceof z.ZodType) {
                    const desc = value.description;
                    if (desc) {
                        params.push(`${key} (${desc})`);
                    } else {
                        params.push(key);
                    }
                }
            }

            return params.length > 0 ? params.join(', ') : null;
        }
    } catch {
        return null;
    }

    return null;
}

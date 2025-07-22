import React, { memo, useMemo } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { FileLink } from './FileLink';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../../components/ui/accordion';

interface ContextTabProps {
    content: string;
    isDarkTheme: boolean;
    onCopy?: (text: string, id: string) => void;
    copiedStates?: Record<string, boolean>;
}

export const ContextTab = memo<ContextTabProps>(({ 
    content, 
    isDarkTheme, 
    onCopy, 
    copiedStates 
}) => {
    console.time('Context tab render');
    console.log('Context content preview:', content.substring(0, 500) + '...');
    console.log('Context contains code blocks:', content.includes('```'));
    
    // Parse content sections for accordion structure
    const sections = useMemo(() => {
        const sectionDelimiters = [
            { title: 'Definitions Found (LSP)', regex: /## Definitions Found \(LSP\)/ },
            { title: 'References Found (LSP)', regex: /## References Found \(LSP\)/ },
            { title: 'Semantically Similar Code (Embeddings)', regex: /## Semantically Similar Code \(Embeddings\)/ }
        ];
        
        const foundSections: Array<{ title: string; content: string; id: string }> = [];
        
        // Find all section positions first
        const sectionPositions: Array<{ title: string; index: number; id: string }> = [];
        
        sectionDelimiters.forEach((delimiter, delimiterIndex) => {
            const match = content.match(delimiter.regex);
            if (match && match.index !== undefined) {
                sectionPositions.push({
                    title: delimiter.title,
                    index: match.index,
                    id: `section-${delimiterIndex}`
                });
            }
        });
        
        // Sort by position in content
        sectionPositions.sort((a, b) => a.index - b.index);
        
        // Extract content for each section
        sectionPositions.forEach((section, index) => {
            const startIndex = section.index;
            const endIndex = index < sectionPositions.length - 1 
                ? sectionPositions[index + 1].index 
                : content.length;
            
            const sectionContent = content.slice(startIndex, endIndex).trim();
            if (sectionContent) {
                foundSections.push({
                    title: section.title,
                    content: sectionContent,
                    id: section.id
                });
            }
        });
        
        return foundSections;
    }, [content]);
    
    const result = (
        <div className="space-y-4">
            {sections.length > 1 ? (
                // Show accordion when multiple sections exist
                <Accordion type="multiple" className="w-full">
                    {sections.map((section, index) => (
                        <AccordionItem key={section.id} value={section.id}>
                            <AccordionTrigger className="text-left">
                                {section.title}
                            </AccordionTrigger>
                            <AccordionContent>
                                <MarkdownRenderer
                                    content={section.content}
                                    id={`${section.id}-content`}
                                    isDarkTheme={isDarkTheme}
                                    onCopy={onCopy}
                                    copiedStates={copiedStates}
                                />
                            </AccordionContent>
                        </AccordionItem>
                    ))}
                </Accordion>
            ) : (
                // Show single section without accordion
                <MarkdownRenderer
                    content={content}
                    id="context"
                    isDarkTheme={isDarkTheme}
                    onCopy={onCopy}
                    copiedStates={copiedStates}
                />
            )}
        </div>
    );
    
    console.timeEnd('Context tab render');
    return result;
});
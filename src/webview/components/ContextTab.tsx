import React, { memo, useMemo } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
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
            { title: 'Definitions Found (LSP)', regex: /## Definitions Found \(LSP\)/g },
            { title: 'References Found (LSP)', regex: /## References Found \(LSP\)/g },
            { title: 'Semantically Similar Code (Embeddings)', regex: /## Semantically Similar Code \(Embeddings\)/g }
        ];
        
        const foundSections: Array<{ title: string; content: string; id: string }> = [];
        
        sectionDelimiters.forEach((delimiter, index) => {
            const match = delimiter.regex.exec(content);
            if (match) {
                const startIndex = match.index;
                const nextDelimiter = sectionDelimiters[index + 1];
                let endIndex = content.length;
                
                if (nextDelimiter) {
                    const nextMatch = nextDelimiter.regex.exec(content);
                    if (nextMatch) {
                        endIndex = nextMatch.index;
                    }
                }
                
                const sectionContent = content.slice(startIndex, endIndex).trim();
                if (sectionContent) {
                    foundSections.push({
                        title: delimiter.title,
                        content: sectionContent,
                        id: `section-${index}`
                    });
                }
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
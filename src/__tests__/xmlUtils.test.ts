import { describe, it, expect } from 'vitest';
import { XmlUtils } from '../tools/xmlUtils';

describe('XmlUtils', () => {
    describe('escapeXml', () => {
        it('should escape basic XML characters', () => {
            const input = 'Text with <brackets>, &ampersands, "quotes", \'apostrophes\', and >greater than';
            const expected = 'Text with &lt;brackets&gt;, &amp;ampersands, &quot;quotes&quot;, &apos;apostrophes&apos;, and &gt;greater than';

            expect(XmlUtils.escapeXml(input)).toBe(expected);
        });

        it('should handle empty string', () => {
            expect(XmlUtils.escapeXml('')).toBe('');
        });

        it('should handle string with no special characters', () => {
            const input = 'Normal text with spaces and numbers 123';
            expect(XmlUtils.escapeXml(input)).toBe(input);
        });

        it('should handle string with only special characters', () => {
            const input = '<>&"\'"';
            const expected = '&lt;&gt;&amp;&quot;&apos;&quot;';
            expect(XmlUtils.escapeXml(input)).toBe(expected);
        });

        it('should handle complex code snippets', () => {
            const input = 'function test(name: string): boolean {\n  return name && name.length > 0;\n}';
            const expected = 'function test(name: string): boolean {\n  return name &amp;&amp; name.length &gt; 0;\n}';
            expect(XmlUtils.escapeXml(input)).toBe(expected);
        });
    });

    describe('unescapeXml', () => {
        it('should unescape basic XML characters', () => {
            const input = 'Text with &lt;brackets&gt;, &amp;ampersands, &quot;quotes&quot;, &apos;apostrophes&apos;, and &gt;greater than';
            const expected = 'Text with <brackets>, &ampersands, "quotes", \'apostrophes\', and >greater than';

            expect(XmlUtils.unescapeXml(input)).toBe(expected);
        });

        it('should handle empty string', () => {
            expect(XmlUtils.unescapeXml('')).toBe('');
        });

        it('should handle string with no escaped characters', () => {
            const input = 'Normal text with spaces and numbers 123';
            expect(XmlUtils.unescapeXml(input)).toBe(input);
        });

        it('should be reversible with escapeXml', () => {
            const original = 'Test with <all> &special& "characters" \'here\'';
            const escaped = XmlUtils.escapeXml(original);
            const unescaped = XmlUtils.unescapeXml(escaped);

            expect(unescaped).toBe(original);
        });
    });

    describe('createElement', () => {
        it('should create simple element with escaped content', () => {
            const result = XmlUtils.createElement('name', 'John & Jane');
            expect(result).toBe('<name>John &amp; Jane</name>');
        });

        it('should create element with attributes', () => {
            const result = XmlUtils.createElement('person', 'John', {
                id: '123',
                type: 'user & admin'
            });
            expect(result).toBe('<person id="123" type="user &amp; admin">John</person>');
        });

        it('should handle empty content', () => {
            const result = XmlUtils.createElement('empty', '');
            expect(result).toBe('<empty></empty>');
        });

        it('should handle special characters in tag content and attributes', () => {
            const result = XmlUtils.createElement('test', '<content>', {
                attr: '"value"'
            });
            expect(result).toBe('<test attr="&quot;value&quot;">&lt;content&gt;</test>');
        });
    });

    describe('createSelfClosingElement', () => {
        it('should create self-closing element without attributes', () => {
            const result = XmlUtils.createSelfClosingElement('br');
            expect(result).toBe('<br />');
        });

        it('should create self-closing element with attributes', () => {
            const result = XmlUtils.createSelfClosingElement('img', {
                src: 'image.jpg',
                alt: 'Test & Demo'
            });
            expect(result).toBe('<img src="image.jpg" alt="Test &amp; Demo" />');
        });

        it('should handle multiple attributes', () => {
            const result = XmlUtils.createSelfClosingElement('input', {
                type: 'text',
                name: 'username',
                value: 'default & value',
                required: 'true'
            });
            expect(result).toBe('<input type="text" name="username" value="default &amp; value" required="true" />');
        });

        it('should handle empty attributes object', () => {
            const result = XmlUtils.createSelfClosingElement('hr', {});
            expect(result).toBe('<hr />');
        });
    });

    describe('edge cases and integration', () => {
        it('should handle null and undefined gracefully in createElement', () => {
            const result1 = XmlUtils.createElement('test', 'content', undefined);
            const result2 = XmlUtils.createElement('test', 'content', {});

            expect(result1).toBe('<test>content</test>');
            expect(result2).toBe('<test>content</test>');
        });

        it('should handle complex nested XML-like content', () => {
            const content = '<div class="test">Hello & welcome to "our" site</div>';
            const result = XmlUtils.createElement('wrapper', content);

            expect(result).toBe('<wrapper>&lt;div class=&quot;test&quot;&gt;Hello &amp; welcome to &quot;our&quot; site&lt;/div&gt;</wrapper>');
        });

        it('should maintain consistency across all methods', () => {
            const testData = [
                'simple text',
                'text with <brackets>',
                'text with &ampersands',
                'text with "quotes"',
                "text with 'apostrophes'",
                'complex <tag attr="value">content & more</tag>'
            ];

            testData.forEach(data => {
                const escaped = XmlUtils.escapeXml(data);
                const unescaped = XmlUtils.unescapeXml(escaped);
                expect(unescaped).toBe(data);

                const element = XmlUtils.createElement('test', data);
                expect(element).toContain(escaped);
            });
        });
    });
});
import xmlExscape from 'xml-escape';

/**
 * Utility functions for XML processing and formatting
 */
export class XmlUtils {
  /**
   * Escape special XML characters to prevent parsing issues
   * @param text The text to escape
   * @returns XML-escaped text
   */
  static escapeXml(text: string): string {
    return xmlExscape(text);
  }

  /**
   * Unescape XML characters back to their original form
   * @param text The XML-escaped text to unescape
   * @returns Unescaped text
   */
  static unescapeXml(text: string): string {
    return text
      .replace(/&apos;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  }

  /**
   * Create a simple XML element with escaped content
   * @param tagName The XML tag name
   * @param content The content to wrap in the tag
   * @param attributes Optional attributes as key-value pairs
   * @returns Formatted XML element string
   */
  static createElement(tagName: string, content: string, attributes?: Record<string, string>): string {
    const attrString = attributes && Object.keys(attributes).length > 0
      ? ' ' + Object.entries(attributes)
        .map(([key, value]) => `${key}="${this.escapeXml(value)}"`)
        .join(' ')
      : '';

    return `<${tagName}${attrString}>${this.escapeXml(content)}</${tagName}>`;
  }

  /**
   * Create a self-closing XML element with attributes
   * @param tagName The XML tag name
   * @param attributes Optional attributes as key-value pairs
   * @returns Formatted self-closing XML element string
   */
  static createSelfClosingElement(tagName: string, attributes?: Record<string, string>): string {
    const attrString = attributes && Object.keys(attributes).length > 0
      ? ' ' + Object.entries(attributes)
        .map(([key, value]) => `${key}="${this.escapeXml(value)}"`)
        .join(' ')
      : '';

    return `<${tagName}${attrString} />`;
  }
}
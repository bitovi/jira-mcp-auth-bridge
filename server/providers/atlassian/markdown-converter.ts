/**
 * Markdown to ADF (Atlassian Document Format) converter
 * Uses marklassian for lightweight, reliable conversion
 * ADF to Markdown conversion uses custom traversal (Node.js compatible)
 */

import { marked } from 'marked';
import { markdownToAdf } from 'marklassian';
import { logger } from '../../observability/logger.ts';

// ADF (Atlassian Document Format) type definitions
// Based on @atlaskit/adf-schema structure but defined locally for Node.js compatibility
export interface ADFTextNode {
  type: 'text';
  text: string;
  marks?: Array<{
    type: string;
    attrs?: Record<string, any>;
  }>;
}

export interface ADFNode {
  type: string;
  attrs?: any;
  marks?: Array<{ type: string; attrs?: any }>;
  text?: string;
  content?: ADFNode[];
}

export interface ADFParagraph {
  type: 'paragraph';
  content: ADFTextNode[];
}

export interface ADFDocument {
  version: number;
  type: 'doc';
  content: ADFNode[];
}

/**
 * Converts new Markdown content to ADF (AI output, error messages, user-written strings).
 * 
 * ⚠️ NEVER use for round-trip conversions of existing Jira content.
 * For manipulating existing Jira ADF, use ADF operations directly.
 * 
 * @param markdown - Markdown string to convert
 * @returns ADF document structure
 */
export async function convertMarkdownToAdf(markdown: string): Promise<ADFDocument> {
  if (!markdown || typeof markdown !== 'string') {
    logger.warn('Invalid markdown input provided', { markdown });
    return createFallbackAdf(markdown || '');
  }

  logger.info('Converting markdown to ADF', { 
    markdownLength: markdown.length,
    hasNewlines: markdown.includes('\n'),
    hasFormatting: /[*_#`\[\]()]/.test(markdown)
  });

  try {
    const adf = markdownToAdf(markdown) as ADFDocument;
    
    logger.info('Markdown converted to ADF successfully with marklassian', {
      adfVersion: adf.version,
      adfType: adf.type,
      contentBlocks: adf.content?.length || 0
    });

    return adf;
  } catch (error: any) {
    logger.error('Marklassian conversion failed, using fallback', { 
      error: error.message,
      markdownLength: markdown.length 
    });
    
    return createFallbackAdf(markdown);
  }
}

/**
 * Create a simple ADF document for plain text fallback
 * @param text - Plain text content
 * @returns Basic ADF document
 */
function createFallbackAdf(text: string): ADFDocument {
  logger.info('Creating fallback ADF document', { textLength: text.length });
  
  // Split text into paragraphs on double newlines
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  
  if (paragraphs.length === 0) {
    // Empty content
    return {
      version: 1,
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: []
      }]
    };
  }

  const content: ADFParagraph[] = paragraphs.map(paragraph => ({
    type: 'paragraph',
    content: [{
      type: 'text',
      text: paragraph.trim()
    }]
  }));

  return {
    version: 1,
    type: 'doc',
    content
  };
}

/**
 * Validate ADF document structure
 * @param adf - ADF document to validate
 * @returns True if valid ADF structure
 */
export function validateAdf(adf: any): adf is ADFDocument {
  if (!adf || typeof adf !== 'object') {
    return false;
  }

  const hasRequiredFields = (
    adf.version === 1 &&
    adf.type === 'doc' &&
    Array.isArray(adf.content)
  );

  if (!hasRequiredFields) {
    logger.warn('Invalid ADF structure - missing required fields', { adf });
    return false;
  }

  return true;
}

/**
 * Remove a section from ADF content by heading text
 * 
 * Finds a heading containing the specified text and removes all content
 * between that heading and the next heading of the same or higher level.
 * 
 * @param content - Array of ADF nodes to search
 * @param headingText - Text to search for in headings (case-insensitive)
 * @returns New content array with the section removed
 */
export function removeADFSectionByHeading(content: ADFNode[], headingText: string): ADFNode[] {
  // Look for heading node with matching text
  let sectionStartIndex = -1;
  let sectionLevel = -1;
  
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    
    // Check if this is a heading node
    if (node.type === 'heading') {
      // Check if it contains the target text
      const hasMatchingText = node.content?.some((contentNode: ADFNode) => 
        contentNode.type === 'text' && 
        contentNode.text?.toLowerCase().includes(headingText.toLowerCase())
      );
      
      if (hasMatchingText) {
        sectionStartIndex = i;
        sectionLevel = node.attrs?.level || 2;
        logger.info(`Found existing "${headingText}" section`, { 
          index: i, 
          level: sectionLevel 
        });
        break;
      }
    }
  }
  
  // If section not found, return original content
  if (sectionStartIndex === -1) {
    return content;
  }
  
  // Find where the section ends (next heading of same or higher level)
  let sectionEndIndex = content.length;
  
  // Search for next heading of same or higher level (lower number = higher level)
  for (let i = sectionStartIndex + 1; i < content.length; i++) {
    const node = content[i];
    
    if (node.type === 'heading') {
      const headingLevel = node.attrs?.level || 2;
      
      // If we hit a heading of same or higher level, this is where the section ends
      if (headingLevel <= sectionLevel) {
        sectionEndIndex = i;
        logger.info(`"${headingText}" section ends`, { 
          endIndex: i, 
          nextHeadingLevel: headingLevel 
        });
        break;
      }
    }
  }
  
  // Remove only the content between start and end
  const newContent = [
    ...content.slice(0, sectionStartIndex),
    ...content.slice(sectionEndIndex)
  ];
  
  logger.info(`Removed existing "${headingText}" section`, { 
    startIndex: sectionStartIndex, 
    endIndex: sectionEndIndex - 1,
    removedNodes: sectionEndIndex - sectionStartIndex
  });
  
  return newContent;
}

/**
 * Count how many sections with a specific heading exist in ADF content
 * 
 * Searches for headings containing the specified text and returns the count.
 * Used to detect duplicate sections (e.g., multiple "Shell Stories" sections).
 * 
 * @param content - Array of ADF nodes to search
 * @param headingText - Text to search for in headings (case-insensitive)
 * @returns Number of matching sections found
 */
export function countADFSectionsByHeading(content: ADFNode[], headingText: string): number {
  let count = 0;
  
  for (const node of content) {
    // Check if this is a heading node
    if (node.type === 'heading') {
      // Check if it contains the target text
      const hasMatchingText = node.content?.some((contentNode: ADFNode) => 
        contentNode.type === 'text' && 
        contentNode.text?.toLowerCase().includes(headingText.toLowerCase())
      );
      
      if (hasMatchingText) {
        count++;
      }
    }
  }
  
  logger.info(`Found ${count} section(s) with heading "${headingText}"`);
  return count;
}

/**
 * Extract a section from ADF content by heading text
 * 
 * Returns both the extracted section and the remaining content.
 * Similar to removeADFSectionByHeading() but preserves the section for use elsewhere.
 * 
 * @param content - Array of ADF nodes to search
 * @param headingText - Text to search for in headings (case-insensitive)
 * @returns Object with section nodes and remaining content
 */
export function extractADFSection(
  content: ADFNode[],
  headingText: string
): {
  section: ADFNode[];
  remainingContent: ADFNode[];
} {
  // Look for heading node with matching text (reuse logic from removeADFSectionByHeading)
  let sectionStartIndex = -1;
  let sectionLevel = -1;
  
  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    
    if (node.type === 'heading') {
      const hasMatchingText = node.content?.some((contentNode: ADFNode) => 
        contentNode.type === 'text' && 
        contentNode.text?.toLowerCase().includes(headingText.toLowerCase())
      );
      
      if (hasMatchingText) {
        sectionStartIndex = i;
        sectionLevel = node.attrs?.level || 2;
        logger.info(`Found "${headingText}" section for extraction`, { 
          index: i, 
          level: sectionLevel 
        });
        break;
      }
    }
  }
  
  // If section not found, return empty section and all content as remaining
  if (sectionStartIndex === -1) {
    logger.info(`Section "${headingText}" not found, returning all as remaining content`);
    return {
      section: [],
      remainingContent: content
    };
  }
  
  // Find where the section ends
  let sectionEndIndex = content.length;
  
  for (let i = sectionStartIndex + 1; i < content.length; i++) {
    const node = content[i];
    
    if (node.type === 'heading') {
      const headingLevel = node.attrs?.level || 2;
      
      if (headingLevel <= sectionLevel) {
        sectionEndIndex = i;
        logger.info(`"${headingText}" section ends at index ${i}`);
        break;
      }
    }
  }
  
  // Extract section and remaining content
  const section = content.slice(sectionStartIndex, sectionEndIndex);
  const remainingContent = [
    ...content.slice(0, sectionStartIndex),
    ...content.slice(sectionEndIndex)
  ];
  
  logger.info(`Extracted "${headingText}" section`, {
    sectionNodes: section.length,
    remainingNodes: remainingContent.length
  });
  
  return {
    section,
    remainingContent
  };
}


/**
 * Converts ADF (Atlassian Document Format) to Markdown for AI prompt consumption only.
 * 
 * ⚠️ NEVER use for data manipulation, as this is a lossy conversion.
 * 
 * @param adf - ADF document to convert
 * @returns Markdown string for AI prompts only
 */
export function convertAdfToMarkdown(adf: ADFDocument): string {
  logger.info('Converting ADF to markdown', {
    contentBlocks: adf.content?.length || 0
  });

  try {
    const markdown = convertAdfNodesToMarkdown(adf.content || []);
    logger.info('ADF converted to markdown successfully', {
      markdownLength: markdown.length
    });
    return markdown;
  } catch (error: any) {
    logger.error('ADF to markdown conversion failed, falling back to plain text', {
      error: error.message
    });
    // Fallback: Extract plain text without formatting
    return extractPlainTextFromAdf(adf.content || []);
  }
}

/**
 * Convert array of ADF nodes to markdown
 * @param nodes - Array of ADF nodes
 * @returns Markdown string
 */
export function convertAdfNodesToMarkdown(nodes: ADFNode[]): string {
  return nodes.map(node => convertAdfNodeToMarkdown(node)).join('');
}

/**
 * Convert single ADF node to markdown
 * @param node - ADF node to convert
 * @returns Markdown string
 */
function convertAdfNodeToMarkdown(node: ADFNode): string {
  switch (node.type) {
    case 'paragraph':
      return convertParagraphToMarkdown(node) + '\n\n';
    
    case 'heading':
      return convertHeadingToMarkdown(node) + '\n\n';
    
    case 'bulletList':
      return convertBulletListToMarkdown(node) + '\n\n';
    
    case 'orderedList':
      return convertOrderedListToMarkdown(node) + '\n\n';
    
    case 'codeBlock':
      return convertCodeBlockToMarkdown(node) + '\n\n';
    
    case 'table':
      return convertTableToMarkdown(node) + '\n\n';
    
    case 'blockquote':
      return convertBlockquoteToMarkdown(node) + '\n\n';
    
    case 'rule':
      return '---\n\n';
    
    default:
      // For unknown node types, try to extract content
      if (node.content) {
        return convertAdfNodesToMarkdown(node.content);
      }
      logger.warn('Unknown ADF node type', { type: node.type });
      return '';
  }
}

/**
 * Convert paragraph node to markdown
 */
function convertParagraphToMarkdown(node: ADFNode): string {
  if (!node.content || node.content.length === 0) {
    return '';
  }
  return convertInlineNodesToMarkdown(node.content);
}

/**
 * Convert heading node to markdown
 */
function convertHeadingToMarkdown(node: ADFNode): string {
  const level = node.attrs?.level || 1;
  const prefix = '#'.repeat(level);
  const text = node.content ? convertInlineNodesToMarkdown(node.content) : '';
  return `${prefix} ${text}`;
}

/**
 * Convert bullet list to markdown
 */
function convertBulletListToMarkdown(node: ADFNode, indent = 0): string {
  if (!node.content) return '';
  
  const indentStr = '  '.repeat(indent);
  return node.content.map(listItem => {
    if (listItem.type === 'listItem' && listItem.content) {
      return listItem.content.map(itemContent => {
        if (itemContent.type === 'paragraph') {
          return `${indentStr}- ${convertParagraphToMarkdown(itemContent).trim()}`;
        } else if (itemContent.type === 'bulletList') {
          return convertBulletListToMarkdown(itemContent, indent + 1);
        } else if (itemContent.type === 'orderedList') {
          return convertOrderedListToMarkdown(itemContent, indent + 1);
        }
        return '';
      }).join('\n');
    }
    return '';
  }).join('\n');
}

/**
 * Convert ordered list to markdown
 */
function convertOrderedListToMarkdown(node: ADFNode, indent = 0): string {
  if (!node.content) return '';
  
  const indentStr = '  '.repeat(indent);
  return node.content.map((listItem, index) => {
    if (listItem.type === 'listItem' && listItem.content) {
      return listItem.content.map(itemContent => {
        if (itemContent.type === 'paragraph') {
          return `${indentStr}${index + 1}. ${convertParagraphToMarkdown(itemContent).trim()}`;
        } else if (itemContent.type === 'bulletList') {
          return convertBulletListToMarkdown(itemContent, indent + 1);
        } else if (itemContent.type === 'orderedList') {
          return convertOrderedListToMarkdown(itemContent, indent + 1);
        }
        return '';
      }).join('\n');
    }
    return '';
  }).join('\n');
}

/**
 * Convert code block to markdown
 */
function convertCodeBlockToMarkdown(node: ADFNode): string {
  const language = node.attrs?.language || '';
  const code = node.content
    ? node.content.map(n => n.text || '').join('\n')
    : '';
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * Convert table to markdown
 */
function convertTableToMarkdown(node: ADFNode): string {
  if (!node.content) return '';
  
  const rows: string[][] = [];
  
  // Extract table rows
  for (const row of node.content) {
    if (row.type === 'tableRow' && row.content) {
      const cells: string[] = [];
      for (const cell of row.content) {
        if ((cell.type === 'tableCell' || cell.type === 'tableHeader') && cell.content) {
          const cellText = cell.content
            .map(c => convertAdfNodeToMarkdown(c).trim())
            .join(' ');
          cells.push(cellText);
        }
      }
      rows.push(cells);
    }
  }
  
  if (rows.length === 0) return '';
  
  // Build markdown table
  const lines: string[] = [];
  
  // Header row
  lines.push('| ' + rows[0].join(' | ') + ' |');
  
  // Separator row
  lines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
  
  // Data rows
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + rows[i].join(' | ') + ' |');
  }
  
  return lines.join('\n');
}

/**
 * Convert blockquote to markdown
 */
function convertBlockquoteToMarkdown(node: ADFNode): string {
  if (!node.content) return '';
  
  const content = convertAdfNodesToMarkdown(node.content)
    .split('\n')
    .filter(line => line.trim())
    .map(line => `> ${line}`)
    .join('\n');
  
  return content;
}

/**
 * Convert inline nodes (text, marks, etc.) to markdown
 */
function convertInlineNodesToMarkdown(nodes: ADFNode[]): string {
  return nodes.map(node => {
    switch (node.type) {
      case 'text':
        return applyMarksToText(node.text || '', node.marks);
      
      case 'hardBreak':
        return '\n';
      
      case 'inlineCard':
        // Convert inline cards to markdown links
        const url = node.attrs?.url || '';
        const title = node.attrs?.title || url;
        return `[${title}](${url})`;
      
      case 'mention':
        // Mentions: @[username]
        const mentionText = node.attrs?.text || node.attrs?.id || 'unknown';
        return `@[${mentionText}]`;
      
      case 'emoji':
        // Emojis: :emoji_name:
        const emojiShortName = node.attrs?.shortName || 'emoji';
        return `:${emojiShortName}:`;
      
      default:
        logger.warn('Unknown inline ADF node type', { type: node.type });
        return node.text || '';
    }
  }).join('');
}

/**
 * Apply markdown formatting marks to text
 */
function applyMarksToText(text: string, marks?: Array<{ type: string; attrs?: any }>): string {
  if (!marks || marks.length === 0) {
    return text;
  }
  
  let result = text;
  
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        result = `**${result}**`;
        break;
      
      case 'em':
        result = `*${result}*`;
        break;
      
      case 'code':
        result = `\`${result}\``;
        break;
      
      case 'link':
        const href = mark.attrs?.href || '';
        result = `[${result}](${href})`;
        break;
      
      case 'strike':
        result = `~~${result}~~`;
        break;
      
      case 'underline':
        // Markdown doesn't have native underline, use HTML
        result = `<u>${result}</u>`;
        break;
      
      default:
        logger.warn('Unknown mark type', { type: mark.type });
    }
  }
  
  return result;
}

/**
 * Fallback: Extract plain text from ADF (no formatting)
 */
function extractPlainTextFromAdf(nodes: ADFNode[]): string {
  return nodes.map(node => {
    if (node.type === 'text') {
      return node.text || '';
    }
    if (node.content) {
      return extractPlainTextFromAdf(node.content);
    }
    return '';
  }).join(' ').replace(/\s+/g, ' ').trim();
}


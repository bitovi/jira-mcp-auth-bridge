/**
 * Figma Screen Setup Helper
 * 
 * Shared utility for setting up Figma screen data and notes.
 * This is FAST (no image downloads or AI analysis) and should be run every time.
 * 
 * Used by both write-shell-stories and write-next-story to:
 * - Fetch Jira epic and extract Figma URLs
 * - Extract epic context (excluding Shell Stories section)
 * - Fetch Figma file metadata (frames and notes)
 * - Associate notes with screens spatially
 * - Write notes files to temp directory
 * - Generate screens.yaml
 * 
 * The slow part (image download + AI analysis) is handled separately by screen-analysis-regenerator.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { AtlassianClient } from '../../../atlassian/atlassian-api-client.js';
import type { FigmaClient } from '../../../figma/figma-api-client.js';
import type { FigmaNodeMetadata } from '../../../figma/figma-helpers.js';
import { 
  parseFigmaUrl, 
  fetchFigmaNode,
  fetchFigmaNodesBatch,
  getFramesAndNotesForNode,
  convertNodeIdToApiFormat,
  FigmaUnrecoverableError
} from '../../../figma/figma-helpers.js';
import { resolveCloudId, getJiraIssue, handleJiraAuthError } from '../../../atlassian/atlassian-helpers.js';
import { 
  convertAdfNodesToMarkdown,
  countADFSectionsByHeading,
  extractADFSection,
  type ADFNode,
  type ADFDocument,
} from '../../../atlassian/markdown-converter.js';
import { associateNotesWithFrames } from './screen-analyzer.js';
import { generateScreensYaml } from './yaml-generator.js';
// import { writeNotesForScreen } from './note-text-extractor.js';

/**
 * Fetches Figma metadata (frames and notes) from multiple Figma URLs using batched requests.
 * 
 * This function performs semi-recursive accumulation of frames and notes with batching optimization:
 * - Groups URLs by file key for efficient batching
 * - Makes one batch API request per file key (instead of N sequential requests)
 * - For each node, calls getFramesAndNotesForNode() which:
 *   - If node is a CANVAS: Returns all direct child FRAME nodes (one level of recursion)
 *   - If node is a FRAME: Returns that single frame
 *   - Also extracts all Note instances at any level within the node
 * - Accumulates all frames and notes across multiple URLs
 * - Stores the first valid file key for later image download operations
 * 
 * Rate limit optimization: Reduces N requests to 1-3 requests (depending on file key distribution)
 * 
 * @param figmaUrls - Array of Figma URLs to process
 * @param figmaClient - Figma API client with auth
 * @returns Object containing accumulated metadata and the file key
 */
async function fetchFigmaMetadataFromUrls(
  figmaUrls: string[],
  figmaClient: FigmaClient
): Promise<{ allFramesAndNotes: Array<{ url: string; metadata: FigmaNodeMetadata[] }>; figmaFileKey: string }> {
  const allFramesAndNotes: Array<{ url: string; metadata: FigmaNodeMetadata[] }> = [];
  let figmaFileKey = '';
  
  // Phase 1: Group URLs by fileKey and validate
  const urlsByFileKey = new Map<string, Array<{ url: string; nodeId: string; index: number }>>();
  
  for (let i = 0; i < figmaUrls.length; i++) {
    const figmaUrl = figmaUrls[i];
    
    // Parse URL
    const urlInfo = parseFigmaUrl(figmaUrl);
    if (!urlInfo) {
      console.log('    ⚠️  Invalid Figma URL format, skipping');
      continue;
    }
    
    if (!urlInfo.nodeId) {
      console.log('    ⚠️  Figma URL missing nodeId, skipping');
      continue;
    }
    
    const apiNodeId = convertNodeIdToApiFormat(urlInfo.nodeId);
    
    // Store first valid file key for image downloads later
    if (!figmaFileKey) {
      figmaFileKey = urlInfo.fileKey;
    }
    
    // Group by file key for batching
    if (!urlsByFileKey.has(urlInfo.fileKey)) {
      urlsByFileKey.set(urlInfo.fileKey, []);
    }
    urlsByFileKey.get(urlInfo.fileKey)!.push({ url: figmaUrl, nodeId: apiNodeId, index: i });
  }
  
  // Phase 2: Batch fetch per fileKey
  for (const [fileKey, urlInfos] of urlsByFileKey) {
    try {
      // ✅ Single batch request for all nodes in this file
      const nodeIds = urlInfos.map(u => u.nodeId);
      const nodesMap = await fetchFigmaNodesBatch(figmaClient, fileKey, nodeIds);
      
      // Phase 3: Process each node to extract frames/notes
      for (const { url, nodeId } of urlInfos) {
        const nodeData = nodesMap.get(nodeId);
        
        if (!nodeData) {
          console.log(`    ⚠️  Node ${nodeId} not found in response`);
          continue;
        }
        
        // Semi-recursive extraction: getFramesAndNotesForNode() extracts:
        // - For CANVAS nodes: all direct child FRAME nodes (one level recursion)
        // - For FRAME nodes: just that single frame
        // - Notes at any level within the node
        const framesAndNotes = getFramesAndNotesForNode({ document: nodeData }, nodeId);
        
        // Accumulate into array (maintains same structure as before)
        allFramesAndNotes.push({
          url,
          metadata: framesAndNotes
        });
      }
      
    } catch (error: any) {
      console.log(`    ⚠️  Error fetching batch from ${fileKey}: ${error.message}`);
      
      // Unrecoverable errors (403, 429) should be immediately re-thrown
      // These already have user-friendly messages from the helper functions
      if (error instanceof FigmaUnrecoverableError) {
        throw error;
      }
      
      // For other errors, continue trying remaining file keys
    }
  }
  
  return { allFramesAndNotes, figmaFileKey };
}

/**
 * Separates frames and notes from combined Figma metadata.
 * 
 * This function accumulates frames and notes from multiple Figma nodes:
 * - When a CANVAS node is passed to getFramesAndNotesForNode(), it returns all child frames
 * - When a FRAME node is passed to getFramesAndNotesForNode(), it returns that single frame
 * - Notes (INSTANCE type with name "Note") can appear at any level
 * 
 * This helper consolidates all accumulated metadata into separate arrays for processing.
 * 
 * @param allFramesAndNotes - Array of metadata from potentially multiple Figma URLs/nodes
 * @returns Object containing separate arrays of frames and notes
 */
function separateFramesAndNotes(
  allFramesAndNotes: Array<{ url: string; metadata: FigmaNodeMetadata[] }>
): { frames: FigmaNodeMetadata[]; notes: FigmaNodeMetadata[] } {
  const allFrames: FigmaNodeMetadata[] = [];
  const allNotes: FigmaNodeMetadata[] = [];
  
  for (const item of allFramesAndNotes) {
    // Frames are type === "FRAME"
    const frames = item.metadata.filter(n => n.type === 'FRAME');
    
    // Notes are type === "INSTANCE" with name === "Note"
    const notes = item.metadata.filter(n => 
      n.type === 'INSTANCE' && n.name === 'Note'
    );
    
    allFrames.push(...frames);
    allNotes.push(...notes);
  }
  
  return { frames: allFrames, notes: allNotes };
}

/**
 * Extract all Figma URLs from an ADF (Atlassian Document Format) document
 * @param adf - The ADF document to parse
 * @returns Array of unique Figma URLs found
 */
function extractFigmaUrlsFromADF(adf: ADFDocument): string[] {
  const figmaUrls = new Set<string>();
  
  function traverse(node: ADFNode) {
    // Check inlineCard nodes for Figma URLs
    if (node.type === 'inlineCard' && node.attrs?.url) {
      const url = node.attrs.url;
      if (url.includes('figma.com')) {
        figmaUrls.add(url);
      }
    }
    
    // Check text nodes with link marks
    if (node.type === 'text' && node.marks) {
      for (const mark of node.marks) {
        if (mark.type === 'link' && mark.attrs?.href) {
          const url = mark.attrs.href;
          if (url.includes('figma.com')) {
            figmaUrls.add(url);
          }
        }
      }
    }
    
    // Check plain text for Figma URLs (basic regex)
    if (node.type === 'text' && node.text) {
      const urlRegex = /https?:\/\/[^\s]+figma\.com[^\s]*/g;
      const matches = node.text.match(urlRegex);
      if (matches) {
        matches.forEach(url => figmaUrls.add(url));
      }
    }
    
    // Recursively traverse child nodes
    if (node.content) {
      node.content.forEach(traverse);
    }
  }
  
  traverse(adf);
  return Array.from(figmaUrls);
}


/**
 * Screen with associated notes
 */
export interface ScreenWithNotes {
  name: string;        // Node ID (e.g., "1234:5678")
  url: string;         // Full Figma URL
  notes: string[];     // Associated note texts
}

/**
 * Jira issue structure (simplified)
 */
interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: ADFDocument;
    [key: string]: any;
  };
}

/**
 * Parameters for Figma screen setup
 */
export interface FigmaScreenSetupParams {
  epicKey: string;               // Jira epic key
  atlassianClient: AtlassianClient;  // Atlassian API client with auth in closure
  figmaClient: FigmaClient;          // Figma API client with auth in closure
  debugDir: string | null;       // Debug directory for artifacts (null if not in DEV mode)
  cloudId?: string;              // Optional explicit cloud ID
  siteName?: string;             // Optional site name
  notify?: (message: string) => Promise<void>;  // Optional progress callback
}

/**
 * Result of Figma screen setup
 */
export interface FigmaScreenSetupResult {
  screens: ScreenWithNotes[];
  allFrames: FigmaNodeMetadata[];
  allNotes: FigmaNodeMetadata[];
  figmaFileKey: string;          // File key for image downloads
  yamlContent: string;           // Generated screens.yaml content
  yamlPath?: string;             // Path to screens.yaml (only in DEV mode)
  epicWithoutShellStoriesMarkdown: string;   // Epic content excluding Shell Stories
  epicWithoutShellStoriesAdf: ADFNode[];           // Epic content excluding Shell Stories
  epicDescriptionAdf: ADFDocument;     // Full epic description (ADF)
  shellStoriesAdf: ADFNode[];          // Shell Stories section (if exists)
  
  figmaUrls: string[];           // Extracted Figma URLs
  cloudId: string;               // Resolved cloud ID
  siteName: string;              // Resolved site name
  projectKey: string;            // Project key from epic
  epicKey: string;               // Epic key
  epicUrl: string;               // Epic URL
}

/**
 * Setup Figma screens with notes
 * 
 * Fetches epic, extracts Figma URLs and context, fetches Figma metadata, 
 * associates notes with frames, and writes note files.
 * This is fast and should be done every time (even when using cached analysis files).
 * 
 * @param params - Configuration including epic key, tokens, and temp directory
 * @returns Screen data with notes, frames, notes metadata, epic context, and file key
 */
export async function setupFigmaScreens(
  params: FigmaScreenSetupParams
): Promise<FigmaScreenSetupResult> {
  const { epicKey, atlassianClient, figmaClient, debugDir, cloudId, siteName, notify } = params;
  
  // ==========================================
  // Step 1: Fetch epic and extract Figma URLs
  // ==========================================
  if (notify) {
    await notify('Fetching epic from Jira...');
  }
  
  // Resolve cloud ID (use explicit cloudId/siteName or first accessible site)
  const siteInfo = await resolveCloudId(atlassianClient, cloudId, siteName);
  
  // Fetch the epic issue
  const issueResponse = await getJiraIssue(atlassianClient, siteInfo.cloudId, epicKey, undefined);
  await handleJiraAuthError(issueResponse, 'Fetch epic');
  
  const issue = await issueResponse.json() as JiraIssue;
  


  // ==========================================
  // Step 2: Extract epic context (excluding Shell Stories)
  // ==========================================
  if (notify) {
    await notify('Extracting epic content...');
  }

  const projectKey = issue.fields?.project?.key;
  if (!projectKey) {
    throw new Error(`Epic ${epicKey} has no project key.`);
  }
  
  // Extract Figma URLs from epic description
  const description = issue.fields?.description;
  if (!description) {
    throw new Error(`Epic ${epicKey} has no description. Please add Figma design URLs to the epic description.`);
  }
  
  const figmaUrls = extractFigmaUrlsFromADF(description);
  console.log(`  Found ${figmaUrls.length} Figma URLs`);
  
  if (figmaUrls.length === 0) {
    throw new Error(`No Figma URLs found in epic ${epicKey}. Please add Figma design links to the epic description.`);
  }
  
  // Check for multiple Shell Stories sections
  const shellStoriesCount = countADFSectionsByHeading(description.content || [], 'shell stories');
  if (shellStoriesCount > 1) {
    throw new Error(`Epic ${epicKey} contains ${shellStoriesCount} "## Shell Stories" sections. Please consolidate into one section.`);
  }
  
  // Extract Shell Stories section using ADF operations
  const { section: shellStoriesAdf, remainingContent: epicWithoutShellStoriesAdf } = 
    extractADFSection(description.content || [], 'Shell Stories');

  const epicWithoutShellStoriesMarkdown = convertAdfNodesToMarkdown(epicWithoutShellStoriesAdf);
  
  console.log(`    Epic context: ${epicWithoutShellStoriesAdf.length} ADF nodes`);
  console.log(`    Shell stories: ${shellStoriesAdf.length} ADF nodes`);
  
  // ==========================================
  // Step 3: Fetch Figma metadata for all URLs
  // ==========================================
  const { allFramesAndNotes, figmaFileKey } = await fetchFigmaMetadataFromUrls(figmaUrls, figmaClient);
  
  // ==========================================
  // Step 4: Combine and separate frames/notes
  // ==========================================
  const { frames: allFrames, notes: allNotes } = separateFramesAndNotes(allFramesAndNotes);
  
  console.log(`    Found ${allFrames.length} frames, ${allNotes.length} notes`);
  
  // ==========================================
  // Step 5: Associate notes with frames
  // ==========================================
  if (notify) {
    await notify('Associating notes with screens...');
  }
  
  // Use the first Figma URL as base for generating node URLs
  const baseUrl = figmaUrls[0]?.split('?')[0] || '';
  
  // Associate notes with frames based on spatial proximity
  const { screens, unassociatedNotes } = associateNotesWithFrames(
    allFrames,
    allNotes,
    baseUrl
  );
  
  // ==========================================
  // Step 4: Generate screens.yaml content
  // ==========================================
  const yamlContent = generateScreensYaml(screens, unassociatedNotes);
  let yamlPath: string | undefined;
  
  // Only write to file in DEV mode
  if (debugDir) {
    if (notify) {
      await notify('Saving preparation data...');
    }
    
    yamlPath = path.join(debugDir, 'screens.yaml');
    await fs.writeFile(yamlPath, yamlContent, 'utf-8');
  }
  
  // Construct epic URL
  const epicUrl = `https://${siteInfo.siteName}.atlassian.net/browse/${epicKey}`;
  
  return {
    screens,
    allFrames,
    allNotes,
    figmaFileKey,
    yamlContent,
    yamlPath,
    epicWithoutShellStoriesMarkdown,
    epicWithoutShellStoriesAdf,
    epicDescriptionAdf: description,
    shellStoriesAdf,
    figmaUrls,
    cloudId: siteInfo.cloudId,
    siteName: siteInfo.siteName,
    projectKey,
    epicKey,
    epicUrl
  };
}

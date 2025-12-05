/**
 * Core business logic for write-shell-stories tool
 * 
 * This module contains the pure business logic for generating shell stories from Figma designs.
 * It is independent of MCP-specific concerns (authentication, context, etc.) and can be used
 * from both MCP handlers and REST API endpoints.
 * 
 * The logic orchestrates:
 * 1. Creating temp directory for artifacts
 * 2. Setting up Figma screens and extracting epic context
 * 3. Downloading images and analyzing screens with AI
 * 4. Generating prioritized shell stories
 * 5. Updating the Jira epic with generated stories
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolDependencies } from '../types.js';
import { getDebugDir, getBaseCacheDir } from './temp-directory-manager.js';
import { getFigmaFileCachePath } from '../../../figma/figma-cache.js';
import { setupFigmaScreens } from './figma-screen-setup.js';
import { regenerateScreenAnalyses } from '../shared/screen-analysis-regenerator.js';
import {
  generateShellStoryPrompt,
  SHELL_STORY_SYSTEM_PROMPT,
  SHELL_STORY_MAX_TOKENS
} from './prompt-shell-stories.js';
import { 
  convertMarkdownToAdf,
  convertAdfNodesToMarkdown,
  validateAdf,
  extractADFSection,
  type ADFNode,
  type ADFDocument
} from '../../../atlassian/markdown-converter.js';
import { handleJiraAuthError, addIssueComment } from '../../../atlassian/atlassian-helpers.js';
import { calculateAdfSize, wouldExceedLimit } from './size-helpers.js';

/**
 * Helper: Extract the "## Scope Analysis" section from epic context
 */
interface ParsedEpicContext {
  scopeAnalysis: string | null;
  remainingContext: string;
}

function extractScopeAnalysis(epicContext: string): ParsedEpicContext {
  const scopeAnalysisMatch = epicContext.match(/## Scope Analysis\s+([\s\S]*?)(?=\n## |$)/i);
  const scopeAnalysis = scopeAnalysisMatch ? scopeAnalysisMatch[1].trim() : null;
  
  const remainingContext = scopeAnalysis 
    ? epicContext.replace(/## Scope Analysis\s+[\s\S]*?(?=\n## |$)/i, '').trim()
    : epicContext;

  return {
    scopeAnalysis,
    remainingContext
  };
}

/**
 * Parameters for executing the write-shell-stories workflow
 */
export interface ExecuteWriteShellStoriesParams {
  epicKey: string;
  cloudId?: string;
  siteName?: string;
}

/**
 * Result from executing the write-shell-stories workflow
 */
export interface ExecuteWriteShellStoriesResult {
  success: boolean;
  shellStoriesContent: string;
  storyCount: number;
  screensAnalyzed: number;
}

/**
 * Execute the write-shell-stories workflow
 * 
 * This is the core business logic that can be called from both MCP handlers and REST API endpoints.
 * It uses dependency injection to abstract away authentication and LLM provider concerns.
 * 
 * @param params - Workflow parameters
 * @param deps - Injected dependencies (clients, LLM, notifier)
 * @returns Result with shell stories content and metadata
 */
export async function executeWriteShellStories(
  params: ExecuteWriteShellStoriesParams,
  deps: ToolDependencies
): Promise<ExecuteWriteShellStoriesResult> {
  const { epicKey, cloudId, siteName } = params;
  const { atlassianClient, figmaClient, generateText, notify } = deps;
  
  console.log('executeWriteShellStories called', { epicKey, cloudId, siteName });
  console.log('  Starting shell story generation for epic:', epicKey);

  // Get debug directory for artifacts (only in DEV mode)
  const debugDir = await getDebugDir(epicKey);

  // ==========================================
  // PHASE 1-3: Fetch epic, extract context, setup Figma screens
  // ==========================================
  console.log('  Phase 1-3: Setting up epic and Figma screens...');
  await notify('📝 Preparation: Fetching epic and Figma metadata...');
  
  const setupResult = await setupFigmaScreens({
    epicKey,
    atlassianClient,
    figmaClient,
    debugDir,
    cloudId,
    siteName,
    notify: async (msg) => await notify(msg)
  });
  
  const {
    screens,
    allFrames,
    allNotes,
    figmaFileKey,
    epicWithoutShellStoriesMarkdown,
    epicWithoutShellStoriesAdf,
    figmaUrls,
    cloudId: resolvedCloudId,
    siteName: resolvedSiteName,
    yamlContent
  } = setupResult;
  
  console.log(`  Phase 1-3 complete: ${figmaUrls.length} Figma URLs, ${screens.length} screens, ${allNotes.length} notes`);
  await notify(`✅ Preparation Complete: ${screens.length} screens ready`);

  // ==========================================
  // PHASE 4: Download images and analyze screens
  // ==========================================
  console.log('  Phase 4: Downloading images and analyzing screens...');
  
  // Add steps for all screens to be analyzed
  await notify(`📝 AI Screen Analysis: Starting analysis of ${screens.length} screens...`, screens.length);
  
  const { analyzedScreens } = await regenerateScreenAnalyses({
    generateText,
    figmaClient,
    screens,
    allFrames,
    allNotes,
    figmaFileKey,
    epicContext: epicWithoutShellStoriesMarkdown,
    notify: async (message: string) => {
      // Show progress for each screen (auto-increments)
      await notify(message);
    }
  });
  
  console.log(`  Phase 4 complete: ${analyzedScreens}/${screens.length} screens analyzed`);
  await notify(`✅ AI Screen Analysis: Analyzed ${analyzedScreens} screens`);

  // ==========================================
  // PHASE 5: Generate shell stories from analyses
  // ==========================================
  const shellStoriesResult = await generateShellStoriesFromAnalyses({
    generateText, // Use injected LLM client
    screens,
    debugDir,
    figmaFileKey,
    yamlContent,
    notify,
    epicContext: epicWithoutShellStoriesMarkdown
  });

  // ==========================================
  // PHASE 6: Write shell stories back to Jira epic
  // ==========================================
  await notify('📝 Jira Update: Updating Jira epic...');
  
  let shellStoriesContent = '';
  if (shellStoriesResult.shellStoriesText) {
    shellStoriesContent = shellStoriesResult.shellStoriesText;
    
    // Update the epic description with shell stories
    await updateEpicWithShellStories({
      epicKey,
      cloudId: resolvedCloudId,
      atlassianClient,
      shellStoriesMarkdown: shellStoriesContent,
      epicWithoutShellStoriesAdf,
      notify
    });
  } else {
    shellStoriesContent = 'No shell stories were generated.';
  }

  return {
    success: true,
    shellStoriesContent,
    storyCount: shellStoriesResult.storyCount,
    screensAnalyzed: shellStoriesResult.analysisCount
  };
}

/**
 * Phase 5: Generate shell stories from analyses
 * 
 * Reads all screen analysis files and uses AI to generate
 * prioritized shell stories following evidence-based incremental value principles.
 * 
 * @returns Object with storyCount, analysisCount, and shellStoriesPath
 */
async function generateShellStoriesFromAnalyses(params: {
  generateText: ToolDependencies['generateText'];
  screens: Array<{ name: string; url: string; notes: string[] }>;
  debugDir: string | null;
  figmaFileKey: string;
  yamlContent: string;
  notify: ToolDependencies['notify'];
  epicContext?: string;
}): Promise<{ storyCount: number; analysisCount: number; shellStoriesPath: string | null; shellStoriesText: string | null }> {
  const { generateText, screens, debugDir, figmaFileKey, yamlContent, notify, epicContext } = params;
  
  console.log('  Phase 5: Generating shell stories from analyses...');
  
  await notify('📝 Shell Story Generation: Generating shell stories from screen analyses...');
  
  // screens.yaml content is provided directly (always generated, optionally written to file)
  const screensYamlContent = yamlContent;
  
  // Construct file cache path for analysis files (always available)
  const fileCachePath = getFigmaFileCachePath(figmaFileKey);
  
  // Read all analysis files from file cache
  const analysisFiles: Array<{ screenName: string; content: string }> = [];
  for (const screen of screens) {
    const analysisPath = path.join(fileCachePath, `${screen.name}.analysis.md`);
    try {
      const content = await fs.readFile(analysisPath, 'utf-8');
      analysisFiles.push({ screenName: screen.name, content });
      console.log(`    ✅ Read analysis: ${screen.name}.analysis.md`);
    } catch (error: any) {
      console.log(`    ⚠️ Could not read analysis for ${screen.name}: ${error.message}`);
    }
  }
  
  console.log(`  Loaded ${analysisFiles.length}/${screens.length} analysis files`);
  
  // Note: Analysis files are passed to generateShellStoryPrompt for backward compatibility
  // but are not currently used. Shell stories are generated from scope analysis in epic context.
  
  if (analysisFiles.length === 0) {
    await notify('⚠️ No analysis files found - skipping shell story generation');
    return { storyCount: 0, analysisCount: 0, shellStoriesPath: null, shellStoriesText: null };
  }
  
  // Verify epic context exists (required for scope analysis)
  if (!epicContext || !epicContext.trim()) {
    throw new Error('Epic context with scope analysis is required for shell story generation. Please run the "analyze-feature-scope" tool first to generate scope analysis, then run this tool again.');
  }
  
  // Extract scope analysis from epic context
  const { scopeAnalysis, remainingContext } = extractScopeAnalysis(epicContext);
  
  if (!scopeAnalysis) {
    throw new Error('Epic must contain a "## Scope Analysis" section. Please run the "analyze-feature-scope" tool first to generate scope analysis, then run this tool again.');
  }
  
  // Generate shell story prompt
  const shellStoryPrompt = generateShellStoryPrompt(
    screensYamlContent,
    analysisFiles,
    scopeAnalysis,
    remainingContext
  );
  
  // Save prompt to debug directory for debugging (if enabled)
  if (debugDir) {
    const promptPath = path.join(debugDir, 'shell-stories-prompt.md');
    await fs.writeFile(promptPath, shellStoryPrompt, 'utf-8');
    console.log(`    ✅ Saved prompt: shell-stories-prompt.md`);
  }
  
  console.log(`    🤖 Requesting shell story generation from AI...`);
  console.log(`       Prompt length: ${shellStoryPrompt.length} characters`);
  console.log(`       System prompt length: ${SHELL_STORY_SYSTEM_PROMPT.length} characters`);
  console.log(`       Max tokens: ${SHELL_STORY_MAX_TOKENS}`);
  if (epicContext && epicContext.length > 0) {
    console.log(`       Epic context: ${epicContext.length} characters`);
  }
  
  // Request shell story generation via injected LLM client
  console.log('    ⏳ Waiting for Anthropic API response...');
  const response = await generateText({
    messages: [
      { role: 'system', content: SHELL_STORY_SYSTEM_PROMPT },
      { role: 'user', content: shellStoryPrompt }
    ],
    maxTokens: SHELL_STORY_MAX_TOKENS
  });
  
  const shellStoriesText = response.text;
  
  if (!shellStoriesText) {
    throw new Error(`
🤖 **AI Generation Failed**

**What happened:**
No shell stories content received from AI

**Possible causes:**
- AI service timeout or rate limit
- Invalid prompt or context
- Epic description may not contain valid Figma links
- Network connectivity issues

**How to fix:**
1. Wait a few minutes and retry the operation
2. Verify your Anthropic API key is still valid
3. Check that the epic description contains accessible Figma design links
4. Ensure the Figma files are not empty or corrupted

**Technical details:**
- AI response was empty or malformed
- Screens analyzed: ${screens.length}
- Analysis files loaded: ${analysisFiles.length}
`.trim());
  }
  
  console.log(`    ✅ Shell stories generated (${shellStoriesText.length} characters)`);
  if (response.metadata) {
    console.log(`       Tokens used: ${response.metadata.usage?.totalTokens}, Finish reason: ${response.metadata.finishReason}`);
  }
  
  // Save shell stories to file (if debug directory enabled)
  let shellStoriesPath: string | null = null;
  if (debugDir) {
    shellStoriesPath = path.join(debugDir, 'shell-stories.md');
    await fs.writeFile(shellStoriesPath, shellStoriesText, 'utf-8');
    console.log(`    ✅ Saved shell stories: shell-stories.md`);
  }
  
  // Count stories (rough estimate by counting "st" prefixes with or without backticks)
  const storyMatches = shellStoriesText.match(/^- `?st\d+/gm);
  const storyCount = storyMatches ? storyMatches.length : 0;
  
  await notify(`✅ Shell Story Generation Complete: Generated ${storyCount} shell stories`);
  
  return { storyCount, analysisCount: analysisFiles.length, shellStoriesPath, shellStoriesText };
}

/**
 * Helper function for Phase 6: Update epic with shell stories
 * @param params - Parameters for updating the epic
 * @param params.epicKey - The Jira epic key
 * @param params.cloudId - The Atlassian cloud ID
 * @param params.atlassianClient - Atlassian API client with auth
 * @param params.shellStoriesMarkdown - The AI-generated shell stories markdown content
 * @param params.epicWithoutShellStoriesAdf - The epic description ADF content without Shell Stories section (from setupResult)
 * @param params.notify - Progress notification function
 */
async function updateEpicWithShellStories({
  epicKey,
  cloudId,
  atlassianClient,
  shellStoriesMarkdown,
  epicWithoutShellStoriesAdf,
  notify
}: {
  epicKey: string;
  cloudId: string;
  atlassianClient: ToolDependencies['atlassianClient'];
  shellStoriesMarkdown: string;
  epicWithoutShellStoriesAdf: ADFNode[];
  notify: ToolDependencies['notify'];
}): Promise<void> {
  console.log('  Phase 6: Updating epic with shell stories...');

  try {
    // Clean up AI-generated content and prepare section
    const shellStoriesSection = prepareShellStoriesSection(shellStoriesMarkdown);
    
    // Convert the new section to ADF
    console.log('    Converting shell stories section to ADF...');
    const shellStoriesAdf = await convertMarkdownToAdf(shellStoriesSection);
    
    if (!validateAdf(shellStoriesAdf)) {
      console.log('    ⚠️ Failed to convert shell stories to valid ADF');
      await notify('⚠️ Failed to convert shell stories to ADF');
      return;
    }
    
    console.log('    ✅ Shell stories converted to ADF');
    
    // Check if combined size would exceed Jira's limit
    const wouldExceed = wouldExceedLimit(epicWithoutShellStoriesAdf, shellStoriesAdf);

    let finalContent = epicWithoutShellStoriesAdf;

    if (wouldExceed) {
      // Extract Scope Analysis section from content
      const { section: scopeAnalysisSection, remainingContent } = extractADFSection(
        epicWithoutShellStoriesAdf,
        'Scope Analysis'
      );
      
      if (scopeAnalysisSection.length > 0) {
        console.log('  ⚠️ Moving Scope Analysis to comment (content would exceed 43KB limit)');
        await notify('⚠️ Moving Scope Analysis to comment to stay within 43KB limit...');
        
        // Convert to markdown
        const scopeAnalysisMarkdown = convertAdfNodesToMarkdown(scopeAnalysisSection);
        
        // Post as comment
        try {
          await addIssueComment(
            atlassianClient,
            cloudId,
            epicKey,
            `**Note**: The Scope Analysis section was moved to this comment due to description size limits (43KB max).\n\n---\n\n${scopeAnalysisMarkdown}`
          );
        } catch (err: any) {
          console.log(`    ⚠️ Failed to post comment: ${err.message}`);
          // Continue anyway - we'll still update the description
        }
        
        // Use remaining content (without Scope Analysis)
        finalContent = remainingContent;
      }
    }

    // After moving Scope Analysis, check size and warn if still large
    const finalDoc: ADFDocument = {
      version: 1,
      type: 'doc',
      content: [...finalContent, ...shellStoriesAdf.content]
    };

    const JIRA_LIMIT = 43838;
    const SAFETY_MARGIN = 2000;
    const finalSize = calculateAdfSize(finalDoc);

    if (finalSize > (JIRA_LIMIT - SAFETY_MARGIN)) {
      console.log(`  ⚠️ Warning: Epic description will be ${finalSize} characters (exceeds safe limit of ${JIRA_LIMIT - SAFETY_MARGIN}). Attempting update anyway...`);
      await notify(`⚠️ Warning: Description is ${finalSize} chars (may exceed limit). Attempting update...`);
    }
    
    // Combine description (without old shell stories from Phase 1.6) with new shell stories section
    const updatedDescription: ADFDocument = {
      version: 1,
      type: 'doc',
      content: [
        ...finalContent,
        ...shellStoriesAdf.content
      ]
    };
    
    // Update the epic
    console.log('    Updating epic description...');
    const updateUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${epicKey}`;
    
    const updateResponse = await atlassianClient.fetch(updateUrl, {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          description: updatedDescription
        }
      }),
    });
    
    if (updateResponse.status === 404) {
      console.log(`    ⚠️ Epic ${epicKey} not found`);
      await notify(`⚠️ Epic ${epicKey} not found`);
      return;
    }
    
    if (updateResponse.status === 403) {
      console.log(`    ⚠️ Insufficient permissions to update epic ${epicKey}`);
      await notify(`⚠️ Insufficient permissions to update epic`);
      return;
    }
    
    await handleJiraAuthError(updateResponse, `Update epic ${epicKey} description`);
    
    console.log('    ✅ Epic description updated successfully');
    //await notify(`✅ Jira Update Complete: Epic updated with shell stories`);
    
  } catch (error: any) {
    console.log(`    ⚠️ Error updating epic: ${error.message}`);
    await notify(`⚠️ Error updating epic: ${error.message}`);
  }
}

/**
 * Prepare shell stories section for Jira epic
 * 
 * Strips any leading headers from AI-generated content to avoid double headers.
 * The AI sometimes adds headers like "# Task Search and Filter - Shell Stories"
 * even though we instruct it not to.
 * 
 * @param shellStoriesMarkdown - Raw markdown from AI generation
 * @returns Cleaned markdown with "## Shell Stories" header
 */
function prepareShellStoriesSection(shellStoriesMarkdown: string): string {
  let cleanedMarkdown = shellStoriesMarkdown.trim();
  
  // Remove any leading H1 headers (# ...)
  cleanedMarkdown = cleanedMarkdown.replace(/^#\s+.*?\n+/m, '');
  
  // Remove any leading H2 headers (## ...) that might say "Shell Stories"
  cleanedMarkdown = cleanedMarkdown.replace(/^##\s+.*?\n+/m, '');
  
  // Return with proper section header
  return `## Shell Stories\n\n${cleanedMarkdown}`;
}

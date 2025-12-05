/**
 * Core business logic for analyze-feature-scope tool
 * 
 * This module contains the pure business logic for generating scope analysis from Figma designs.
 * It is independent of MCP-specific concerns (authentication, context, etc.) and can be used
 * from both MCP handlers and REST API endpoints.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolDependencies } from '../types.js';
import { getBaseCacheDir } from '../writing-shell-stories/temp-directory-manager.js';
import { getFigmaFileCachePath } from '../../../figma/figma-cache.js';
import { executeScreenAnalysisPipeline } from '../shared/screen-analysis-pipeline.js';
import {
  generateFeatureIdentificationPrompt,
  FEATURE_IDENTIFICATION_SYSTEM_PROMPT,
  FEATURE_IDENTIFICATION_MAX_TOKENS
} from './strategies/prompt-scope-analysis-2.js';
import {
  convertMarkdownToAdf,
  validateAdf,
  type ADFNode,
  type ADFDocument
} from '../../../atlassian/markdown-converter.js';
import { handleJiraAuthError } from '../../../atlassian/atlassian-helpers.js';

/**
 * Parameters for executing the analyze-feature-scope workflow
 */
export interface ExecuteAnalyzeFeatureScopeParams {
  epicKey: string;
  cloudId?: string;
  siteName?: string;
}

/**
 * Result from executing the analyze-feature-scope workflow
 */
export interface ExecuteAnalyzeFeatureScopeResult {
  success: boolean;
  scopeAnalysisContent: string;
  featureAreasCount: number;
  questionsCount: number;
  screensAnalyzed: number;
}

/**
 * Execute the analyze-feature-scope workflow
 * 
 * This is the core business logic that can be called from both MCP handlers and REST API endpoints.
 * It uses dependency injection to abstract away authentication and LLM provider concerns.
 * 
 * @param params - Workflow parameters
 * @param deps - Injected dependencies (clients, LLM, notifier)
 * @returns Result with scope analysis content and metadata
 */
export async function executeAnalyzeFeatureScope(
  params: ExecuteAnalyzeFeatureScopeParams,
  deps: ToolDependencies
): Promise<ExecuteAnalyzeFeatureScopeResult> {
  const { epicKey, cloudId, siteName } = params;
  const { atlassianClient, figmaClient, generateText, notify } = deps;

  // ==========================================
  // PHASE 1-4: Reuse shared screen analysis pipeline
  // ==========================================
  const analysisResult = await executeScreenAnalysisPipeline(
    {
      epicKey,
      cloudId,
      siteName,
      sectionName: 'Scope Analysis' // Exclude this section from epic context
    },
    deps
  );
  
  const {
    screens,
    debugDir,
    figmaFileKey,
    yamlContent,
    epicWithoutShellStoriesMarkdown: epicContext,
    epicWithoutShellStoriesAdf,
    cloudId: resolvedCloudId,
    siteName: resolvedSiteName,
    analyzedScreens
  } = analysisResult;

  console.log(`🔍 analyze-feature-scope: Received ${screens.length} screens from pipeline`);
  console.log(`   Analyzed screens count: ${analyzedScreens}`);

  // ==========================================
  // PHASE 5: Generate scope analysis
  // ==========================================
  const scopeAnalysisResult = await generateScopeAnalysis({
    generateText,
    screens,
    debugDir,
    figmaFileKey,
    yamlContent,
    notify,
    epicContext
  });

  // ==========================================
  // PHASE 6: Update Jira epic with scope analysis
  // ==========================================
  await updateEpicWithScopeAnalysis({
    epicKey,
    cloudId: resolvedCloudId,
    atlassianClient,
    scopeAnalysisMarkdown: scopeAnalysisResult.scopeAnalysisContent,
    contentWithoutScopeAnalysis: epicWithoutShellStoriesAdf,
    notify
  });

  return {
    success: true,
    scopeAnalysisContent: scopeAnalysisResult.scopeAnalysisContent,
    featureAreasCount: scopeAnalysisResult.featureAreasCount,
    questionsCount: scopeAnalysisResult.questionsCount,
    screensAnalyzed: analyzedScreens
  };
}

/**
 * Phase 5: Generate scope analysis from screen analyses
 * 
 * Reads all screen analysis files and uses AI to identify and categorize features
 * into in-scope (☐), already done (✅), low priority (⏬), out-of-scope (❌), and questions (❓), grouped by workflow areas.
 * 
 * @returns Object with scopeAnalysisContent, featureAreasCount, and questionsCount
 */
async function generateScopeAnalysis(params: {
  generateText: ToolDependencies['generateText'];
  screens: Array<{ name: string; url: string; notes: string[] }>;
  debugDir: string | null;
  figmaFileKey: string;
  yamlContent: string;
  notify: ToolDependencies['notify'];
  epicContext?: string;
}): Promise<{
  scopeAnalysisContent: string;
  featureAreasCount: number;
  questionsCount: number;
  scopeAnalysisPath: string;
}> {
  const { generateText, screens, debugDir, figmaFileKey, yamlContent, notify, epicContext } = params;
  
  await notify('📝 Feature Identification: Analyzing features and scope...');
  
  // screens.yaml content is provided directly (always generated, optionally written to file)
  const screensYamlContent = yamlContent;
  
  // Construct file cache path for analysis files (always available)
  const fileCachePath = getFigmaFileCachePath(figmaFileKey);
  
  // Read all analysis files with URLs from file cache
  const analysisFiles: Array<{ screenName: string; content: string; url: string }> = [];
  for (const screen of screens) {
    const analysisPath = path.join(fileCachePath, `${screen.name}.analysis.md`);
    try {
      const content = await fs.readFile(analysisPath, 'utf-8');
      analysisFiles.push({
        screenName: screen.name,
        content,
        url: screen.url
      });
    } catch (error: any) {
      console.log(`    ⚠️ Could not read analysis for ${screen.name}: ${error.message}`);
    }
  }
  
  if (analysisFiles.length === 0) {
    await notify('⚠️ No analysis files found - skipping scope analysis generation');
    throw new Error('No screen analysis files found for scope analysis generation');
  }
  
  // Generate feature identification prompt
  const prompt = generateFeatureIdentificationPrompt(
    screensYamlContent,
    analysisFiles,
    epicContext
  );
  
  // Save prompt to debug directory for debugging (if enabled)
  if (debugDir) {
    const promptPath = path.join(debugDir, 'scope-analysis-prompt.md');
    await fs.writeFile(promptPath, prompt, 'utf-8');
  }
  
  console.log(`    🤖 Scope analysis (${prompt.length} chars / ${FEATURE_IDENTIFICATION_MAX_TOKENS} max tokens)`);
  
  // Request scope analysis generation via injected LLM client
  const response = await generateText({
    messages: [
      { role: 'system', content: FEATURE_IDENTIFICATION_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    maxTokens: FEATURE_IDENTIFICATION_MAX_TOKENS
  });
  
  const scopeAnalysisText = response.text;
  
  if (!scopeAnalysisText) {
    throw new Error(`No scope analysis content received from AI.
Possible causes:
- AI service timeout or rate limit
- Invalid prompt or context
- Epic description may not contain valid Figma links
- Network connectivity issues

Technical details:
- AI response was empty or malformed
- Screens analyzed: ${screens.length}
- Analysis files loaded: ${analysisFiles.length}`);
  }
  
  // Save scope analysis to debug directory (if enabled)
  let scopeAnalysisPath = '';
  if (debugDir) {
    scopeAnalysisPath = path.join(debugDir, 'scope-analysis.md');
    await fs.writeFile(scopeAnalysisPath, scopeAnalysisText, 'utf-8');
  }
  
  // Count feature areas and questions
  const featureAreaMatches = scopeAnalysisText.match(/^### .+$/gm);
  const featureAreasCount = featureAreaMatches
    ? featureAreaMatches.filter(m => !m.includes('Remaining Questions')).length
    : 0;
  
  const questionMatches = scopeAnalysisText.match(/^- ❓/gm);
  const questionsCount = questionMatches ? questionMatches.length : 0;
  
  console.log(`    ✅ Generated: ${featureAreasCount} areas, ${questionsCount} questions`);
  
  await notify(`✅ Feature Identification Complete: ${featureAreasCount} areas, ${questionsCount} questions`);
  
  return {
    scopeAnalysisContent: scopeAnalysisText,
    featureAreasCount,
    questionsCount,
    scopeAnalysisPath
  };
}

/**
 * Phase 6: Update epic with scope analysis
 * 
 * @param params - Parameters for updating the epic
 */
async function updateEpicWithScopeAnalysis({
  epicKey,
  cloudId,
  atlassianClient,
  scopeAnalysisMarkdown,
  contentWithoutScopeAnalysis,
  notify
}: {
  epicKey: string;
  cloudId: string;
  atlassianClient: ToolDependencies['atlassianClient'];
  scopeAnalysisMarkdown: string;
  contentWithoutScopeAnalysis: ADFNode[];
  notify: ToolDependencies['notify'];
}): Promise<void> {

  try {
    // The scope analysis markdown already includes the "## Scope Analysis" header
    // so we don't need to add it again
    
    // Convert the scope analysis to ADF
    const scopeAnalysisAdf = await convertMarkdownToAdf(scopeAnalysisMarkdown);
    
    if (!validateAdf(scopeAnalysisAdf)) {
      console.log('    ⚠️ Failed to convert scope analysis to valid ADF');
      await notify('⚠️ Failed to convert scope analysis to ADF');
      return;
    }
    
    // Combine description (without old scope analysis) with new scope analysis section
    const updatedDescription: ADFDocument = {
      version: 1,
      type: 'doc',
      content: [
        ...contentWithoutScopeAnalysis,
        ...scopeAnalysisAdf.content
      ]
    };
    
    // Update the epic
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
    
    console.log(`    Updating epic description... (${updateResponse.status})`);
    
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
    
    console.log('    ✅ Epic updated');
    
  } catch (error: any) {
    console.log(`    ⚠️ Error updating epic: ${error.message}`);
    await notify(`⚠️ Error updating epic: ${error.message}`);
  }
}

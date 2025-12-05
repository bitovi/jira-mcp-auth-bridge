/**
 * Shared Screen Analysis Pipeline
 * 
 * Reusable functions for phases 1-4 of screen analysis workflow.
 * Used by both write-shell-stories and identify-features tools.
 * 
 * Pipeline:
 * 1. Fetch epic and extract Figma links
 * 2. Setup Figma screens and extract context
 * 3. Download images and analyze screens with AI
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolDependencies } from '../types.js';
import { getDebugDir } from '../writing-shell-stories/temp-directory-manager.js';
import { setupFigmaScreens } from '../writing-shell-stories/figma-screen-setup.js';
import { regenerateScreenAnalyses } from './screen-analysis-regenerator.js';
import type { ADFNode } from '../../../atlassian/markdown-converter.js';

/**
 * Parameters for screen analysis pipeline
 */
export interface ScreenAnalysisPipelineParams {
  epicKey: string;
  cloudId?: string;
  siteName?: string;
  sectionName?: string; // e.g., "Shell Stories" or "Scope Analysis" - section to exclude from epic context
}

/**
 * Result from screen analysis pipeline (phases 1-4)
 */
export interface ScreenAnalysisResult {
  screens: Array<{ name: string; url: string; notes: string[] }>;
  allFrames: any[];
  allNotes: any[];
  figmaFileKey: string;
  debugDir: string | null;
  yamlContent: string;
  epicWithoutShellStoriesMarkdown: string;
  epicWithoutShellStoriesAdf: ADFNode[];
  figmaUrls: string[];
  cloudId: string;
  siteName: string;
  analyzedScreens: number;
}

/**
 * Execute phases 1-4: Setup, Figma extraction, and screen analysis
 * 
 * This shared function handles the common workflow of:
 * - Creating temp directory for artifacts
 * - Fetching epic and extracting Figma links
 * - Setting up Figma screens metadata
 * - Downloading screen images
 * - Analyzing screens with AI
 * 
 * @param params - Pipeline parameters
 * @param deps - Injected dependencies (clients, LLM, notifier)
 * @returns Analysis results ready for subsequent processing
 */
export async function executeScreenAnalysisPipeline(
  params: ScreenAnalysisPipelineParams,
  deps: ToolDependencies
): Promise<ScreenAnalysisResult> {
  const { epicKey, cloudId, siteName, sectionName = 'Shell Stories' } = params;
  const { atlassianClient, figmaClient, generateText, notify } = deps;

  // ==========================================
  // PHASE 1: Get debug directory (DEV mode only)
  // ==========================================
  
  // Get debug directory for artifacts (only in DEV mode)
  const debugDir = await getDebugDir(epicKey);

  // ==========================================
  // PHASE 2-3: Fetch epic, extract context, setup Figma screens
  // ==========================================
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
    yamlContent,
    epicWithoutShellStoriesMarkdown,
    epicWithoutShellStoriesAdf,
    figmaUrls,
    cloudId: resolvedCloudId,
    siteName: resolvedSiteName
  } = setupResult;
  
  await notify(`✅ Preparation Complete: ${screens.length} screens ready`);

  // ==========================================
  // PHASE 4: Download images and analyze screens
  // ==========================================
  
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
  
  await notify(`✅ AI Screen Analysis: Analyzed ${analyzedScreens} screens`);

  // Return all the data needed for subsequent phases
  return {
    screens,
    allFrames,
    allNotes,
    figmaFileKey,
    debugDir,
    yamlContent,
    epicWithoutShellStoriesMarkdown,
    epicWithoutShellStoriesAdf,
    figmaUrls,
    cloudId: resolvedCloudId,
    siteName: resolvedSiteName,
    analyzedScreens
  };
}

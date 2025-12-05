/**
 * Core business logic for write-next-story tool
 * 
 * This module contains the pure business logic for writing the next Jira story
 * from shell stories. It is independent of MCP-specific concerns (authentication,
 * context, etc.) and can be used from both MCP handlers and REST API endpoints.
 * 
 * The logic orchestrates:
 * 1. Setting up Figma screens and fetching epic
 * 2. Extracting and parsing shell stories
 * 3. Finding the next unwritten story
 * 4. Validating dependencies
 * 5. Generating story content with AI
 * 6. Creating Jira issue as subtask with blocker links
 * 7. Updating epic with completion marker
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolDependencies } from '../types.js';
// import type { AtlassianClient } from '../../../atlassian/atlassian-api-client.js';
import type { FigmaClient } from '../../../figma/figma-api-client.js';
import { getDebugDir, getBaseCacheDir } from '../writing-shell-stories/temp-directory-manager.js';
import { getFigmaFileCachePath } from '../../../figma/figma-cache.js';
import { setupFigmaScreens, type FigmaScreenSetupResult } from '../writing-shell-stories/figma-screen-setup.js';
import { regenerateScreenAnalyses } from '../shared/screen-analysis-regenerator.js';
import { parseShellStoriesFromAdf, addCompletionMarkerToShellStory, type ParsedShellStoryADF } from './shell-story-parser.js';
import { 
  generateStoryPrompt, 
  STORY_GENERATION_SYSTEM_PROMPT, 
  STORY_GENERATION_MAX_TOKENS 
} from './prompt-story-generation.js';
import { 
  convertMarkdownToAdf,
  validateAdf,
  type ADFDocument,
} from '../../../atlassian/markdown-converter.js';

/**
 * Parameters for executing the write-next-story workflow
 */
export interface ExecuteWriteNextStoryParams {
  epicKey: string;
  cloudId?: string;
  siteName?: string;
}

/**
 * Result from executing the write-next-story workflow
 */
export interface ExecuteWriteNextStoryResult {
  success: boolean;
  complete?: boolean;      // True when all stories are written
  message?: string;        // Completion message when complete=true
  issueKey?: string;       // Created issue key (present when complete=false)
  issueSelf?: string;      // Created issue URL (present when complete=false)
  storyTitle?: string;     // Created story title (present when complete=false)
  epicKey: string;
}

/**
 * Execute the write-next-story workflow
 * 
 * This is the core business logic that can be called from both MCP handlers and REST API endpoints.
 * It uses dependency injection to abstract away authentication and LLM provider concerns.
 * 
 * @param params - Workflow parameters
 * @param deps - Injected dependencies (clients, LLM, notifier)
 * @returns Result with created issue details
 */
export async function executeWriteNextStory(
  params: ExecuteWriteNextStoryParams,
  deps: ToolDependencies
): Promise<ExecuteWriteNextStoryResult> {
  const { epicKey, cloudId, siteName } = params;
  const { atlassianClient, figmaClient, generateText, notify } = deps;
  
  console.log('executeWriteNextStory called', { epicKey, cloudId, siteName });
  console.log('  Starting next story generation for epic:', epicKey);

  // Step 1: Setup Figma screens and fetch epic
  await notify(`Setting up epic and Figma screens...`);
  const debugDir = await getDebugDir(epicKey);
  
  const setupResult = await setupFigmaScreens({
    epicKey,
    atlassianClient,
    figmaClient,
    debugDir,
    cloudId,
    siteName,
    notify: async (msg) => await notify(msg)
  });
  
  console.log(`  ✅ Setup complete: ${setupResult.screens.length} screens, ${setupResult.figmaUrls.length} Figma URLs`);
  
  // Step 2-3: Extract shell stories from epic
  const shellStories = await extractShellStoriesFromSetup(setupResult, notify);
  console.log(`  Parsed ${shellStories.length} shell stories`);
  
  if (shellStories.length === 0) {
    throw new Error(`
📝 **No Shell Stories Found**

**What happened:**
Epic ${epicKey} has a "## Shell Stories" section, but no stories could be parsed from it

**Possible causes:**
- Shell stories are not in the expected markdown format
- Story IDs are missing backticks (must be \`st001\`, \`st002\`, etc.)
- Missing the ⟩ separator between title and description
- Stories don't start with \`- \` (dash-space)
- Shell stories section is empty

**Expected format:**
Each story must follow this format:
\`\`\`
- \`st001\` **Story Title** ⟩ Brief description
  * SCREENS: [Screen Name](figma-url)
  * DEPENDENCIES: st002, st003
  * ☐ What's included
  * ❌ What's excluded
  * ❓ Open questions
\`\`\`

**Required elements:**
- Start with \`- \` (dash-space)
- Story ID in backticks: \`st001\`, \`st002\`, etc.
- Title (can be bold with \`**Title**\`)
- Separator: ⟩ (right angle quotation mark)
- Description text after separator

**How to fix:**
1. Run \`write-shell-stories\` tool to generate properly formatted stories
2. If manually editing, ensure each story follows the format above
3. Check for missing backticks around story IDs (\`st001\` not st001)
4. Verify the ⟩ separator exists between title and description
5. Make sure stories start with \`- \` (dash-space)

**Technical details:**
- Epic: ${epicKey}
- Shell Stories section exists but parsing returned 0 stories
- Check shell story formatting in epic description
`.trim());
  }
  
  // Step 4: Find next unwritten story
  const nextStory = await findNextUnwrittenStory(shellStories, notify);
  
  if (!nextStory) {
    // All stories complete - return success result
    const completionMessage = `All stories in epic ${epicKey} have been written! 🎉\n\nTotal stories: ${shellStories.length}`;
    console.log(`  ${completionMessage}`);
    await notify(completionMessage);
    
    return {
      success: true,
      complete: true,
      message: completionMessage,
      epicKey
    };
  }
  
  console.log(`  Next story to write: ${nextStory.id} - ${nextStory.title}`);
  
  // Step 5: Validate dependencies
  await validateDependencies(nextStory, shellStories, notify);
  console.log(`  All ${nextStory.dependencies.length} dependencies validated`);
  
  // Step 6: Generate story content
  const storyContent = await generateStoryContent(
    generateText,
    figmaClient,
    setupResult,
    debugDir,
    nextStory,
    shellStories,
    notify
  );
  console.log(`  Story content generated (${storyContent.length} characters)`);
  
  // Step 7: Create Jira issue
  const createdIssue = await createJiraIssue(
    atlassianClient,
    setupResult.cloudId,
    setupResult.epicKey,
    setupResult.projectKey,
    nextStory,
    shellStories,
    storyContent,
    notify
  );
  console.log(`  ✅ Jira issue created: ${createdIssue.key}`);
  
  // Step 8: Update epic with completion marker
  await updateEpicWithCompletion(
    atlassianClient,
    setupResult.cloudId,
    setupResult.epicKey,
    setupResult,
    nextStory,
    createdIssue,
    notify
  );
  console.log(`  ✅ Epic updated with completion marker`);

  return {
    success: true,
    issueKey: createdIssue.key,
    issueSelf: createdIssue.self,
    storyTitle: nextStory.title,
    epicKey: setupResult.epicKey
  };
}

// ============================================================================
// Step Helper Functions (in order of execution)
// ============================================================================

/**
 * Step 2-3: Extract shell stories from epic description
 * Uses ADF parser to preserve all formatting including hardBreak nodes
 */
export async function extractShellStoriesFromSetup(
  setupResult: FigmaScreenSetupResult,
  notify: ToolDependencies['notify']
): Promise<ParsedShellStoryADF[]> {
  await notify('Extracting shell stories...');
  console.log('Extracting shell stories from epic description...');

  // Validate shellStoriesAdf data structure
  if (!Array.isArray(setupResult.shellStoriesAdf)) {
    throw new Error(`Epic ${setupResult.epicKey} has invalid shellStoriesAdf data (expected array, got ${typeof setupResult.shellStoriesAdf})`);
  }

  // Parse shell stories from ADF
  const shellStories = parseShellStoriesFromAdf(setupResult.shellStoriesAdf);
  
  // Validate business logic: at least one story must exist
  if (shellStories.length === 0) {
    throw new Error(`
📝 **Shell Stories Section Missing or Empty**

**What happened:**
Epic ${setupResult.epicKey} does not contain any shell stories

**Possible causes:**
- Shell stories have not been generated yet
- The Shell Stories section is empty
- Epic description was modified incorrectly

**How to fix:**
1. Run the \`write-shell-stories\` tool to generate shell stories
2. Verify the epic description contains "## Shell Stories" section with story content
3. Check that the section wasn't accidentally deleted or modified

**Technical details:**
- Epic: ${setupResult.epicKey}
- Required section: "## Shell Stories"
`.trim());
  }
  
  return shellStories;
}

/**
 * Step 4: Find next unwritten story
 */
export async function findNextUnwrittenStory(
  shellStories: ParsedShellStoryADF[],
  notify: ToolDependencies['notify']
): Promise<ParsedShellStoryADF | undefined> {
  await notify('Finding next unwritten story...');
  return shellStories.find(story => !story.jiraUrl);
}

/**
 * Step 5: Validate dependencies
 * Recursively checks all dependencies and their dependencies
 */
export async function validateDependencies(
  story: ParsedShellStoryADF,
  allStories: ParsedShellStoryADF[],
  notify: ToolDependencies['notify']
): Promise<void> {
  await notify('Validating dependencies...');
  
  const visited = new Set<string>();
  const toCheck = [...story.dependencies];
  
  while (toCheck.length > 0) {
    const depId = toCheck.shift()!;
    
    // Skip if already checked
    if (visited.has(depId)) {
      continue;
    }
    visited.add(depId);
    
    const depStory = allStories.find(s => s.id === depId);
    
    if (!depStory) {
      throw new Error(`
🔗 **Dependency Not Found**

**What happened:**
Dependency "${depId}" referenced by story "${story.id}" does not exist in shell stories

**Possible causes:**
- The dependency ID was misspelled in the shell stories
- The dependency was deleted or renamed
- Shell stories were manually edited incorrectly

**How to fix:**
1. Verify the dependency ID "${depId}" exists in the "## Shell Stories" section
2. Check for typos in the dependency reference
3. If the dependency doesn't exist, remove it from story "${story.id}"
4. Re-run \`write-shell-stories\` if stories were corrupted

**Technical details:**
- Story: ${story.id}
- Missing dependency: ${depId}
- Available stories: ${allStories.map(s => s.id).join(', ')}
`.trim());
    }
    
    if (!depStory.jiraUrl) {
      throw new Error(`
🚧 **Dependency Not Yet Written**

**What happened:**
Story "${story.id}" depends on "${depId}", but that dependency hasn't been written to Jira yet

**Possible causes:**
- Stories are being written out of dependency order
- A previous story creation failed

**How to fix:**
1. Run \`write-next-story\` again to write story "${depId}" first
2. Keep running the tool until all dependencies are satisfied
3. Dependencies will be written in the correct order automatically

**Technical details:**
- Story: ${story.id}
- Unwritten dependency: ${depId}
- The tool will automatically write dependencies in the correct order
`.trim());
    }
    
    // Add dependencies of this dependency to check
    toCheck.push(...depStory.dependencies);
  }
}

/**
 * Step 6: Generate full story content
 * Loads analysis files and uses AI to generate complete Jira story
 * Regenerates missing analysis files automatically
 */
export async function generateStoryContent(
  generateText: ToolDependencies['generateText'],
  figmaClient: FigmaClient,
  setupResult: FigmaScreenSetupResult,
  debugDir: string | null,
  story: ParsedShellStoryADF,
  allStories: ParsedShellStoryADF[],
  notify: ToolDependencies['notify']
): Promise<string> {
  await notify('Generating story content...');
  
  if (debugDir) {
    console.log(`  Using debug directory: ${debugDir}`);
  }
  
  // Construct file cache path for analysis files (always available)
  const fileCachePath = getFigmaFileCachePath(setupResult.figmaFileKey);
  
  // Check which analysis files exist and which are missing
  const screenInfo: Array<{ url: string; name: string; exists: boolean }> = [];
  
  for (const screenUrl of story.screens) {
    const matchingScreen = setupResult.screens.find(s => s.url === screenUrl);
    
    if (!matchingScreen) {
      console.warn(`  ⚠️  Screen URL not found in setup results: ${screenUrl}`);
      continue;
    }
    
    const screenName = matchingScreen.name;
    
    if (fileCachePath) {
      const analysisPath = path.join(fileCachePath, `${screenName}.analysis.md`);
      try {
        await fs.access(analysisPath);
        screenInfo.push({ url: screenUrl, name: screenName, exists: true });
        console.log(`  ✅ Found cached analysis: ${screenName}.analysis.md`);
      } catch {
        screenInfo.push({ url: screenUrl, name: screenName, exists: false });
        console.log(`  ⚠️  Missing analysis: ${screenName}.analysis.md`);
      }
    } else {
      // No file cache - no cached analyses available
      screenInfo.push({ url: screenUrl, name: screenName, exists: false });
    }
  }
  
  // Regenerate missing analyses if needed
  const missingScreens = screenInfo.filter(s => !s.exists);
  
  if (missingScreens.length > 0) {
    console.log(`  Regenerating ${missingScreens.length} missing analysis files...`);
    
    await notify(`Regenerating ${missingScreens.length} missing screen analyses...`);
    
    const screensToAnalyze = setupResult.screens.filter(screen =>
      missingScreens.some(missing => screen.name === missing.name)
    );

    await regenerateScreenAnalyses({
      generateText,
      figmaClient,
      screens: screensToAnalyze,
      allFrames: setupResult.allFrames,
      allNotes: setupResult.allNotes,
      figmaFileKey: setupResult.figmaFileKey,
      epicContext: setupResult.epicWithoutShellStoriesMarkdown,
      notify: async (msg) => await notify(msg)
    });
    
    console.log(`  ✅ Regenerated ${missingScreens.length} analysis files`);
  }
  
  // Load all analysis files from file cache
  const analysisFiles: Array<{ screenName: string; content: string }> = [];
  
  for (const screen of screenInfo) {
    const analysisPath = path.join(fileCachePath, `${screen.name}.analysis.md`);
    
    try {
      const analysisContent = await fs.readFile(analysisPath, 'utf-8');
      analysisFiles.push({ screenName: screen.name, content: analysisContent });
      console.log(`  ✅ Loaded analysis: ${screen.name}.analysis.md`);
    } catch (error: any) {
      console.warn(`  ⚠️  Still missing after regeneration: ${screen.name}.analysis.md`);
    }
  }
  
  if (analysisFiles.length === 0) {
    throw new Error(`
📷 **Screen Analysis Files Missing**

**What happened:**
No screen analysis files are available for story ${story.id}

**Possible causes:**
- Figma images could not be downloaded
- AI analysis failed for all screens
- Temporary files were deleted
- Network or API connectivity issues

**How to fix:**
1. Verify Figma file access and permissions
2. Check that Figma token is still valid
3. Ensure network connectivity to Figma API
4. Retry the operation - analyses will be regenerated automatically
5. Check Anthropic API key if AI analysis is failing

**Technical details:**
- Story: ${story.id}
- Expected screens: ${story.screens.length}
- Attempted to regenerate: ${missingScreens.length} files
- All regeneration attempts failed
`.trim());
  }
  
  console.log(`  Loaded ${analysisFiles.length} total analysis files`);
  
  // Get dependency stories for context
  const dependencyStories = story.dependencies
    .map(depId => allStories.find(s => s.id === depId))
    .filter((s): s is ParsedShellStoryADF => s !== undefined);
  
  console.log(`  Using ${dependencyStories.length} dependency stories for context`);
  
  // Generate prompt
  const storyPrompt = await generateStoryPrompt(story, dependencyStories, analysisFiles, setupResult.epicWithoutShellStoriesMarkdown);
  console.log(`  Generated prompt (${storyPrompt.length} characters)`);
  
  // Request story generation via LLM
  console.log('  🤖 Requesting story generation from AI...');
  const response = await generateText({
    messages: [
      { role: 'system', content: STORY_GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: storyPrompt }
    ],
    maxTokens: STORY_GENERATION_MAX_TOKENS
  });
  
  if (!response.text) {
    throw new Error(`
🤖 **AI Story Generation Failed**

**What happened:**
No story content received from AI for story ${story.id}

**Possible causes:**
- AI service timeout or rate limit
- Invalid prompt or context
- Analysis files may be corrupted
- Network connectivity issues

**How to fix:**
1. Wait a few minutes and retry the operation
2. Verify your Anthropic API key is still valid
3. Check that screen analysis files contain valid content
4. Ensure network connectivity to Anthropic API

**Technical details:**
- Story: ${story.id}
- Story title: ${story.title}
- Analysis files loaded: ${analysisFiles.length}
- AI response was empty or malformed
`.trim());
  }
  
  console.log(`  ✅ Story generated (${response.text.length} characters)`);
  
  return response.text;
}

/**
 * Step 7: Create Jira issue
 * Converts markdown to ADF, creates issue as subtask of epic, adds blocker links
 */
export async function createJiraIssue(
  atlassianClient: ToolDependencies['atlassianClient'],
  cloudId: string,
  epicKey: string,
  projectKey: string,
  story: ParsedShellStoryADF,
  allStories: ParsedShellStoryADF[],
  storyContent: string,
  notify: ToolDependencies['notify']
): Promise<{ key: string; self: string }> {
  await notify('Creating Jira issue...');
  
  console.log(`  Converting story to ADF...`);
  
  // Convert markdown to ADF
  const adfDocument = await convertMarkdownToAdf(storyContent);
  console.log(`  ✅ Converted to ADF (${JSON.stringify(adfDocument).length} characters)`);
  
  // Validate ADF
  const isValid = validateAdf(adfDocument);
  if (!isValid) {
    throw new Error(`
📄 **Invalid Story Format Generated**

**What happened:**
The AI-generated story content could not be converted to valid Jira format (ADF)

**Possible causes:**
- AI generated malformed markdown
- Conversion process encountered unexpected content
- Story content contains unsupported formatting

**How to fix:**
1. Retry the operation - the AI may generate valid content on retry
2. Check if the story ${story.id} has unusual formatting requirements
3. Review the shell story definition for issues
4. Contact support if the problem persists

**Technical details:**
- Story: ${story.id}
- ADF validation failed
- Content length: ${storyContent.length} characters
`.trim());
  }
  console.log(`  ✅ ADF validated successfully`);
  
  // Get the Story issue type ID from the project
  console.log(`  Fetching issue types for project ${projectKey}...`);
  const metadataUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`;
  const metadataResponse = await atlassianClient.fetch(metadataUrl, {
    headers: {
      'Accept': 'application/json'
    }
  });
  
  if (!metadataResponse.ok) {
    const errorText = await metadataResponse.text();
    throw new Error(`
🔧 **Failed to Fetch Jira Metadata**

**What happened:**
Could not retrieve issue type information from project ${projectKey}

**Possible causes:**
- Jira token expired or invalid
- Project doesn't exist or was moved
- Insufficient permissions on the project
- Network connectivity issues

**How to fix:**
1. Verify the project key "${projectKey}" is correct
2. Check that your Jira token hasn't expired
3. Ensure you have "Create Issues" permission on project ${projectKey}
4. Verify network connectivity to Jira

**Technical details:**
- Project: ${projectKey}
- Status: ${metadataResponse.status}
- Error: ${errorText}
`.trim());
  }
  
  const metadata = await metadataResponse.json() as any;
  const project = metadata.projects?.[0];
  
  // Try to find Story issue type, fallback to Task if not available
  let issueType = project?.issuetypes?.find((it: any) => it.name === "Story");
  
  if (!issueType) {
    console.log(`  Story issue type not found, falling back to Task...`);
    issueType = project?.issuetypes?.find((it: any) => it.name === "Task");
  }
  
  if (!issueType) {
    const availableTypes = project?.issuetypes?.map((it: any) => it.name).join(', ') || 'none';
    throw new Error(`
🎫 **No Suitable Issue Type Found**

**What happened:**
Project ${projectKey} doesn't have "Story" or "Task" issue types available

**Possible causes:**
- Project uses custom issue types
- Issue types were renamed or removed
- Insufficient permissions to create these issue types
- Project configuration changed

**How to fix:**
1. Check your project's issue type configuration in Jira
2. Ensure "Story" or "Task" issue types exist
3. Verify you have permission to create these issue types
4. Contact your Jira administrator if issue types were customized

**Technical details:**
- Project: ${projectKey}
- Available issue types: ${availableTypes}
- Looking for: "Story" or "Task"
`.trim());
  }
  
  console.log(`  Found ${issueType.name} issue type with ID: ${issueType.id}`);
  
  // Create issue payload
  const issuePayload = {
    fields: {
      project: { key: projectKey },
      parent: { key: epicKey },
      summary: story.title,
      description: adfDocument,
      issuetype: { id: issueType.id }
    }
  };
  
  console.log(`  Creating Jira issue in project ${projectKey}...`);
  console.log(`  Summary: "${story.title}"`);
  
  // Create issue
  const createUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`;
  const createResponse = await atlassianClient.fetch(createUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(issuePayload)
  });
  
  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    console.error(`  ❌ Jira API error response:`, errorText);
    throw new Error(`
❌ **Failed to Create Jira Issue**

**What happened:**
Could not create Jira story for "${story.title}"

**Possible causes:**
- Jira token expired or invalid
- Insufficient permissions to create issues
- Required fields are missing or invalid
- Project configuration changed
- Epic ${epicKey} doesn't exist or is not an Epic type

**How to fix:**
1. Verify your Jira token is still valid
2. Check that you have "Create Issues" permission on project ${projectKey}
3. Ensure epic ${epicKey} exists and is an Epic issue type
4. Verify all required fields for ${projectKey} are satisfied
5. Check Jira project settings for any required custom fields

**Technical details:**
- Story: ${story.id}
- Title: ${story.title}
- Epic: ${epicKey}
- Status: ${createResponse.status} ${createResponse.statusText}
- Error: ${errorText}
`.trim());
  }
  
  const createdIssue = await createResponse.json() as { key: string; self: string };
  console.log(`  ✅ Created issue: ${createdIssue.key}`);
  
  // Add blocker links for dependencies
  if (story.dependencies.length > 0) {
    console.log(`  Adding ${story.dependencies.length} dependency blocker links...`);
    
    for (const depId of story.dependencies) {
      const depStory = allStories.find(s => s.id === depId);
      
      if (!depStory || !depStory.jiraUrl) {
        console.warn(`  ⚠️  Dependency ${depId} has no Jira URL, skipping link`);
        continue;
      }
      
      // Extract issue key from Jira URL
      const keyMatch = depStory.jiraUrl.match(/browse\/([A-Z]+-\d+)/);
      if (!keyMatch) {
        console.warn(`  ⚠️  Could not extract issue key from URL: ${depStory.jiraUrl}`);
        continue;
      }
      
      const depKey = keyMatch[1];
      
      // Create blocker link
      const linkPayload = {
        type: { name: "Blocks" },
        inwardIssue: { key: createdIssue.key },
        outwardIssue: { key: depKey }
      };
      
      const linkUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issueLink`;
      const linkResponse = await atlassianClient.fetch(linkUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(linkPayload)
      });
      
      if (!linkResponse.ok) {
        const errorText = await linkResponse.text();
        console.warn(`  ⚠️  Failed to create blocker link to ${depKey}: ${linkResponse.status} ${errorText}`);
      } else {
        console.log(`  ✅ Added blocker link: ${depKey} blocks ${createdIssue.key}`);
      }
    }
  }
  
  return createdIssue;
}

/**
 * Step 8: Update epic with completion marker
 * Updates the shell story in the epic description: adds Jira link and timestamp using ADF operations
 */
export async function updateEpicWithCompletion(
  atlassianClient: ToolDependencies['atlassianClient'],
  cloudId: string,
  epicKey: string,
  setupResult: FigmaScreenSetupResult,
  story: ParsedShellStoryADF,
  createdIssue: { key: string; self: string },
  notify: ToolDependencies['notify']
): Promise<void> {
  await notify('Updating epic with completion marker...');
  console.log('Adding completion marker to shell story...');
  
  // Construct Jira URL
  const jiraUrl = `https://bitovi.atlassian.net/browse/${createdIssue.key}`;
  
  // Add completion marker to shell stories ADF
  let updatedShellStories;
  try {
    updatedShellStories = addCompletionMarkerToShellStory(
      setupResult.shellStoriesAdf,
      story.id,
      createdIssue.key,
      jiraUrl
    );
  } catch (err: any) {
    throw new Error(
      `✅ Story ${createdIssue.key} was created, but failed to update the epic with a completion marker for shell story ID "${story.id}".\n` +
      `Reason: ${err && err.message ? err.message : err}`
    );
  }
  
  console.log(`  Updated story ${story.id} in ADF`);
  
  // Rebuild epic description: epic context + updated shell stories
  const updatedAdfDoc: ADFDocument = {
    version: 1,
    type: 'doc',
    content: [
      ...setupResult.epicWithoutShellStoriesAdf,
      ...updatedShellStories
    ]
  };
  
  console.log(`  Rebuilt full epic description in ADF`);
  
  // Validate ADF structure
  if (!validateAdf(updatedAdfDoc)) {
    throw new Error(`
📄 **Invalid Epic Format Generated**

**What happened:**
Updated epic description has invalid ADF structure

**Possible causes:**
- ADF manipulation error when updating epic
- Epic description contains malformed ADF nodes
- Shell Stories section has invalid structure

**How to fix:**
1. Story ${createdIssue.key} was created successfully
2. Manually add the Jira link to story ${story.id} in epic ${epicKey}
3. Check epic description for formatting issues
4. Contact support if the problem persists

**Technical details:**
- Epic: ${epicKey}
- Created story: ${createdIssue.key}
- Story ID: ${story.id}
- ADF validation failed
`.trim());
  }
  
  console.log(`  Updating epic ${epicKey} via Jira API...`);
  
  // Update epic via Jira API
  const updateUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${epicKey}`;
  const updateResponse = await atlassianClient.fetch(updateUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      fields: {
        description: updatedAdfDoc
      }
    })
  });
  
  if (!updateResponse.ok) {
    const errorText = await updateResponse.text();
    throw new Error(`
❌ **Failed to Update Epic**

**What happened:**
Could not update epic ${epicKey} with completion marker for story ${story.id}

**Possible causes:**
- Jira token expired during operation
- Insufficient permissions to edit the epic
- Epic was locked or being edited by another user
- Network connectivity issues

**How to fix:**
1. Story ${createdIssue.key} was created successfully
2. Manually add the Jira link to story ${story.id} in epic ${epicKey}
3. Verify you have "Edit Issues" permission on epic ${epicKey}
4. Check if epic is locked or has edit restrictions
5. Retry the operation

**Technical details:**
- Epic: ${epicKey}
- Created story: ${createdIssue.key}
- Story ID: ${story.id}
- Status: ${updateResponse.status} ${updateResponse.statusText}
- Error: ${errorText}
`.trim());
  }
  
  console.log(`  ✅ Epic ${epicKey} updated successfully`);
}

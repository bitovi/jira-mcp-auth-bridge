# Write Next Story Tool - Implementation Plan

## Overview

This tool writes the next Jira story from a list of shell stories in an epic. It ensures dependencies are up-to-date before writing, and marks completed stories with Jira links and timestamps.

## Tool Specification

**Tool Name**: `write-epics-next-story`

**Required Arguments**:
- `epicKey` - The Jira epic key (e.g., "PROJ-123")

**Optional Arguments**:
- `siteName` - Name of the Jira site
- `cloudId` - Cloud ID of the Jira site

## High-Level Workflow

1. **Fetch Epic** - Get epic description containing shell stories
2. **Find Next Story** - Identify first unwritten shell story
3. **Validate Dependencies** - Ensure dependency stories exist and are written (MVP: basic check only)
4. **Generate Story** - Create full Jira story using AI
5. **Create Jira Issue** - Post story as new Jira issue
6. **Update Epic** - Mark shell story as completed with link and timestamp

**Future Enhancement** (Step 11): Add advanced dependency validation with timestamp checking and automatic regeneration of stale dependencies.

## Detailed Implementation Steps

### Step 1: Create Tool Registration

**What to do**: 
- Create new file `server/providers/combined/tools/writing-shell-stories/write-next-story.ts`
- Follow the pattern from `write-shell-stories.ts` and `atlassian-get-issue.ts`
- Register tool with MCP server similar to other tools

**Files to reference**:
- `server/providers/combined/tools/writing-shell-stories/write-shell-stories.ts` (lines 127+)
- `server/providers/atlassian/tools/atlassian-get-issue.ts` (lines 43+)

**How to verify**:
- Run `npm run start-local`
- Tool appears in MCP tool list
- Can call tool with epicKey parameter (even if not fully implemented)

### Step 2: Fetch Epic and Extract Shell Stories

**What to do**:
- Use `getAuthInfoSafe()` to get Atlassian token
- Use `resolveCloudId()` to get cloud ID
- Use `getJiraIssue()` to fetch epic with: `fields=description,summary,project,key` (no changelog needed for MVP)
- Extract project key from epic response for use in Step 7
- Use `convertAdfToMarkdown()` to convert epic description to markdown
- Parse markdown to extract Shell Stories section

**Required utilities** (already exist):
- `getAuthInfoSafe()` from `mcp-core/auth-helpers.ts`
- `resolveCloudId()` from `atlassian-helpers.ts`
- `getJiraIssue()` from `atlassian-helpers.ts` - Pass `fields=description,summary,project,key`
- `convertAdfToMarkdown()` from `markdown-converter.ts`

**How to verify**:
- Log the epic description markdown
- Confirm Shell Stories section is present
- Parse and log shell story titles as array
- Verify project key extracted (e.g., "PROJ" from "PROJ-123")

### Step 3: Parse Shell Stories Structure

**What to do**:
- Create parser function to extract individual shell stories from markdown
- Each story has format: `` `st001` **[Title](url)** – Description _timestamp_ ``
- Extract: story ID, title, Jira URL (if present), timestamp (if present)
- Parse sub-bullets: SCREENS, DEPENDENCIES, ✅, ❌, ❓

**Data structure to create**:
```typescript
interface ParsedShellStoryMarkdown {
  id: string;              // "st001"
  title: string;           // Story title
  description: string;     // One-sentence description
  jiraUrl?: string;        // URL if already written
  timestamp?: string;      // ISO 8601 timestamp if written
  screens: string[];       // Figma URLs
  dependencies: string[];  // Array of story IDs
  included: string[];      // ✅ bullets
  excluded: string[];      // ❌ bullets
  questions: string[];     // ❓ bullets
  rawContent: string;      // Full markdown for this story
}
```

**How to verify**:
- Parse test epic with multiple stories
- Log parsed structure for each story
- Verify all fields are correctly extracted
- Test with stories that have Jira URLs and without

### Step 4: Find Next Unwritten Story

**What to do**:
- Iterate through parsed shell stories
- Find first story where `jiraUrl` is undefined/empty
- This becomes `storyToWrite`

**Edge cases to handle**:
- All stories already written → return message "All stories complete"
- No shell stories found → return error
- Epic missing Shell Stories section → return error

**How to verify**:
- Create test epic with mix of written/unwritten stories
- Confirm correct story is identified
- Test edge cases above

### Step 5: Validate Dependencies (MVP - Basic Validation Only)

**What to do**:
For each dependency story ID in `storyToWrite.dependencies`:
1. Find the dependency in parsed stories array
2. If dependency not found → return error "Dependency {id} not found in shell stories"
3. If dependency not yet written (no `jiraUrl`) → return error "Dependency {id} must be written before {storyToWrite.id}"
4. If dependency has `jiraUrl` → Continue (assume it's up-to-date)

**MVP Scope**:
- Only validate that dependencies exist and have been written
- Do NOT check timestamps or fetch changelog
- Do NOT regenerate dependency content
- Assume all written dependencies are current

**Future Enhancement** (see Step 11):
- Add timestamp comparison using changelog
- Implement dependency regeneration workflow
- Update stale dependencies automatically

**How to verify**:
- Test with story that has dependencies
- Verify error when dependency not written
- Verify success when all dependencies have Jira URLs
- Confirm no changelog fetching occurs

### Step 6: Generate Full Story Content

**What to do**:
- Create prompt for AI to generate full Jira story
- Use story writing guidelines from Bitovi
- Include context from: shell story content, dependency stories, screen analysis files

**Loading screen analysis files**:
- Extract screen names from SCREENS bullets (use link text as analysis file identifier)
- Check temp folder for existing `.analysis.md` files (from previous `write-shell-stories` run)
- If analysis files missing:
  - Download Figma images for those screens (needed for AI analysis)
  - Regenerate analysis files using shared helper (see Considerations)
  - Both images and analysis files remain in temp cache
- Reusable helper should support both this tool and other future tools
- Note: We don't send Figma images as context to story generation prompt (see Q16)
- Temp cache cleanup happens automatically on timeout (managed by existing cleanup process)

**Prompt should include**:
- Shell story details (✅ ❌ ❓ bullets)
- Dependency story summaries (for context) - just shell story content, not full Jira descriptions
- Screen analysis files referenced in SCREENS bullets
- Story writing format requirements (loaded from `story-writing-guidelines.md`)
- Nested Gherkin format for acceptance criteria

**Note**: Figma images are NOT included in the prompt (see Q16). Images are only used to generate analysis files if they're missing.

**Required sections** (per spec):
1. User Story (As a … I want … so that …)
2. Supporting Artifacts
3. Out of Scope
4. Non-Functional Requirements
5. Developer Notes
6. Acceptance Criteria (nested Gherkin with Figma images)

**How to verify**:
- Generate story for simple test case
- Check all required sections present
- Verify Figma images embedded in acceptance criteria (as links from analysis files)
- Validate Gherkin format (**GIVEN**, **WHEN**, **THEN** bolded)
- Confirm no speculative features added
- Test with missing analysis files to verify regeneration works (images downloaded, analysis created, both cached)
- Test with cached analysis files to verify reuse works (no regeneration needed)
- Verify temp cache cleanup happens automatically on timeout

### Step 7: Create Jira Issue

**What to do**:
- Convert generated markdown story to ADF using `convertMarkdownToAdf()`
- Validate ADF using `validateAdf()`
- Extract project key from epic (see Q11 for approach)
- Create new Jira issue as subtask of epic
- Use Jira REST API: `POST /rest/api/3/issue`
- After creation, add blocker links for all immediate dependencies

**Issue payload structure**:
```typescript
{
  fields: {
    project: { key: projectKey },  // Extract from epic in Step 2
    parent: { key: epicKey },
    summary: storyToWrite.title,
    description: adfDocument,
    issuetype: { name: "Story" }
  }
}
```

**Adding blocker relationships**:
- After issue is created, iterate through `storyToWrite.dependencies`
- For each dependency that has a `jiraUrl`, extract the issue key
- Create "is blocked by" link using: `POST /rest/api/3/issueLink`
- Link payload structure:
```typescript
{
  type: {
    name: "Blocks"  // This creates "dependency blocks new story" relationship
  },
  inwardIssue: {
    key: newStoryKey  // The story we just created
  },
  outwardIssue: {
    key: dependencyKey  // The dependency story
  }
}
```
- Note: "Blocks" link type is standard in Jira Cloud, but verify availability

**How to verify**:
- Create test issue in Jira
- Verify it appears as subtask of epic
- Check description renders correctly
- Confirm all formatting preserved
- Verify blocker links created for all dependencies
- Check that blocking relationships display correctly in Jira UI
- Confirm link direction is correct (dependencies block the new story)

### Step 8: Update Epic with Completion Marker

**What to do**:
- Get current epic description (ADF format) from Step 2
- Traverse ADF to find the Shell Stories section
- Within that section, find the specific shell story list item by story ID (`` `st001` ``)
- Update the ADF nodes to add Jira link and timestamp
- Update epic using Jira API directly with modified ADF

**ADF Update Strategy** (avoid markdown conversion):
- Work directly with ADF document structure
- Shell story entries are list items (`bulletList` → `listItem` nodes)
- Find list item containing the story ID as inline code (`` `st001` ``)
- Update text nodes to wrap title in link mark
- Add timestamp as text node with emphasis mark
- Pattern: `inlineCard` or `text` with `link` mark for URL

**Alternative approach** (if ADF manipulation is complex):
- Extract just the Shell Stories section to markdown using `convertAdfToMarkdown()`
- Update the markdown for that one story entry
- Convert updated section back to ADF using `convertMarkdownToAdf()`
- Replace the Shell Stories section in the original ADF
- This limits conversion scope to just the section being modified

**Timestamp format**:
- Use ISO 8601 with timezone: `new Date().toISOString()`
- Example: `2025-10-23T14:30:00Z`
- Wrap in emphasis/italic: `_2025-10-23T14:30:00Z_`

**How to verify**:
- Check epic description updated in Jira
- Verify link is clickable and points to new story
- Confirm timestamp is parsable by JS: `new Date(timestamp)`
- Verify other stories in the list remain unchanged
- Test with multiple updates to ensure no corruption

### Step 9: Error Handling and Edge Cases

**What to do**:
- Handle missing dependencies gracefully
- Validate shell story format before processing
- Handle Jira API errors (auth, network, validation)
- Provide clear error messages for each failure mode

**Error scenarios to handle**:
- Epic not found
- Epic has no Shell Stories section
- No unwritten stories found
- Dependency not found
- Dependency not yet written
- Failed to fetch dependency from Jira
- Failed to create Jira issue
- Failed to update epic

**How to verify**:
- Test each error scenario
- Confirm meaningful error messages returned
- Verify partial operations don't corrupt epic

### Step 10: Integration Testing

**What to do**:
- Create end-to-end test with real epic
- Run full workflow from fetch to epic update
- Verify second run picks up next story
- Test basic dependency validation

**Test scenarios**:
1. Write first story (no dependencies)
2. Write second story (depends on first)
3. Verify third story (depends on first and second)
4. Test error: story with unwritten dependency

**How to verify**:
- All stories created successfully
- Epic properly updated after each story
- Dependencies validated correctly (exist and have Jira URLs)
- Error handling works for unwritten dependencies

### Step 11: Future Enhancement - Advanced Dependency Validation

**What to do** (implement after MVP is working):
For each dependency story ID in `storyToWrite.dependencies`:
1. Fetch the Jira issue using `getJiraIssue()` with `expand=changelog&fields=description,summary,updated,project`
2. Extract the most recent update timestamp: `changelog.histories[0].created`
3. Compare with dependency's `timestamp` in shell story
4. If Jira issue updated more recently → regenerate dependency content

**Dependency Regeneration Workflow**:
- Create new prompt to extract scope from existing Jira story
- Prompt should read story description and extract:
  - What's in scope (implemented features)
  - What's out of scope (deferred features)
  - Key functionality summary
- Load dependency's SCREENS from shell story
- Re-analyze those specific screens (may already be cached)
- Generate new shell story content for ONLY that dependency
- Update the dependency's entry in epic's Shell Stories section
- Update timestamp to match Jira's latest update
- If Jira description differs, update the Jira issue description too

**New prompt requirements**:
- Read existing Jira story (including Figma references)
- Extract in-scope vs out-of-scope items
- Summarize implementation details
- Format as shell story bullets (✅ ❌ ❓)

**How to verify**:
- Manually update a dependency story in Jira
- Run tool on story that depends on it
- Verify regeneration is triggered
- Confirm epic updated with new content and timestamp
- Confirm Jira issue description updated if content changed

## Questions

**Q1**: Should we regenerate dependency stories automatically, or ask the user first?

Automatically.  There is no way to ask the user. 

**Q2**: When regenerating a dependency's shell story content, should we only update the content in the epic's Shell Stories section, or also update the actual Jira issue description?

Update the description too if it has changed.

**Q3**: If a dependency story has changed in Jira but the changes don't affect our current story, should we still regenerate? Or should we do a smart diff?

Always regenerate if the timestamp doesn't match. We can't know if changes affect the current story without doing the full analysis anyway. The dependency relationship exists because it's a blocker - any changes to blockers should be reflected in dependent stories. Simpler to always regenerate than to try to determine impact.

**Q4**: What should happen if screen analysis files referenced in SCREENS bullets don't exist or can't be loaded?

We should error and let people know the problem.

**Q5**: Should the tool support creating the Jira issue as a "Story" or should the issue type be configurable?

Story for now.  Configurable later.


**Q6**: For the story generation prompt, should we load ALL dependency stories' full content, or just their summaries? (Could be a lot of tokens)

Just the shell story summaries. 

**Q7**: For changelog comparison, should we look at ANY update to the Jira issue, or only specific field changes (like description updates)? The changelog includes all changes (status, assignee, comments, etc.)

Is it harder to look for just description and summary updates?

**Answer**: Looking at specific fields requires filtering `changelog.histories[].items[]` array for items where `field === 'description'` or `field === 'summary'`. Looking at ANY update just uses `changelog.histories[0].created`. The filtered approach is slightly more complex but more precise. Since you asked about difficulty - filtering is straightforward: just iterate through items and check the field name. **Recommendation**: Start with ANY update (simpler), then refine to description/summary-only if you get false positives from status changes.

Yes, the changelog is also paginated.  So you might have to go back to find if a description or summary had been updated.

**DECISION**: Use Option A - Just use `changelog.histories[0].created` for ANY update. No pagination handling needed. Simpler implementation. 

**Q8**: When using `getJiraIssue()` with `expand=changelog`, should we also specify which fields to return to optimize the response size, or fetch all fields?

If we can specify description and summary, that's all we need I believe.

**Answer**: Yes, you can use `fields=description,summary,updated,project` parameter. This reduces payload size significantly.

**Q9**: For Step 8 (updating epic with completion marker), should we work directly with ADF structure or use the hybrid approach (convert just Shell Stories section to markdown, update, convert back)? Direct ADF manipulation is more efficient but more complex. The hybrid approach is safer but does roundtrip conversion.

Which is easier?  Lets start with whatever is easier to accomplish.

**Answer**: Hybrid approach is easier. The markdown format is simple and predictable: `` `st001` **Title** – Description`` becomes `` `st001` **[Title](url)** – Description _timestamp_``. With ADF you'd need to navigate bulletList → listItem → paragraph → text/link/emphasis nodes. **Recommendation**: Use hybrid approach (extract section, update markdown, replace section).

**Q10**: When regenerating a dependency's shell story content in Step 5, should we use the same prompts and process as `write-shell-stories` tool? This would mean re-analyzing screens and generating shell story content for just that ONE story.

No, we will need to use a different prompt.  It will have to read the story (including any figma references in that story) and extract out what's in and out of scope and summarize that. We should do this later in the plan.

**DECISION**: Move dependency validation and regeneration to end of plan as a future enhancement. For MVP implementation:
- **Skip Step 5 entirely** - Don't check dependency timestamps
- Assume all dependencies are up-to-date
- Only verify dependencies exist and have Jira URLs (are written)
- Add full dependency validation/regeneration as final step in plan after core functionality works 

**Q11**: For Step 7, how do we extract the project key from the epic? Should we fetch the epic's project field in Step 2, or parse it from the epicKey (e.g., "PROJ-123" → "PROJ")?

Yes, exactly.

**Q12**: Should this tool provide progress notifications like `write-shell-stories` does using `createProgressNotifier`? This could be helpful for long-running operations like regenerating dependencies.

yes.

**Q13**: If creating the Jira issue succeeds (Step 7) but updating the epic fails (Step 8), we have an orphaned story. Should we: a) Try to delete the created issue, b) Continue anyway and log the error, or c) Leave the story created but warn the user to manually update the epic?

Warn the user.



**Q14**: When including dependency story content in the prompt (Step 6), should we include: a) Just the shell story content from the epic, or b) The full Jira issue description from the dependency story?

I hope that the shell story is enough. Lets start with that.

**Q15**: The temp folder references in Step 6 - is this the same temp folder from `getTempDir()` in `write-shell-stories.ts`? Should we document the temp folder lifecycle (creation, persistence, cleanup)?


**Answer**: Already documented in the **"Important Implementation Details" → "Temp Folder Management"** section below. This section explains:
- Use `getTempDir()` helper for consistent location
- What files are stored (`.analysis.md` files and Figma images)
- That files persist across tool invocations (cached for reuse)
- Filename patterns for analysis files and images

This is for the developers implementing this tool - it's in this spec document.

**Q16**: In the Considerations section, you ask "should we also provide the images as context to the AI when writing the stories?" - Do you want to include Figma images in the story generation prompt, or only link to them in the acceptance criteria? 

We won't send images as context for now. We might change that later. 

## Story Writing Format Requirements

Story writing guidelines are maintained in: `server/providers/combined/tools/write-next-story/story-writing-guidelines.md`

This file will be loaded at runtime and embedded in the story generation prompt.

**Source**: https://bitovi.atlassian.net/wiki/spaces/agiletraining/pages/401113200/Story+Writing

**Key sections in the guidelines**:
1. User Story Statement (As a … I want … so that …)
2. Supporting Artifacts (Figma links, analysis files)
3. Out of Scope (❌ bullets from shell story)
4. Non-Functional Requirements
5. Developer Notes (technical dependencies)
6. Acceptance Criteria (nested Gherkin format)

See the `story-writing-guidelines.md` file for complete details on format, syntax, and constraints.


## Considerations

- For now, we should link to the figma screen that best shows the state of the application. Later, I'd like to be able to go within the screens contents and focus on the particular elements that need to be implement.  

- We might not have the screen analysis files to send to the writing stories prompt.  We should check if they are in the temporary folder, but if they are not, we will need to regenerate.  We should make the re-download and build analysis helper in such a way that multiple tools can use it.  We should be able to identify the name of the analysis file from the title of the link in the `SCREENS:` section.

- Figma images are downloaded when analysis files need to be regenerated. Images are used by AI to create the `.analysis.md` files, but are NOT sent as context to the story generation prompt. Both images and analysis files persist in the temp cache folder and are cleaned up together on timeout (automatic periodic cleanup).

## Important Implementation Details

### Temp Folder Management
- Use `getTempDir()` helper from `write-shell-stories.ts` for consistent temp folder location
- Temp folder contains: `.analysis.md` files and Figma images (both cached together)
- All files persist across tool invocations (cached for reuse)
- Automatic cleanup: Temp folder cleaned up on timeout (existing periodic cleanup process)
- Screen analysis filename pattern: `{screen-name}.analysis.md` (match link text from SCREENS bullets)
- Figma images: Downloaded when generating analysis files, persist in cache with analysis files

### Story Generation Prompt Structure
- Load story writing guidelines from `story-writing-guidelines.md` file in tool folder
- Include shell story full content (✅ ❌ ❓ bullets)
- Include dependency shell story summaries (just the shell story content from epic, not full Jira descriptions)
- Include screen analysis file contents
- Do NOT include Figma images as context (see Q16) - images only used for generating analysis files
- Embed complete guidelines in prompt (not just URLs)
- Emphasize evidence-based approach (no speculation)

### Progress Notifications
- Consider using `createProgressNotifier()` like `write-shell-stories` does
- Key progress points: Fetching epic, validating dependencies, regenerating dependencies, generating story, creating issue, updating epic
- Helps users understand long-running operations

### Error Recovery Strategy
- If Step 7 (create issue) succeeds but Step 8 (update epic) fails → see Q13 for approach
- Log all errors with context (epic key, story ID, operation that failed)
- Partial success states should be clearly communicated to user  

## Implementation

## Plan

## Questions



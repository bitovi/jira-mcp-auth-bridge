# ADF Native Processing Refactor - Implementation Plan

## Overview

Currently, several APIs like `write-next-story` and `write-shell-stories` convert ADF content from Jira to Markdown, make changes in Markdown, then convert back to ADF before pushing to Jira. This round-trip conversion causes data loss, particularly when users create unbulleted lines within bulleted lists using Shift+Enter (which creates `hardBreak` nodes in ADF that don't survive Markdown conversion).

This plan refactors the codebase to work directly with ADF format, eliminating lossy conversions.

## Problem Statement

### Current Flow (Lossy)
1. Fetch ADF content from Jira API (`description` field)
2. Convert ADF → Markdown using `convertAdfToMarkdown()`
3. Parse/manipulate Markdown strings
4. Convert Markdown → ADF using `convertMarkdownToAdf()` 
5. Push ADF back to Jira

**Data Loss**: Shift+Enter line breaks (ADF `hardBreak` nodes) within bullet lists are lost because:
- Markdown doesn't distinguish between soft breaks and hard breaks within list items
- The `marklassian` library may not preserve these nuances
- Round-trip conversion flattens formatting that doesn't map cleanly to Markdown

### Desired Flow (Native ADF)
1. Fetch ADF content from Jira API
2. Parse/manipulate ADF nodes directly
3. Push ADF back to Jira

**Preserve**: All ADF node types including `hardBreak`, nested lists, marks (bold, italic), inline cards, mentions, etc.

## Current State Analysis

### Files Using Markdown Conversion

**Core Business Logic** (must be refactored):
- `server/providers/combined/tools/write-next-story/core-logic.ts`
  - Line 554: `convertMarkdownToAdf(storyContent)` - creating new issue description
  - Line 835: `convertMarkdownToAdf(updatedEpicMarkdown)` - updating epic with completion marker
  
- `server/providers/combined/tools/writing-shell-stories/core-logic.ts`
  - Line 381: `convertMarkdownToAdf(shellStoriesSection)` - converting generated shell stories
  - Line 415: `convertAdfToMarkdown(scopeAnalysisDoc)` - extracting scope analysis
  
- `server/providers/combined/tools/writing-shell-stories/figma-screen-setup.ts`
  - Line 339: `convertAdfToMarkdown(description)` - converting full epic to Markdown
  - Line 367: `convertAdfToMarkdown({...})` - converting epic context
  - Line 361: `removeADFSectionByHeading()` - ADF manipulation (keep this pattern!)
  
- `server/providers/combined/tools/write-next-story/shell-story-parser.ts`
  - Parses shell stories from Markdown strings (entire file must be refactored)

**Utility/Test Files** (can keep for debugging):
- `server/providers/combined/tools/analyze-feature-scope/core-logic.ts`
- Test files in `__tests__/`

### Existing ADF Utilities (Can Build Upon)

**Already Available**:
- `extractFigmaUrlsFromADF()` - traverses ADF nodes to find Figma URLs
- `removeADFSectionByHeading()` - removes sections by heading text (KEEP THIS PATTERN)
- ADF type definitions in `markdown-converter.ts`:
  - `ADFDocument`
  - `ADFNode`
  - `ADFTextNode`
  - `ADFParagraph`

## Design Decisions

### AI Prompt Format: Markdown vs ADF JSON

**Decision**: Use Markdown for AI prompts, ADF for all data manipulation (Option A)

**Context**: LLMs can accept either Markdown or ADF JSON for prompts. Analysis of 12 shell stories with Claude Sonnet 3.5:

| Format | Tokens | Annual Cost* | Overhead |
|--------|--------|--------------|----------|
| **Markdown** | ~984 | **$54** | baseline |
| ADF (compact) | ~3,852 | $211 | +291% (+$157) |
| ADF (pretty) | ~11,796 | $646 | +1,099% (+$592) |

*50 calls/day at $3/1M input tokens

**Rationale**:
1. **Cost**: 3-4x lower token costs ($157-592/year savings)
2. **AI Performance**: LLMs trained extensively on Markdown
3. **No Data Loss**: One-way ADF→Markdown conversion for reading only (never converted back)
4. **Simplicity**: Easier to debug and iterate on prompts

**Implementation**:
- `convertAdfToMarkdown()` used only in `prepareAIPromptContext()` for prompt generation
- All Jira data manipulation uses ADF operations (no round-trips)
- AI-generated Markdown → convert once to ADF → push to Jira
- `_AIPromptOnly` suffix on function names and field names to prevent misuse

## Implementation Steps

### Step 1: Rename Conversion Functions (optional, later)

**Part A: Rename Conversion Functions**

**File**: `server/providers/atlassian/markdown-converter.ts`

<!-- **Rename 1: `convertMarkdownToAdf()` → `convertMarkdownToAdf()`**
 -->


**Rename: `convertAdfToMarkdown()` → `convertAdfToMarkdownForAIPrompt()`**

- Rename function from `convertAdfToMarkdown()` to `convertAdfToMarkdownForAIPrompt()`
- Update JSDoc comment:
  ```typescript
  /**
   * Converts ADF to Markdown for AI prompt generation ONLY.
   * 
   * ⚠️ NEVER use for data manipulation or Jira updates.
   * This is a one-way conversion for AI reading only.
   * 
   * @param adf - ADF document to convert
   * @returns Markdown string for AI prompts only
   * 
   * @example
   * // ✅ CORRECT: Converting for AI prompt context
   * const markdown = convertAdfToMarkdown(epicDescription);
   * const prompt = `Context: ${markdown}\n\nGenerate...`;
   * 
   *
   * // ❌ WRONG: Never convert back to ADF for Jira updates
   * // const markdown = convertAdfToMarkdown(description);
   * // const modified = markdown.replace(...);
   * // const adf = await convertMarkdownToAdf(modified); // This loses data like hardBreak nodes from the original ADF
   */
  export function convertAdfToMarkdown(adf: ADFDocument): string
  ```

**Verification for Renamings**:
- Run TypeScript compiler to find all references
- Update all imports and usages
- Update all existing documentation to use new names
- Run existing tests to ensure no breakage

### Step 2: Create ADF-Based Shell Story Parser

**File**: `server/providers/combined/tools/write-next-story/shell-story-parser.ts`

Refactor shell story parsing to work with ADF nodes instead of Markdown:

**Interface** (if not already defined elsewhere):
```typescript
export interface ParsedShellStoryADF {
  id: string;                    // e.g., "st001"
  title: string;                 // Story title
  description: string;           // Story description
  screens?: string[];            // Screen names from SCREENS section
  dependencies?: string[];       // Story IDs from DEPENDENCIES section
  completed: boolean;            // Has ✅ completion marker
  completedIssueKey?: string;    // Issue key if completed
  rawAdf?: ADFNode[];           // Optional: original ADF nodes
}
```

**Functions**:

```typescript
/**
 * Parse shell stories from ADF bullet list structure
 * @param adfContent - ADF nodes containing Shell Stories section
 * @returns Array of parsed shell stories
 */
export function parseShellStoriesFromAdf(
  adfContent: ADFNode[]
): ParsedShellStoryADF[]

/**
 * Extract Shell Stories section and parse it
 * @param epicDescription - Full epic description ADF
 * @returns Parsed shell stories
 */
export function extractAndParseShellStories(
  epicDescription: ADFDocument
): ParsedShellStoryADF[]

/**
 * Add completion marker to shell story in ADF
 * @param shellStoriesSection - Shell Stories ADF nodes
 * @param storyId - Story ID to mark (e.g., "st001")
 * @param issueKey - Jira issue key (e.g., "PROJ-123")
 * @returns New section with marker added
 */
export function addCompletionMarkerToShellStory(
  shellStoriesSection: ADFNode[],
  storyId: string,
  issueKey: string
): ADFNode[]
```

**Parsing Logic**:
1. Find "Shell Stories" heading using `findAdfHeading()`
2. Extract bullet list nodes after heading
3. For each `listItem`:
   - Find story ID in code-marked text node (`` `st001` ``)
   - Extract title (bold text after ID)
   - Extract description (text after ⟩ separator)
   - Check for completion marker (✅ + issueKey or URL)
   - Parse nested bullet lists for SCREENS, DEPENDENCIES, etc.
4. Return `ParsedShellStoryADF[]` matching existing interface

**Edge Cases to Handle**:
- Missing story ID - **throw descriptive error**
- Missing separator (⟩) - **throw descriptive error**
- Nested lists vs flat lists - handle both
- Hard breaks within descriptions - preserve
- Hard breaks within lists - preserve
- Emojis and special characters - preserve
- Already completed stories (with ✅) - detect via `link` mark on title text node
- Unknown node types - preserve unchanged

**Completion Marker Implementation** (Option A - decided):
- **Detection**: Check if title text node has `link` mark in its `marks` array
- **Addition**: 
  1. Find title text node (after story ID, before ⟩ separator)
  2. Add `link` mark to existing marks: `{ type: 'link', attrs: { href: 'https://bitovi.atlassian.net/browse/PROJ-123' } }`
  3. Append timestamp text node with `em` mark after description
- **No Markdown conversion** - pure ADF manipulation

### Step 3: Refactor `figma-screen-setup.ts`

**File**: `server/providers/combined/tools/writing-shell-stories/figma-screen-setup.ts`

**Changes**:
1. Remove `convertAdfToMarkdown()` calls from data manipulation (move to `prepareAIPromptContext()` only)
2. Keep ADF section extraction using ADF operations
3. Update `FigmaScreenSetupResult` interface inline (ADF only, no Markdown)
4. Create new file `server/providers/combined/tools/shared/ai-prompt-context.ts` for:
   - `AIPromptContext` interface with `_AIPromptOnly` naming
   - `prepareAIPromptContext()` function for AI prompt generation

**Interface Definitions**:

**In `figma-screen-setup.ts`** - Update existing interface:

```typescript
export interface FigmaScreenSetupResult {
  screens: ScreenWithNotes[];
  allFrames: FigmaNodeMetadata[];
  allNotes: FigmaNodeMetadata[];
  figmaFileKey: string;
  yamlContent: string;
  yamlPath?: string;
  
  // CHANGED: Return ADF only (no Markdown)
  epicWithoutShellStoriesAdf: ADFNode[];           // Epic content excluding Shell Stories
  epicDescriptionAdf: ADFDocument;     // Full epic description (ADF)
  shellStoriesAdf: ADFNode[];          // Shell Stories section (if exists)
  
  figmaUrls: string[];
  cloudId: string;
  siteName: string;
  projectKey: string;
  epicKey: string;
  epicUrl: string;
}
```

**In `server/providers/combined/tools/shared/ai-prompt-context.ts`** - New file:

```typescript
/**
 * AI prompt context with Markdown conversion
 * 
 * IMPORTANT: This interface is ONLY for AI prompt generation.
 * Never use these Markdown fields for Jira data manipulation.
 * All Jira updates must use ADF from FigmaScreenSetupResult.
 */
export interface AIPromptContext {
  /** READ-ONLY: For AI prompts only. Never write back to Jira. */
  epicMarkdown_AIPromptOnly: string;
  
  /** READ-ONLY: For AI prompts only. Never write back to Jira. */
  shellStoriesMarkdown_AIPromptOnly?: string;
}

/**
 * Convert ADF data to Markdown for AI prompt generation
 * 
 * This is the ONLY approved way to get Markdown from ADF.
 * The conversion is one-way and should never be reversed.
 * 
 * @param setupResult - Setup result with ADF data
 * @returns Markdown context for AI prompts only
 */
export function prepareAIPromptContext(
  setupResult: FigmaScreenSetupResult
): AIPromptContext {
  return {
    epicMarkdown_AIPromptOnly: convertAdfToMarkdown({
      version: 1,
      type: 'doc',
      content: setupResult.epicWithoutShellStoriesAdf
    }),
    shellStoriesMarkdown_AIPromptOnly: setupResult.shellStoriesAdf.length > 0
      ? convertAdfToMarkdown({
          version: 1,
          type: 'doc',
          content: setupResult.shellStoriesAdf
        })
      : undefined
  };
}
```

**Implementation**:
```typescript
// Step 2: Extract epic context (excluding Shell Stories)
const description = issue.fields.description;
if (!description) {
  throw new Error(`Epic ${epicKey} has no description.`);
}

// Extract Shell Stories section using ADF operations
const { section: shellStoriesAdf, remaining: epicWithoutShellStoriesAdf } = 
  extractAdfSection(description.content, "Shell Stories");

// Return ADF structures only (no Markdown conversion here)
return {
  // ... other fields
  epicWithoutShellStoriesAdf,
  epicDescriptionAdf: description,
  shellStoriesAdf
};
```

**Usage in AI prompt generation**:
```typescript
// Get setup result (ADF only)
const setupResult = await setupFigmaScreens(...);

// Later, when generating AI prompt, convert to Markdown explicitly
const aiContext = prepareAIPromptContext(setupResult);

const prompt = `
Epic Context:
${aiContext.epicMarkdown_AIPromptOnly}

Generate shell stories...
`;
```

### Step 4: Refactor `write-next-story/core-logic.ts`

**Changes**:

1. **Update `extractShellStoriesFromSetup()` signature and implementation inline**:
```typescript
async function extractShellStoriesFromSetup(
  setupResult: FigmaScreenSetupResult,
  notify: (msg: string) => Promise<void>
): Promise<ParsedShellStoryADF[]> {
  console.log('  Extracting shell stories from epic description...');
  
  // Use ADF parser instead of Markdown parser
  const shellStories = parseShellStoriesFromAdf(setupResult.shellStoriesAdf);
  
  if (shellStories.length === 0) {
    throw new Error('No shell stories found in epic...');
  }
  
  return shellStories;
}
```

2. **Update `updateEpicWithCompletion()` signature and implementation inline**:
```typescript
async function updateEpicWithCompletion(
  atlassianClient: AtlassianClient,
  cloudId: string,
  epicKey: string,
  setupResult: FigmaScreenSetupResult,
  nextStory: ParsedShellStoryADF,
  createdIssueKey: string,
  notify: (msg: string) => Promise<void>
): Promise<void> {
  console.log('  Adding completion marker to shell story...');
  
  // Add completion marker to shell stories ADF
  const updatedShellStories = addCompletionMarkerToShellStory(
    setupResult.shellStoriesAdf,
    nextStory.id,
    createdIssueKey
  );
  
  // Rebuild epic description: epic context + updated shell stories
  const updatedDescription: ADFDocument = {
    version: 1,
    type: 'doc',
    content: [
      ...setupResult.epicWithoutShellStoriesAdf,
      ...updatedShellStories
    ]
  };
  
  // Update epic in Jira
  const updateResponse = await updateJiraIssue(
    atlassianClient,
    cloudId,
    epicKey,
    { description: updatedDescription }
  );
  
  // ... error handling
}
```

3. **Update story creation**:
```typescript
// Generate Markdown for AI, convert once to ADF
const storyMarkdown = await generateStoryContent(...);
const storyAdf = await convertMarkdownToAdf(storyMarkdown);
```

### Step 5: Refactor `writing-shell-stories/core-logic.ts`

**Changes**:

1. **Update `updateEpicWithShellStories()` signature and implementation inline**:
```typescript
async function updateEpicWithShellStories({
  epicKey,
  cloudId,
  atlassianClient,
  shellStoriesMarkdown, // AI-generated content
  epicWithoutShellStoriesAdf,       // From setupResult
  notify
}: {
  epicKey: string;
  cloudId: string;
  atlassianClient: AtlassianClient;
  shellStoriesMarkdown: string;
  epicWithoutShellStoriesAdf: ADFNode[];
  notify: (msg: string) => Promise<void>;
}): Promise<void> {
  // Clean up AI-generated Markdown
  const cleanedMarkdown = prepareShellStoriesSection(shellStoriesMarkdown);
  
  // Convert shell stories to ADF (one-way, from AI output)
  const shellStoriesAdf = await convertMarkdownToAdf(cleanedMarkdown);
  
  if (!validateAdf(shellStoriesAdf)) {
    throw new Error('Invalid ADF generated from shell stories');
  }
  
  // Build final epic description
  const updatedDescription: ADFDocument = {
    version: 1,
    type: 'doc',
    content: [
      ...epicWithoutShellStoriesAdf,
      ...shellStoriesAdf.content
    ]
  };
  
  // Update Jira
  await updateJiraIssue(atlassianClient, cloudId, epicKey, {
    description: updatedDescription
  });
}
```

### Step 6: Validate Interface Consistency and Type Safety

**Purpose**: Verify that all interface updates made inline in Steps 3-5 are complete, consistent, and enforce the ADF-native pattern.

**Validation Checklist**:

- [ ] **`FigmaScreenSetupResult` interface verification**:
  - Contains only ADF fields (`epicWithoutShellStoriesAdf`, `epicDescriptionAdf`, `shellStoriesAdf`)
  - No Markdown fields present
  - All ADF fields properly typed with `ADFNode[]` or `ADFDocument`
  - JSDoc comments clearly state "ADF only"

- [ ] **`AIPromptContext` interface verification**:
  - All Markdown fields have `_AIPromptOnly` suffix
  - JSDoc warnings present stating "READ-ONLY: For AI prompts only"
  - Located in `server/providers/combined/tools/shared/ai-prompt-context.ts`
  - Properly exported and imported where needed

- [ ] **`prepareAIPromptContext()` function verification**:
  - Only function that converts ADF → Markdown for AI
  - Takes `FigmaScreenSetupResult` as input
  - Returns `AIPromptContext`
  - Properly documented as one-way conversion
  - Located in `server/providers/combined/tools/shared/ai-prompt-context.ts`

- [ ] **Function signature consistency**:
  - `extractShellStoriesFromSetup()` accepts `FigmaScreenSetupResult`
  - `updateEpicWithCompletion()` uses ADF operations
  - `updateEpicWithShellStories()` accepts `epicWithoutShellStoriesAdf: ADFNode[]`
  - No function signatures accept Markdown for Jira data manipulation

- [ ] **Type safety enforcement**:
  - TypeScript compiler shows no errors
  - All ADF operations properly typed
  - No `any` types introduced during refactor
  - Import statements updated for new interfaces

- [ ] **Naming convention enforcement**:
  - Run: `grep -r "_AIPromptOnly" server/providers/combined/tools/` - should find all Markdown fields and conversion functions
  - Run: `grep -r "AIPromptContext" server/providers/combined/tools/` - should find interface usage
  - Run: `grep -r "convertAdfToMarkdown" server/providers/combined/tools/` - should only appear in `prepareAIPromptContext()`
  - Run: `grep -r "convertMarkdownToAdf" server/providers/combined/tools/` - should only be on new AI-generated content
  - Run: `grep -r "\bconvertAdfToMarkdown\b" server/providers/combined/tools/` - should return NO matches (old name removed)
  - Run: `grep -r "\bconvertMarkdownToAdf\b" server/providers/combined/tools/` - should return NO matches (old name removed)

- [ ] **Documentation completeness**:
  - JSDoc comments on all new interfaces
  - JSDoc comments on `prepareAIPromptContext()`
  - Warning comments on conversion functions
  - Clear separation between data interfaces and AI prompt interfaces

### Step 7: Testing Strategy

**Unit Tests**:
1. **ADF Operations** (`adf-operations.test.ts`):
   - Extract section with existing heading
   - Extract section with missing heading (should return empty)
   - Remove section
   - Append to section
   - Replace section
   - Handle malformed ADF gracefully

2. **Shell Story Parser** (`shell-story-parser.adf.test.ts`):
   - Parse basic story with ID, title, description
   - Parse story with hard breaks in description
   - Parse nested bullet lists (SCREENS, DEPENDENCIES)
   - Parse completed story (with ✅ marker - check for `link` mark)
   - Handle missing fields gracefully - **throw descriptive errors**
   - Parse multiple stories
   - Preserve unknown node types in story content
   - Parse stories with `inlineCard` nodes (Figma URLs)

3. **Integration Tests**:
   - Full write-next-story workflow with ADF
   - Full write-shell-stories workflow with ADF
   - Verify no data loss on round-trip (fetch → parse → update → verify)

**Test Data**:
Create fixture files with sample ADF structures:
- `test/fixtures/adf/epic-with-shell-stories.json`
- `test/fixtures/adf/shell-story-with-hardbreak.json`
- `test/fixtures/adf/completed-shell-story.json`

**Manual Testing Checklist**:
- [ ] Create epic with shell stories containing Shift+Enter line breaks
- [ ] Run write-next-story
- [ ] Verify created issue preserves hard breaks
- [ ] Verify epic updated with completion marker
- [ ] Verify other shell stories unchanged
- [ ] Run write-shell-stories
- [ ] Verify generated shell stories render correctly in Jira UI
- [ ] Verify nested lists, bold, links preserved

### Step 8: Final Validation and Documentation

**Phase 1** (Validation):
- Verify no `convertMarkdownToAdf()` calls on existing Jira content (only new content)
- Verify all ADF operations are using the new utilities from `adf-operations.ts`
- Run full test suite including integration tests
- Verify hard breaks (Shift+Enter) are preserved in real Jira testing
- Check that no markdown round-trip conversions remain

**Phase 2** (Linting & Guards):
- Create ESLint rule or grep-based check to prevent future misuse
- Add pre-commit hook to check for disallowed patterns
- Document the naming convention in team guidelines

**Phase 3** (Long-term Improvements):
- Consider building ADF directly from structured data (alternative to Markdown generation)
- Evaluate performance of ADF operations vs previous approach
- Document decision rationale and patterns in architecture docs
- Add examples to `server/readme.md`

## Success Criteria

### Must Have
- [x] `convertMarkdownToAdf()` renamed to `convertMarkdownToAdf()` (Step 1)
- [x] `convertAdfToMarkdown()` renamed to `convertAdfToMarkdown()` (Step 1)
- [x] No `convertMarkdownToAdf()` calls on existing Jira content (only new content: AI output, error messages, etc.)
- [x] No `convertAdfToMarkdown()` calls except in `prepareAIPromptContext()` for AI prompt generation
- [x] Shell story parsing works with ADF nodes (Step 2)
- [x] Hard breaks (Shift+Enter) preserved through entire workflow
- [x] All existing tests pass
- [x] New unit tests for ADF operations (>80% coverage)

### Should Have  
- [x] Integration tests with real Jira sandbox
- [ ] Documentation updated in `server/readme.md`
- [ ] TypeScript strict mode compliance
- [ ] ESLint rules to prevent future misuse of conversion functions

### Could Have
- [ ] Build story descriptions directly as ADF (skip Markdown generation)
- [ ] ADF linting/validation utilities
- [ ] Visual diff tool for ADF structures (debugging)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| ADF parsing bugs | High - data corruption | Extensive unit tests, manual QA |
| Performance degradation | Medium - slower operations | Benchmark before/after, optimize if needed |
| Breaking existing workflows | High - API changes | Maintain backward compatibility during transition |
| Missing edge cases | Medium - parsing failures | Comprehensive test fixtures, real-world testing |

<!-- ## Implementation Strategy

**Approach**: Vertical Slice (Feature-by-Feature) - Fast feedback, early validation

### Phase 1: Shell Stories (~2-3 sessions)
1. **✅ Step 1**: Rename functions + create `adf-operations.ts`
2. **Step 3**: Refactor `figma-screen-setup.ts` (ADF-only interface)
3. **Step 5**: Refactor `writing-shell-stories/core-logic.ts`
4. **Step 6 + 7**: Validate + test shell stories workflow
5. **Manual test**: Verify hard breaks preserved in Jira

### Phase 2: Next Story (~2-3 sessions)
1. **Step 2**: Create `shell-story-parser.ts` with ADF parsing functions
2. **Step 4**: Refactor `write-next-story/core-logic.ts`
3. **Step 6 + 7**: Validate + test next story workflow
4. **Manual test**: Verify completion markers + hard breaks in Jira

### Phase 3: Final (~1-2 sessions)
1. **Cleanup**: evaluate if there are unused functions in markdown-converter.ts, or if there are functions that should be moved into adr-operations.ts.
1. **Step 8**: Full validation, ESLint rules, documentation
2. **Manual test**: End-to-end workflow verification

**Start Prompt**: `Implement Phase 1, Session 1: Step 1 (rename functions + create adf-operations.ts)` -->

## Design Decisions & Resolved Questions

**Answered in Design Decisions Section Above**:
- ~~Should we build story descriptions directly as ADF, or continue generating Markdown from AI and converting once?~~ **A: Use Markdown for AI generation, convert once to ADF**
- ~~Should `epicContext` continue to be Markdown for AI prompts, or should we send the full ADF structure?~~ **A: Use Markdown for AI prompts**

**Resolved Questions**:

1. **Legacy shell stories support?** 
   - **A: Assume ADF-native going forward** (no backward compatibility needed)

2. **Performance overhead acceptable?**
   - **A: Not worried about this yet** (no specific benchmark target needed)

3. **Migration script for corrupted formatting?**
   - **A: No** (don't create migration script)

4. **Handle other ADF node types?**
   - **A: Preserve unknown/future node types during manipulation. Do not lose them.**
   - **Implementation**: Make ADF operations generic - when traversing/manipulating, preserve any node types we don't explicitly handle
   - **Currently used types**: `text`, `paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `inlineCard`, `hardBreak`
   - **Text marks**: `code`, `strong`, `em`, `link`
   - **Future-proofing**: Copy unknown nodes unchanged when rebuilding ADF structures

5. **Completion marker format?**
   - **A: Option A** - Keep current approach (text node with `link` mark + timestamp)
   - **Implementation**: Pure ADF manipulation (no Markdown round-trip)
   - **How it works**:
     - `addCompletionMarkerToShellStory()`: Find title text node, add `link` mark to marks array, append timestamp text node with `em` mark
     - `parseShellStoriesFromAdf()`: Check if title text node has `link` mark to detect completion
   - **Rationale**: Simpler, already working, no user-facing changes, fully ADF-native

6. **Malformed story handling?**
   - **A: Throw error** (fail fast, don't skip or return partial data)
   - **Implementation**: `parseShellStoriesFromAdf()` throws descriptive error when encountering invalid structure

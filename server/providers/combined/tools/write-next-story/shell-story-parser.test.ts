/**
 * Unit tests for Shell Story ADF Parser
 * 
 * These tests validate that shell story parsing preserves all ADF formatting,
 * especially hardBreak nodes that are lost in Markdown round-trips.
 */

import { describe, it, expect } from '@jest/globals';
import {
  parseShellStoriesFromAdf,
  addCompletionMarkerToShellStory,
  type ParsedShellStoryADF
} from './shell-story-parser.js';
import type { ADFNode, ADFDocument } from '../../../atlassian/markdown-converter.js';
import { extractADFSection } from '../../../atlassian/markdown-converter.js';

// Test fixture - Story with hardBreak nodes (main test case for ADF parsing)
const storyWithHardBreak: ADFNode = {
  type: 'listItem',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'Story Title', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' ⟩ Story description' }
      ]
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'SCREENS: ' },
                { 
                  type: 'text', 
                  text: 'Screen 1',
                  marks: [{ type: 'link', attrs: { href: 'https://figma.com/file/test?node-id=001' } }]
                },
                { type: 'hardBreak' },
                { 
                  type: 'text', 
                  text: 'Screen 2',
                  marks: [{ type: 'link', attrs: { href: 'https://figma.com/file/test?node-id=002' } }]
                }
              ]
            }
          ]
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'DEPENDENCIES: Auth,' },
                { type: 'hardBreak' },
                { type: 'text', text: 'Data' }
              ]
            }
          ]
        }
      ]
    }
  ]
};

// Test fixture - Completed story with link mark and timestamp
const completedStory: ADFNode = {
  type: 'listItem',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          text: 'Completed Story ✓',
          marks: [
            { type: 'strong' },
            { type: 'link', attrs: { href: 'https://jira.com/PROJ-123' } }
          ]
        },
        { type: 'text', text: ' ⟩ This story is done ' },
        { type: 'text', text: '(2025-01-15T10:30:00Z)', marks: [{ type: 'em' }] }
      ]
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'SCREENS: None' }]
            }
          ]
        }
      ]
    }
  ]
};

describe('parseShellStoriesFromAdf', () => {
  it('should parse basic shell stories from bulletList', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Login Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ User can log into the application' }
              ]
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'SCREENS: Login Page (Fig-001)' }]
                    }
                  ]
                },
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'DEPENDENCIES: None' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const stories = parseShellStoriesFromAdf([bulletList]);
    
    expect(stories.length).toBe(1);
    expect(stories[0].title).toBe('Login Story');
    // Screens should be empty since we didn't provide link marks
    expect(stories[0].screens).toEqual([]);
    // "None" dependencies should be filtered out to empty array
    expect(stories[0].dependencies).toEqual([]);
  });

  it('should parse shell stories with hardBreak nodes', () => {
    const stories = parseShellStoriesFromAdf([
      {
        type: 'bulletList',
        content: [storyWithHardBreak]
      }
    ]);

    expect(stories.length).toBe(1);
    const story = stories[0];
    
    // Screens should be parsed correctly despite hardBreak
    expect(story.screens.length).toBe(2);
    expect(story.screens).toContain('https://figma.com/file/test?node-id=001');
    expect(story.screens).toContain('https://figma.com/file/test?node-id=002');
    
    // Dependencies should handle hardBreak
    expect(story.dependencies.length).toBe(2);
    expect(story.dependencies).toContain('Auth');
    expect(story.dependencies).toContain('Data');
  });

  it('should parse multiple shell stories', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'First Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ First description' }
              ]
            }
          ]
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st002', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Second Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ Second description' }
              ]
            }
          ]
        }
      ]
    };

    const stories = parseShellStoriesFromAdf([bulletList]);
    
    expect(stories.length).toBe(2);
    expect(stories[0].title).toBe('First Story');
    expect(stories[1].title).toBe('Second Story');
  });

  it('should detect completion marker (✓)', () => {
    const stories = parseShellStoriesFromAdf([
      {
        type: 'bulletList',
        content: [completedStory]
      }
    ]);

    expect(stories.length).toBe(1);
    const story = stories[0];
    
    // Title should contain checkmark
    expect(story.title).toContain('✓');
  });

  it('should extract Figma URLs from screens field', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Form Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ User can fill out forms' }
              ]
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'SCREENS: ' },
                        { 
                          type: 'text', 
                          text: 'https://www.figma.com/design/ABC/XYZ?node-id=123',
                          marks: [{ type: 'link', attrs: { href: 'https://www.figma.com/design/ABC/XYZ?node-id=123' } }]
                        },
                        { type: 'hardBreak' },
                        { 
                          type: 'text', 
                          text: 'https://www.figma.com/design/DEF/UVW?node-id=456',
                          marks: [{ type: 'link', attrs: { href: 'https://www.figma.com/design/DEF/UVW?node-id=456' } }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const stories = parseShellStoriesFromAdf([bulletList]);
    
    expect(stories.length).toBe(1);
    expect(stories[0].screens.length).toBe(2);
    expect(stories[0].screens[0]).toContain('figma.com');
    expect(stories[0].screens[1]).toContain('figma.com');
  });

  it('should handle stories without nested lists', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Simple Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ A simple story without nested lists' }
              ]
            }
          ]
        }
      ]
    };

    const stories = parseShellStoriesFromAdf([bulletList]);
    
    expect(stories.length).toBe(1);
    expect(stories[0].title).toBe('Simple Story');
    expect(stories[0].screens).toEqual([]);
    expect(stories[0].dependencies).toEqual([]);
  });
});

describe('extractADFSection and parseShellStoriesFromAdf (two-step pattern)', () => {
  it('should extract section and parse shell stories from epic content', () => {
    const epicDoc: ADFDocument = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Shell Stories' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                    { type: 'text', text: ' ' },
                    { type: 'text', text: 'Test', marks: [{ type: 'strong' }] },
                    { type: 'text', text: ' ⟩ Test' }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const { section } = extractADFSection(epicDoc.content, 'Shell Stories');
    const stories = parseShellStoriesFromAdf(section);

    expect(stories.length).toBe(1);
  });

  it('should handle epic without shell stories section', () => {
    const emptyDoc: ADFDocument = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Context' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Some context text' }] }
      ]
    };

    const { section } = extractADFSection(emptyDoc.content, 'Shell Stories');
    const stories = parseShellStoriesFromAdf(section);

    expect(stories).toEqual([]);
  });
});

describe('addCompletionMarkerToShellStory', () => {
  it('should add ✓ marker to uncompleted story title', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Login Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ User can log into the application' }
              ]
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'SCREENS: Login (Fig-001)' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const updated = addCompletionMarkerToShellStory([bulletList], 'st001', 'PROJ-123', 'https://jira.com/PROJ-123');

    // Find the updated story title
    const listItem = updated[0].content?.[0];
    const titleParagraph = listItem?.content?.[0];
    
    // Find the title text node (has 'strong' mark)
    const titleNode = titleParagraph?.content?.find((node: any) => 
      node.marks?.some((mark: any) => mark.type === 'strong')
    );

    // Title should have both 'strong' and 'link' marks (completion is indicated by link)
    expect(titleNode?.marks?.some((m: any) => m.type === 'link')).toBe(true);
    expect(titleNode?.marks?.some((m: any) => m.type === 'strong')).toBe(true);
  });

  it('should add Jira URL and timestamp to story metadata', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Dashboard Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ User can view dashboard' }
              ]
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'SCREENS: Dashboard (Fig-002)' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const jiraUrl = 'https://jira.com/PROJ-456';
    const updated = addCompletionMarkerToShellStory([bulletList], 'st001', 'PROJ-456', jiraUrl);

    // Parse the updated story
    const stories = parseShellStoriesFromAdf(updated);
    expect(stories.length).toBe(1);
    
    const story = stories[0];
    expect(story.jiraUrl).toBe(jiraUrl);
  });

  it('should not modify already completed stories', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [completedStory]
    };

    const updated = addCompletionMarkerToShellStory([bulletList], 'st001', 'PROJ-789', 'https://jira.com/PROJ-789');

    const stories = parseShellStoriesFromAdf(updated);
    expect(stories.length).toBe(1);
    expect(stories[0].title).toContain('✓');
  });

  it('should preserve hardBreak nodes when adding completion marker', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [storyWithHardBreak]
    };

    const updated = addCompletionMarkerToShellStory([bulletList], 'st001', 'PROJ-999', 'https://jira.com/PROJ-999');

    // Verify hardBreaks are still present
    let hardBreakCount = 0;
    function countHardBreaks(nodes: ADFNode[]) {
      for (const node of nodes) {
        if (node.type === 'hardBreak') hardBreakCount++;
        if (node.content) countHardBreaks(node.content);
      }
    }
    countHardBreaks(updated);

    expect(hardBreakCount).toBeGreaterThan(0);
  });

  it('should handle story ID not found', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Some Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ Some description' }
              ]
            }
          ]
        }
      ]
    };

    // Should throw error when story ID is not found
    expect(() => {
      addCompletionMarkerToShellStory([bulletList], 'nonexistent-id', 'PROJ-000', 'https://jira.com/PROJ-000');
    }).toThrow('Story nonexistent-id not found in Shell Stories section');
  });
});

describe('Error handling and edge cases', () => {
  it('should handle empty bulletList', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: []
    };

    const stories = parseShellStoriesFromAdf([bulletList]);
    expect(stories).toEqual([]);
  });

  it('should throw error for malformed story structures', () => {
    const malformedCases = [
      { type: 'bulletList', content: [{ type: 'listItem', content: [] }] }, // Empty listItem
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [] }] }] }, // Nested list without paragraph
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] }] } // No text property
    ];

    malformedCases.forEach(bulletList => {
      expect(() => parseShellStoriesFromAdf([bulletList])).toThrow('Shell story missing ID');
    });
  });

  it('should preserve unknown node types', () => {
    const bulletList: ADFNode = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'st001', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'Story', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ⟩ Test story with unknown nodes' }
              ]
            },
            { type: 'unknownNode', customProp: 'value' } as any
          ]
        }
      ]
    };

    const stories = parseShellStoriesFromAdf([bulletList]);
    expect(stories.length).toBe(1);
  });
});

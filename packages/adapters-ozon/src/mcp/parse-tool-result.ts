import { isRecord } from '../config.js';

export interface ParsedToolResult {
  data: unknown;
  isError: boolean;
}

export function parseToolResult(result: unknown): ParsedToolResult {
  if (!isRecord(result)) {
    throw new Error('Unrecognized MCP tool result.');
  }

  const isError = result.isError === true;
  if ('structuredContent' in result && result.structuredContent !== undefined) {
    return { data: result.structuredContent, isError };
  }

  const text = firstTextContent(result.content);
  if (text !== null) {
    return { data: parseTextContent(text), isError };
  }

  if ('content' in result && result.content === undefined) {
    return { data: {}, isError };
  }

  throw new Error('Unrecognized MCP tool result.');
}

function firstTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return null;
}

function parseTextContent(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

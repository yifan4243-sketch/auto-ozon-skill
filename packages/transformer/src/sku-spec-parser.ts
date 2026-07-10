export interface SourceSkuOption {
  prop: string;
  values: Array<{ name: string; imageUrl?: string | null }>;
}

export interface ParseSkuSpecInput {
  raw_spec_text: string;
  options: SourceSkuOption[];
  structured_specs?: Record<string, string> | null;
}

export interface ParsedSkuSpec {
  specs: Record<string, string>;
  unparsed_spec_segments: string[];
}

/**
 * Parse only source facts that can be established deterministically. Unknown
 * segments are retained for a later review stage instead of receiving spec1,
 * spec2, or guessed semantic names.
 */
export function parseSkuSpec(input: ParseSkuSpecInput): ParsedSkuSpec {
  const structured = cleanRecord(input.structured_specs ?? {});
  if (Object.keys(structured).length > 0) {
    return { specs: structured, unparsed_spec_segments: [] };
  }

  const raw = decodeSpecText(input.raw_spec_text).trim();
  if (!raw) return { specs: {}, unparsed_spec_segments: [] };

  const options = input.options
    .map((option) => ({
      prop: option.prop.trim(),
      values: option.values.map((value) => value.name.trim()).filter(Boolean),
    }))
    .filter((option) => option.prop);

  const optionKeyValues = parseKeyValueSegments(raw, true);
  if (Object.keys(optionKeyValues).length > 0) {
    const knownNames = new Set(options.map((option) => normalizeToken(option.prop)));
    const allKnown = Object.keys(optionKeyValues).every((name) =>
      knownNames.has(normalizeToken(name)),
    );
    if (allKnown) {
      const specs: Record<string, string> = {};
      for (const option of options) {
        const matched = Object.entries(optionKeyValues).find(
          ([name]) => normalizeToken(name) === normalizeToken(option.prop),
        );
        if (matched) specs[option.prop] = matched[1];
      }
      return { specs, unparsed_spec_segments: [] };
    }
  }

  if (options.length > 0) {
    const optionMatch = matchOptionValues(raw, options);
    if (Object.keys(optionMatch.specs).length > 0) return optionMatch;

    // A single source dimension gives the complete text a real semantic name,
    // even when the seller used an undelimited value such as "红色9寸".
    if (options.length === 1) {
      return { specs: { [options[0]!.prop]: raw }, unparsed_spec_segments: [] };
    }
  }

  const explicitKeyValues = parseKeyValueSegments(raw, false);
  if (Object.keys(explicitKeyValues).length > 0) {
    return { specs: explicitKeyValues, unparsed_spec_segments: [] };
  }

  return {
    specs: {},
    unparsed_spec_segments: splitSpecSegments(raw),
  };
}

export function normalizeSpecForMatch(value: string): string {
  return decodeSpecText(value)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/；/g, ';')
    .replace(/，/g, ',')
    .replace(/：/g, ':')
    .replace(/\s*([>;|,/:=])\s*/g, '$1')
    .replace(/\s+/g, ' ');
}

function matchOptionValues(
  raw: string,
  options: Array<{ prop: string; values: string[] }>,
): ParsedSkuSpec {
  const specs: Record<string, string> = {};
  const unparsed: string[] = [];
  const segments = splitSpecSegments(raw);

  for (const segment of segments) {
    const normalizedSegment = normalizeToken(segment);
    const matchingOptions = options.filter((option) =>
      option.values.some((value) => normalizeToken(value) === normalizedSegment),
    );
    if (matchingOptions.length !== 1) {
      unparsed.push(segment);
      continue;
    }

    const option = matchingOptions[0]!;
    if (specs[option.prop] !== undefined) {
      unparsed.push(segment);
      continue;
    }
    const sourceValue = option.values.find(
      (value) => normalizeToken(value) === normalizedSegment,
    );
    if (sourceValue) specs[option.prop] = sourceValue;
  }

  return { specs, unparsed_spec_segments: unparsed };
}

function parseKeyValueSegments(
  raw: string,
  allowArrowSeparator: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  const segments = raw
    .split(/[;；|｜,，]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const match = allowArrowSeparator
      ? segment.match(/^([^:=：>]+?)\s*(?:[:=：]|>)\s*([^:=：>]+)$/)
      : segment.match(/^([^:=：>]+?)\s*[:=：]\s*([^:=：>]+)$/);
    if (!match) return {};
    const name = match[1]!.trim();
    const value = match[2]!.trim();
    if (!name || !value || out[name] !== undefined) return {};
    out[name] = value;
  }
  return out;
}

function splitSpecSegments(raw: string): string[] {
  const segments = raw
    .split(/\s*(?:>|;|；|\||｜|\/|,|，)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : [raw];
}

function cleanRecord(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim();
    const value = rawValue.trim();
    if (name && value) out[name] = value;
  }
  return out;
}

function normalizeToken(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function decodeSpecText(value: string): string {
  return value
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

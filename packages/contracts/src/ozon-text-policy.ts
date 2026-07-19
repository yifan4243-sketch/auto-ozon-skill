const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/**
 * Ozon rejects description attribute 4191 when marketplace text contains
 * CJK characters. Source-language facts belong in evidence, not customer-facing
 * Russian copy. Disallow unsafe control characters at the same boundary.
 */
export function hasForbiddenOzonDescriptionCharacters(value: string): boolean {
  return CJK_SCRIPT.test(value.normalize('NFC')) || UNSAFE_CONTROL_CHARACTER.test(value);
}

export function forbiddenOzonDescriptionCharacters(value: string): string[] {
  return [...new Set([...value.normalize('NFC')].filter((character) =>
    CJK_SCRIPT.test(character) || UNSAFE_CONTROL_CHARACTER.test(character),
  ))];
}

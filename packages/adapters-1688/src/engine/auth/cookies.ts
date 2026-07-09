import type { Cookie } from 'playwright';

export interface Identity {
  memberId: string;
  nick: string | null;
}

export function parseIdentity(cookies: Cookie[]): Identity | null {
  const memberId =
    pick(cookies, 'unb', '.1688.com') ?? pick(cookies, 'unb', '.taobao.com');
  if (!memberId) return null;
  const trackraw = pick(cookies, 'tracknick');
  const nick = trackraw ? decodeTracknick(trackraw) : null;
  return { memberId, nick };
}

function pick(
  cookies: Cookie[],
  name: string,
  domainSuffix?: string,
): string | undefined {
  for (const c of cookies) {
    if (c.name !== name) continue;
    if (domainSuffix && !c.domain.endsWith(domainSuffix)) continue;
    return c.value;
  }
  return undefined;
}

export function decodeTracknick(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(s);
  } catch {
    // malformed percent encoding — leave as-is
  }
  // Handle literal \uXXXX escapes that sometimes survive in cookie values
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return s;
}

import { CliError } from '../io/errors.js';

export type NavigationKind =
  | '1688'
  | 'login'
  | 'risk_control'
  | 'payment'
  | 'external'
  | 'unknown';

export interface NavigationClassification {
  kind: NavigationKind;
  url: string;
  host: string | null;
}

export interface NavigationWarning {
  code: string;
  message: string;
  details: NavigationClassification;
}

const ALLOWED_1688_HOST_RE = /(^|\.)1688\.com$/i;
const ALLOWED_ALI_HOST_RE = /(^|\.)(taobao\.com|tmall\.com|alibaba\.com|alicdn\.com)$/i;

export function classifyNavigation(url: string): NavigationClassification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown', url, host: null };
  }
  const host = parsed.hostname;
  if (/punish|x5secdata/i.test(url) || /punish/i.test(host)) {
    return { kind: 'risk_control', url, host };
  }
  if (/login\.(1688|taobao)\.com$/i.test(host)) {
    return { kind: 'login', url, host };
  }
  if (/cashier|pay|payment|alipay/i.test(host + parsed.pathname)) {
    return { kind: 'payment', url, host };
  }
  if (ALLOWED_1688_HOST_RE.test(host) || ALLOWED_ALI_HOST_RE.test(host)) {
    return { kind: '1688', url, host };
  }
  return { kind: 'external', url, host };
}

export function navigationWarning(url: string): NavigationWarning | null {
  const details = classifyNavigation(url);
  if (details.kind === '1688') return null;
  return {
    code: `NAVIGATION_${details.kind.toUpperCase()}`,
    message: messageForKind(details.kind),
    details,
  };
}

export function assertSafeNavigation(url: string, opts: { write: boolean }): void {
  const details = classifyNavigation(url);
  if (details.kind === '1688') return;
  if (!opts.write && details.kind !== 'payment') return;
  throw new CliError(
    details.kind === 'payment' ? 24 : 23,
    details.kind === 'payment' ? 'PAYMENT_BLOCKED' : 'UNEXPECTED_NAVIGATION',
    messageForKind(details.kind),
    {
      currentUrl: url,
      navigationKind: details.kind,
      recoverHint: 'Run with --headed to inspect the page before continuing.',
    },
  );
}

function messageForKind(kind: NavigationKind): string {
  switch (kind) {
    case 'login':
      return 'Navigation reached a login page.';
    case 'risk_control':
      return 'Navigation reached a 1688 risk-control page.';
    case 'payment':
      return 'Navigation reached a payment page and was blocked.';
    case 'external':
      return 'Navigation reached an unexpected external domain.';
    case 'unknown':
      return 'Navigation target could not be parsed.';
    case '1688':
      return 'Navigation is within the allowed 1688 domain set.';
  }
}

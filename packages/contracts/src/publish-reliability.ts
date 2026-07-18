export interface PreflightCheckV1 {
  code: string;
  status: 'passed' | 'failed' | 'warning';
  message: string;
  offer_ids: string[];
}

export interface PreflightReportV1 {
  schema_version: 1;
  run_id: string;
  store_id: string;
  draft_sha256: string;
  checked_at: string;
  status: 'passed' | 'blocked';
  checks: PreflightCheckV1[];
}

export interface StorePublishingConsentV1 {
  schema_version: 1;
  consent_id: string;
  store_id: string;
  enabled: boolean;
  actor: string;
  source: 'setup_cli' | 'local_review_console';
  created_at: string;
  revoked_at: string | null;
  profile_hash: string;
  policy_version: string;
}

export interface PublishAuthorizationV1 {
  schema_version: 1;
  authorization_id: string;
  consent_id: string;
  run_id: string;
  store_id: string;
  profile_hash: string;
  draft_sha256: string;
  created_at: string;
}

/** @deprecated Read-only compatibility name. New code must use PublishAuthorizationV1. */
export type AuthorizationRecordV1 = PublishAuthorizationV1;

export type PublishIntentStatusV1 = 'prepared' | 'submitted' | 'polling' | 'succeeded' | 'failed' | 'unknown';

export interface PublishIntentV1 {
  schema_version: 1;
  intent_id: string;
  run_id: string;
  store_id: string;
  offer_id: string;
  item_hash: string;
  status: PublishIntentStatusV1;
  task_id: string | null;
  product_id: number | null;
  reconciliation_checks: number;
  last_reconciliation_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutboxRecordV1 {
  schema_version: 1;
  outbox_id: string;
  intent_id: string;
  status: 'pending' | 'submitted' | 'reconciled' | 'failed';
  attempts: number;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

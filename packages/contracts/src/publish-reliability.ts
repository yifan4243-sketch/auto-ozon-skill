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

export interface AuthorizationRecordV1 {
  schema_version: 1;
  authorization_id: string;
  run_id: string;
  store_id: string;
  source: 'enabled_store_profile';
  automation_level: 'automatic';
  policy_version: string;
  profile_hash: string;
  draft_sha256: string;
  authorized_at: string;
}

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

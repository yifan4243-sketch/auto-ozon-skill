export type SetupCheckStatusV1 = 'passed' | 'warning' | 'failed';

export interface SetupCheckV1 {
  code: string;
  status: SetupCheckStatusV1;
  message: string;
  fix: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export interface SetupStoreStatusV1 {
  store_id: string;
  store_name: string;
  publishing_enabled: boolean;
  currency_code: 'CNY' | 'RUB';
  seller_credentials_configured: boolean;
  performance_credentials_configured: boolean;
  /** @deprecated Use seller_credentials_configured. */
  credentials_configured: boolean;
}

export interface SetupReportV1 {
  schema_version: 1;
  checked_at: string;
  status: 'ready' | 'needs_attention' | 'blocked';
  checks: SetupCheckV1[];
  stores: SetupStoreStatusV1[];
  profiles_1688: string[];
}

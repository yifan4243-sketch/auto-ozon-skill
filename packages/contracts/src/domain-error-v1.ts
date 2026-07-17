export type DomainErrorCategoryV1 =
  | 'input'
  | 'auth'
  | 'rate_limit'
  | 'risk_control'
  | 'network'
  | 'upstream_validation'
  | 'policy'
  | 'conflict'
  | 'internal';

export interface DomainErrorV1 {
  code: string;
  category: DomainErrorCategoryV1;
  message: string;
  recoverable: boolean;
  retry_after_ms: number | null;
  affected_ids: string[];
  upstream_request_id: string | null;
  sanitized_detail: unknown;
}

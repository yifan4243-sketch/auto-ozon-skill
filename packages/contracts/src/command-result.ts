export interface ErrorObject {
  code: string;
  message: string;
  detail?: unknown;
  recoverable: boolean;
}

export interface WarningObject {
  code: string;
  message: string;
  detail?: unknown;
}

export interface CommandResult<T = unknown> {
  ok: boolean;
  command: string;
  data?: T;
  warnings: WarningObject[];
  errors: ErrorObject[];
  nextActions: string[];
}

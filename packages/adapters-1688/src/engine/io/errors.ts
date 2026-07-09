export interface CliErrorDetails {
  artifactDir?: string;
  category?: string;
  currentUrl?: string;
  pageState?: string;
  recoverHint?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

export class CliError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly code: string,
    message: string,
    public details: CliErrorDetails = {},
  ) {
    super(message);
  }

  withDetails(details: CliErrorDetails): this {
    this.details = { ...this.details, ...details };
    return this;
  }
}

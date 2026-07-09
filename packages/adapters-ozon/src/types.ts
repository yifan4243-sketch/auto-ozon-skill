import type { CommandResult } from '../../contracts/src/command-result.js';

export type OzonSafety = 'read' | 'write' | 'destructive';

export interface OzonCredentialsStatus {
  sellerCredentials: boolean;
  performanceCredentials: boolean;
}

export interface OzonToolAvailability {
  available: boolean;
  missing: string[];
}

export interface OzonDoctorCheck {
  name: string;
  status: 'ok' | 'warning' | 'error' | 'skipped';
  message: string;
}

export interface OzonDoctorData {
  vendorDir: string;
  vendorExists: boolean;
  uvExecutable: boolean;
  helpOk: boolean;
  mcpStartOk: boolean;
  toolsListOk: boolean;
  toolCount: number;
  discoveryTools: OzonToolAvailability;
  executionTools: OzonToolAvailability;
  credentials: OzonCredentialsStatus;
  checks: OzonDoctorCheck[];
}

export interface OzonSearchMethodsOptions {
  query: string;
  limit?: number;
}

export interface OzonDescribeMethodOptions {
  operationId: string;
}

export interface OzonCallMethodOptions {
  operationId: string;
  params: Record<string, unknown>;
}

export interface OzonFetchAllOptions extends OzonCallMethodOptions {
  maxItems?: number;
}

export interface OzonGetWorkflowOptions {
  name: string;
}

export type OzonCommandResult<T = unknown> = CommandResult<T>;

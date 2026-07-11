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
  toolNames: string[];
  discoveryTools: OzonToolAvailability;
  referenceTools: OzonToolAvailability;
  executionTools: OzonToolAvailability;
  credentialTools: OzonToolAvailability;
  fullBridgeCoreTools: OzonToolAvailability;
  credentials: OzonCredentialsStatus;
  checks: OzonDoctorCheck[];
}

export interface OzonSearchMethodsOptions {
  query: string;
  section?: string;
  api?: string;
  safety?: string;
  limit?: number;
}

export interface OzonDescribeMethodOptions {
  operationId?: string;
  path?: string;
  httpMethod?: string;
}

export interface OzonCallMethodOptions {
  operationId: string;
  params: Record<string, unknown>;
  cabinetTier?: string;
}

export interface OzonFetchAllOptions extends OzonCallMethodOptions {
  maxItems?: number;
}

export interface OzonGetSectionOptions {
  query: string;
}

export interface OzonGetRelatedMethodsOptions {
  operationId: string;
  maxHops?: number;
}

export interface OzonListWorkflowsOptions {
  category?: string;
}

export interface OzonGetWorkflowOptions {
  name: string;
}

export interface OzonGetExamplesOptions {
  operationId: string;
}

export interface OzonGetRateLimitsOptions {
  operationId?: string;
  section?: string;
}

export interface OzonGetErrorCatalogOptions {
  code?: string;
  operationId?: string;
}

export interface OzonGetSubscriptionStatusOptions {
  refresh?: boolean;
}

export interface OzonListMethodsForSubscriptionOptions {
  tier: string;
}

export interface GetCategoryAttributesOptions {
  descriptionCategoryId: number;
  typeId: number;
  categoryName?: string;
  typeName?: string;
  categoryPathZh?: string[];
  groupId?: string;
  forceRefresh?: boolean;
}

export type OzonCommandResult<T = unknown> = CommandResult<T>;

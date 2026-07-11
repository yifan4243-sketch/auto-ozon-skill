import fs from 'node:fs/promises';
import type { CategoryDecisionV1 } from '../../../../packages/contracts/src/category-decision.js';

export interface CategoryDecisionProvider {
  load(): Promise<CategoryDecisionV1>;
}

export class FileDecisionProvider implements CategoryDecisionProvider {
  constructor(private readonly filePath: string) {}

  async load(): Promise<CategoryDecisionV1> {
    const raw = await fs.readFile(this.filePath, 'utf8');
    return JSON.parse(raw) as CategoryDecisionV1;
  }
}

// Future: AgentDecisionProvider — invokes the AI Agent to produce a decision on the fly.

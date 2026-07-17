import fs from 'node:fs';
import path from 'node:path';
import type { StoreProfileV2 } from '@auto-ozon/contracts';
import { validateStoreProfileV2 } from './store-profile-validator.js';

export interface StoreRegistry {
  list(): StoreProfileV2[];
  get(storeId: string): StoreProfileV2;
}

export class FileStoreRegistry implements StoreRegistry {
  constructor(private readonly file: string = path.join(process.cwd(), 'data', 'config', 'ozon-stores.local.json')) {}

  list(): StoreProfileV2[] {
    if (!fs.existsSync(this.file)) throw new Error('STORE_PROFILE_MISSING');
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw new Error('STORE_PROFILE_INVALID_JSON'); }
    if (!Array.isArray(parsed)) throw new Error('STORE_PROFILE_LIST_REQUIRED');
    return parsed.map((entry) => validateStoreProfileV2(entry));
  }

  get(storeId: string): StoreProfileV2 {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(storeId)) throw new Error('STORE_ID_INVALID');
    const profile = this.list().find((candidate) => candidate.store_id === storeId);
    if (!profile) throw new Error('STORE_PROFILE_NOT_FOUND');
    return profile;
  }
}

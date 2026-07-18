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

  updatePublishingEnabled(storeId: string, enabled: boolean): StoreProfileV2 {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(storeId)) throw new Error('STORE_ID_INVALID');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    let lockHandle: number | null = null;
    let temporary: string | null = null;
    try {
      try { lockHandle = fs.openSync(lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('STORE_PROFILE_LOCKED');
        throw error;
      }
      const original = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(original) as unknown;
      if (!Array.isArray(parsed)) throw new Error('STORE_PROFILE_LIST_REQUIRED');
      const stores = parsed.map((entry) => validateStoreProfileV2(entry));
      const index = stores.findIndex((candidate) => candidate.store_id === storeId);
      if (index < 0) throw new Error('STORE_PROFILE_NOT_FOUND');
      const updated = validateStoreProfileV2({
        ...stores[index]!,
        publishing: { ...stores[index]!.publishing, enabled },
      });
      stores[index] = updated;
      if (fs.readFileSync(this.file, 'utf8') !== original) throw new Error('STORE_PROFILE_CONCURRENT_MODIFICATION');
      temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      const handle = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify(stores, null, 2)}\n`, 'utf8');
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temporary, this.file);
      temporary = null;
      return updated;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('STORE_PROFILE_INVALID_JSON');
      throw error;
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
      if (lockHandle !== null) {
        fs.closeSync(lockHandle);
        fs.rmSync(lock, { force: true });
      }
    }
  }
}

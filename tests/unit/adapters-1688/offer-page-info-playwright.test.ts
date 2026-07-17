import {
  chromium,
  type Browser,
} from '../../../packages/adapters-1688/node_modules/playwright/index.js';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPageInfo } from '../../../packages/adapters-1688/src/engine/commands/offers.js';

const bundledChromiumAvailable = fs.existsSync(chromium.executablePath());
const describeWithBrowser = bundledChromiumAvailable ? describe : describe.skip;

describeWithBrowser('1688 offer page information in a real browser context', () => {
  let browser: Browser | undefined;

  if (bundledChromiumAvailable) {
    beforeAll(async () => {
      browser = await chromium.launch({
        headless: true,
        executablePath: chromium.executablePath(),
      });
    });
  }

  afterAll(async () => {
    await browser?.close();
  });

  it('reads window.context without relying on a host __name helper', async () => {
    const page = await browser!.newPage();
    await page.setContent('<html><head><title>测试商品 - 阿里巴巴</title></head><body></body></html>');
    await page.evaluate(() => {
      Reflect.deleteProperty(globalThis, '__name');
      Object.assign(window, {
        context: {
          result: {
            data: {
              productTitle: { fields: { title: '测试杯子' } },
              gallery: {
                fields: {
                  subject: '备用标题',
                  mainImage: ['https://img.example.com/cup.jpg'],
                },
              },
              description: { fields: { detailUrl: 'https://detail.example.com' } },
              breadcrumb: {
                fields: {
                  items: [
                    { name: '住宅和花园' },
                    { name: '餐具' },
                    { name: '杯子' },
                  ],
                },
              },
            },
          },
        },
      });
    });

    const result = await readPageInfo(page, {
      contextTimeoutMs: 100,
      scrollDelayMs: 0,
    });

    expect(result).toMatchObject({
      title: '测试杯子',
      mainImage: 'https://img.example.com/cup.jpg',
      categoryPathZh: ['住宅和花园', '餐具', '杯子'],
      detailUrl: 'https://detail.example.com',
    });
    await page.close();
  }, 30_000);

  it('uses the DOM fallback without relying on a host __name helper', async () => {
    const page = await browser!.newPage();
    await page.setContent(`
      <html>
        <head><title>备用商品 - 阿里巴巴</title></head>
        <body>
          <nav class="breadcrumb"><a>住宅和花园</a><span>餐具</span></nav>
          <div class="v-image-wrap"><img src="https://img.example.com/fallback.jpg"></div>
        </body>
      </html>
    `);
    await page.evaluate(() => {
      Reflect.deleteProperty(globalThis, '__name');
    });

    const result = await readPageInfo(page, {
      contextTimeoutMs: 25,
      scrollDelayMs: 0,
    });

    expect(result).toMatchObject({
      title: '备用商品',
      mainImage: 'https://img.example.com/fallback.jpg',
      categoryPathZh: ['住宅和花园', '餐具'],
      detailUrl: null,
      attributes: [],
      packageInfo: [],
    });
    await page.close();
  }, 30_000);
});

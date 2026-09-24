import { test as base, expect } from '@playwright/test';

type WalletFixture = {
  mockWallet: () => Promise<void>;
};

export const test = base.extend<WalletFixture>({
  mockWallet: async ({ page }, use) => {
    await use(async () => {
      await page.addInitScript(() => {
        (window as any).freighter = {
          isConnected: () => Promise.resolve(true),
          getPublicKey: () => Promise.resolve('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          signTransaction: (xdr: string) => Promise.resolve('signed_' + xdr),
          signAuthEntry: (entry: string) => Promise.resolve(new Uint8Array([1, 2, 3])),
        };
      });
    });
  },
});

export { expect };

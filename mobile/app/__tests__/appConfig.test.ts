// Android App Links (assetlinks.json) byly zrušeny (#18.1): odkaz jde přes custom
// scheme `dokulachtan://sign` a aplikaci vybírá systémový chooser. Test hlídá, že se
// do manifestu nevrátí `autoVerify` filtr pro https (vá zal by odkaz na podpis APK
// a na host zapečený v buildu, což u self-hosted instance nemá smysl).
import config from '../app.json';

describe('app.json', () => {
  it('nemá Android App Links a má custom scheme', () => {
    expect(Object.keys(config.expo.android)).not.toContain('intentFilters');
    expect(config.expo.scheme).toBe('dokulachtan');
  });

  it('drží produkční applicationId (varianty řeší withReleaseSigning)', () => {
    expect(config.expo.android.package).toBe('cz.dokulachtan.signer');
  });
});

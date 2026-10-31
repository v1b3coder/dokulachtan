// Předání lokálního PDF mezi obrazovkami (S14 → S11) nesmí nést cestu v URL.
// Test hlídá, že id je opaque, jednorázové a že cesta k souboru se nikdy
// nevrátí z `takePdf`, když ji appka sama nevložila do `offerPdf`.
import { offerPdf, takePdf } from '../src/lib/pdfHandoff';

const upload = {
  uri: 'file:///data/user/0/cz.dokulachtan.signer/cache/share-intent/smlouva.pdf',
  name: 'smlouva.pdf',
  type: 'application/pdf',
};

describe('pdfHandoff', () => {
  it('předá soubor jednou a vrátí opaque id, ne cestu', () => {
    const id = offerPdf(upload);

    expect(id).not.toContain('file');
    expect(id).not.toContain('/');

    expect(takePdf(id)).toEqual(upload);
    expect(takePdf(id)).toBeNull();
  });

  it('neznámé id nic nevrátí', () => {
    expect(
      takePdf('file:///data/user/0/cz.dokulachtan.signer/files/vault/certificate.json'),
    ).toBeNull();
    expect(takePdf(undefined)).toBeNull();
    expect(takePdf('')).toBeNull();
  });

  it('drží víc nabídek odděleně', () => {
    const first = offerPdf(upload);
    const second = offerPdf({ ...upload, name: 'jiny.pdf' });

    expect(first).not.toBe(second);
    expect(takePdf(second)).toEqual({ ...upload, name: 'jiny.pdf' });
    expect(takePdf(first)).toEqual(upload);
  });
});

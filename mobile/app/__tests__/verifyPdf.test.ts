import type { PdfVerification, PdfVerificationSignature } from '../src/lib/pdfApi';
import {
  canStore,
  coverageLabel,
  formatBytes,
  originLabel,
  revocationLabel,
  signatureEmails,
  signatureIssuer,
  signatureKindLabel,
  signatureTitle,
  verdictView,
} from '../src/lib/verifyPdf';

function signature(kind: PdfVerificationSignature['kind']): PdfVerificationSignature {
  return {
    kind,
    level: 'ades',
    intact: true,
    trusted: true,
    coverage: 'full',
    name: 'Jan Novák',
    emails: ['jan@firma.cz'],
    issuer_name: 'PostSignum Qualified CA 4 · Česká pošta, s.p. · CZ',
    serial: '0x1',
    signing_time: '2026-10-22T10:00:00Z',
    not_before: '2025-01-01T00:00:00Z',
    not_after: '2027-01-01T00:00:00Z',
    chain: [],
  };
}

function report(overrides: Partial<PdfVerification> = {}): PdfVerification {
  return {
    file: { name: 'contract.pdf', size: 2048, sha256: 'abc' },
    verdict: 'valid',
    intact: true,
    trusted: true,
    modified: false,
    level: 'ades',
    coverage: 'full',
    origin: 'external',
    revocation: 'not_checked',
    seal: { present: false, trusted: false, count: 0 },
    signatures: [],
    trusted_roots: [],
    messages: [],
    validated_at: '2026-10-22T10:00:00Z',
    stored: false,
    provider: 'local',
    provider_name: 'DocuSeal',
    provider_url: null,
    ...overrides,
  };
}

describe('verifyPdf', () => {
  it('maps a valid QES report to a success view', () => {
    expect(verdictView(report({ level: 'qes' }))).toEqual({
      title: 'Podpis je platný (QES)',
      subtitle: 'Dokument je podepsaný a od podpisu nebyl změněn.',
      tone: 'success',
    });
  });

  it('maps a valid AdES report to a success view', () => {
    expect(verdictView(report({ level: 'ades' })).title).toBe('Podpis je platný (AdES)');
  });

  it('maps an untrusted signature to a warning view', () => {
    expect(verdictView(report({ verdict: 'valid_untrusted', trusted: false }))).toEqual({
      title: 'Podpis je platný, ale certifikát není důvěryhodný',
      subtitle: 'Server nemá certifikát podepisujícího v důvěryhodných kořenech.',
      tone: 'warning',
    });
  });

  it('maps an unqualified signature to a warning view', () => {
    expect(verdictView(report({ verdict: 'valid_unqualified' })).tone).toBe('warning');
  });

  it('maps an externally verified signature to an external view', () => {
    expect(
      verdictView(report({ provider: 'eu_dss', provider_name: 'EU DSS', level: 'qes' })),
    ).toEqual({
      title: 'Podpis je platný (QES)',
      subtitle: 'Dokument je podepsaný a ověřený nezávisle přes EU DSS.',
      tone: 'success',
    });
  });

  it('explains an untrusted external certificate', () => {
    expect(
      verdictView(report({ provider: 'eu_dss', provider_name: 'EU DSS', verdict: 'valid_untrusted', trusted: false })),
    ).toEqual({
      title: 'Podpis je platný, ale certifikát není v EU trusted listu',
      subtitle: 'EU DSS nepotvrdil důvěryhodnost certifikátu.',
      tone: 'warning',
    });
  });

  it('distinguishes a modified document from an invalid signature', () => {
    expect(verdictView(report({ verdict: 'invalid', intact: true, modified: true }))).toEqual({
      title: 'PDF bylo po podpisu změněno',
      subtitle: 'Podpis už neodpovídá obsahu dokumentu.',
      tone: 'danger',
    });

    expect(verdictView(report({ verdict: 'invalid', intact: false })).title).toBe('Podpis je neplatný');
  });

  it('maps an unsigned document to a neutral view', () => {
    expect(verdictView(report({ verdict: 'unsigned', intact: false }))).toEqual({
      title: 'PDF není podepsané',
      subtitle: 'V dokumentu nejsou žádné digitální podpisy.',
      tone: 'neutral',
    });
  });

  it('allows storing only an intact, unmodified and not yet stored PDF', () => {
    expect(canStore(report())).toBe(true);
    expect(canStore(report({ modified: true }))).toBe(false);
    expect(canStore(report({ intact: false }))).toBe(false);
    expect(canStore(report({ stored: true }))).toBe(false);
  });

  it('does not store an external verification', () => {
    expect(canStore(report({ provider: 'eu_dss' }))).toBe(false);
  });

  it('formats coverage, origin and signature kinds', () => {
    expect(coverageLabel('full')).toBe('celý dokument');
    expect(coverageLabel('partial')).toBe('částečné');
    expect(coverageLabel('none')).toBe('žádné');
    expect(originLabel('docuseal')).toBe('PDF z DocuSealu');
    expect(originLabel('external')).toBe('PDF z jiného zdroje');
    expect(originLabel('unknown')).toBe('Původ neověřen');
    expect(revocationLabel('not_checked')).toBe('neověřeno');
    expect(revocationLabel('good')).toBe('ověřena (EU DSS)');
    expect(revocationLabel('revoked')).toBe('certifikát je revokován');
    expect(revocationLabel('unknown')).toBe('nepodařilo se ověřit');
    expect(signatureKindLabel(signature('qes'))).toBe('Podpis');
    expect(signatureKindLabel(signature('seal'))).toBe('Pečeť DocuSealu');
    expect(signatureKindLabel(signature('timestamp'))).toBe('Časové razítko');
  });

  it('formats file sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('shows the certificate name, all e-mails and the issuing authority', () => {
    expect(signatureTitle(signature('qes'))).toBe('Jan Novák');
    expect(signatureEmails({ ...signature('qes'), emails: ['jan@firma.cz', 'druhy@firma.cz'] }))
      .toBe('jan@firma.cz, druhy@firma.cz');
    expect(signatureIssuer(signature('qes')))
      .toBe('PostSignum Qualified CA 4 · Česká pošta, s.p. · CZ');
  });

  it('falls back to the signature kind when the certificate has no name', () => {
    expect(signatureTitle({ ...signature('seal'), name: null })).toBe('Pečeť DocuSealu');
  });

  it('handles a certificate without e-mail and an unknown issuer', () => {
    expect(signatureEmails({ ...signature('qes'), emails: [] })).toBe('');
    expect(signatureIssuer({ ...signature('qes'), issuer_name: null })).toBe('neznámý');
  });
});

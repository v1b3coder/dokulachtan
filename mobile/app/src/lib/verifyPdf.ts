import type { PdfCoverage, PdfVerification, PdfVerificationSignature, PdfVerdict } from './pdfApi';

export type VerdictTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface VerdictView {
  title: string;
  subtitle: string;
  tone: VerdictTone;
}

export function verdictView(report: PdfVerification): VerdictView {
  const external = report.provider === 'eu_dss';

  switch (report.verdict) {
    case 'valid':
      return {
        title: report.level === 'qes' ? 'Podpis je platný (QES)' : 'Podpis je platný (AdES)',
        subtitle: external
          ? 'Dokument je podepsaný a ověřený nezávisle přes EU DSS.'
          : 'Dokument je podepsaný a od podpisu nebyl změněn.',
        tone: 'success',
      };
    case 'valid_untrusted':
      return {
        title: external
          ? 'Podpis je platný, ale certifikát není v EU trusted listu'
          : 'Podpis je platný, ale certifikát není důvěryhodný',
        subtitle: external
          ? 'EU DSS nepotvrdil důvěryhodnost certifikátu.'
          : 'Server nemá certifikát podepisujícího v důvěryhodných kořenech.',
        tone: 'warning',
      };
    case 'valid_unqualified':
      return {
        title: 'PDF je podepsané, ale ne kvalifikovaným podpisem',
        subtitle: 'Obsahuje jen pečeť nebo podpis bez kvalifikovaného certifikátu.',
        tone: 'warning',
      };
    case 'invalid':
      return {
        title: report.modified ? 'PDF bylo po podpisu změněno' : 'Podpis je neplatný',
        subtitle: report.modified
          ? 'Podpis už neodpovídá obsahu dokumentu.'
          : 'Kryptografická kontrola podpisu selhala.',
        tone: 'danger',
      };
    case 'unsigned':
      return {
        title: 'PDF není podepsané',
        subtitle: 'V dokumentu nejsou žádné digitální podpisy.',
        tone: 'neutral',
      };
  }
}

// Externí ověření se do DocuSealu neukládá (report by vznikl na serveru);
// store zůstává jen pro lokální ověření.
export function canStore(report: PdfVerification): boolean {
  return report.provider === 'local' && report.intact && !report.modified && !report.stored;
}

export function coverageLabel(coverage: PdfCoverage): string {
  switch (coverage) {
    case 'full':
      return 'celý dokument';
    case 'partial':
      return 'částečné';
    case 'none':
      return 'žádné';
  }
}

export function originLabel(origin: PdfVerification['origin']): string {
  if (origin === 'docuseal') {
    return 'PDF z DocuSealu';
  }

  if (origin === 'external') {
    return 'PDF z jiného zdroje';
  }

  return 'Původ neověřen';
}

export function revocationLabel(revocation: PdfVerification['revocation']): string {
  switch (revocation) {
    case 'not_checked':
      return 'neověřeno';
    case 'good':
      return 'ověřena (EU DSS)';
    case 'revoked':
      return 'certifikát je revokován';
    case 'unknown':
      return 'nepodařilo se ověřit';
  }
}

export function signatureKindLabel(signature: PdfVerificationSignature): string {
  switch (signature.kind) {
    case 'qes':
      return 'Podpis';
    case 'seal':
      return 'Pečeť DocuSealu';
    case 'timestamp':
      return 'Časové razítko';
    case 'other':
      return 'Podpis';
  }
}

// Jméno podepisujícího z certifikátu: CN, jinak givenName + surname
// (server posílá hotové `name`; u EU DSS je to `SignedBy`).
export function signatureTitle(signature: PdfVerificationSignature): string {
  return signature.name || signatureKindLabel(signature);
}

// Vydavatel certifikátu lidsky (server posílá `issuer_name`, např.
// „PostSignum Qualified CA 4 · Česká pošta, s.p. · CZ“); raw `/C=CZ/…`
// zůstává jen v reportu pro technické detaily.
export function signatureIssuer(signature: PdfVerificationSignature): string {
  return signature.issuer_name || 'neznámý';
}

// Všechny e-maily z certifikátu (SAN, teoreticky víc adres) jako jeden řádek.
export function signatureEmails(signature: PdfVerificationSignature): string {
  return signature.emails.join(', ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(value: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('cs-CZ');
}

export function verdictIcon(tone: VerdictTone): string {
  switch (tone) {
    case 'success':
      return '✓';
    case 'warning':
      return '!';
    case 'danger':
      return '×';
    case 'neutral':
      return 'i';
  }
}

export function verdictColor(tone: VerdictTone): string {
  switch (tone) {
    case 'success':
      return '#166534';
    case 'warning':
      return '#b45309';
    case 'danger':
      return '#991b1b';
    case 'neutral':
      return '#6b7280';
  }
}

export function verdictBackground(tone: VerdictTone): string {
  switch (tone) {
    case 'success':
      return '#dcfce7';
    case 'warning':
      return '#fef3c7';
    case 'danger':
      return '#fee2e2';
    case 'neutral':
      return '#f3f4f6';
  }
}

export type { PdfVerdict };

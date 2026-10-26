// Externí ověření PDF přes veřejné REST API EU DSS (docs/19).
// Appka volá demo EU DSS přímo, DocuSeal se nemění. PDF se odesílá na servery
// Evropské komise, proto je externí volba vždy opt-in se souhlasem.
import { File } from 'expo-file-system';
import forge from 'node-forge';

import { copyPdf } from '../../modules/dokulachtan-open-pdf';
import { toBase64 } from './crypto/softwareSigner';
import type {
  PdfCoverage,
  PdfUpload,
  PdfVerification,
  PdfVerificationSignature,
  PdfVerdict,
} from './pdfApi';
import type { QesLevel } from './types';

export const EU_DSS_URL =
  'https://ec.europa.eu/digital-building-blocks/DSS/webapp-demo/services/rest/validation/validateSignature';
export const EU_DSS_TIMEOUT_MS = 20_000;

export class EuDssError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

interface DssDetail {
  value?: string;
  Key?: string;
}

interface DssCertificate {
  QualifiedName?: string;
  Id?: string;
}

interface DssSignature {
  Id?: string;
  SignedBy?: string;
  Indication?: string;
  SubIndication?: string;
  SigningTime?: string;
  SignatureFormat?: string;
  SignatureLevel?: { value?: string };
  SignatureScope?: { value?: string; scope?: string }[];
  CertificateChain?: { Certificate?: DssCertificate[] };
  AdESValidationDetails?: { Error?: DssDetail[]; Warning?: DssDetail[]; Info?: DssDetail[] };
  QualificationDetails?: { Error?: DssDetail[]; Warning?: DssDetail[]; Info?: DssDetail[] };
}

interface DssDetailedSignature {
  Id?: string;
  ValidationSignatureQualification?: { SignatureQualification?: string };
}

interface DssReport {
  SimpleReport?: {
    ValidationTime?: string;
    ValidSignaturesCount?: number;
    SignaturesCount?: number;
    signatureOrTimestampOrEvidenceRecord?: { Signature?: DssSignature }[];
  };
  DetailedReport?: {
    signatureOrTimestampOrEvidenceRecord?: { Signature?: DssDetailedSignature }[];
  };
}

export interface EuDssApiOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
  readBase64?: (file: PdfUpload) => Promise<string>;
}

export class EuDssApi {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly readBase64: (file: PdfUpload) => Promise<string>;

  constructor(options: EuDssApiOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.url = options.url ?? EU_DSS_URL;
    this.timeoutMs = options.timeoutMs ?? EU_DSS_TIMEOUT_MS;
    this.readBase64 = options.readBase64 ?? readFileBase64;
  }

  async verifyDocument(file: PdfUpload): Promise<PdfVerification> {
    let base64: string;

    try {
      base64 = await this.readBase64(file);
    } catch (error) {
      if (error instanceof EuDssError) {
        throw error;
      }

      throw new EuDssError(
        'invalid_pdf',
        error instanceof Error ? error.message : undefined,
      );
    }

    if (!base64.startsWith('JVBERi0')) {
      throw new EuDssError('invalid_pdf', 'Not a PDF');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ signedDocument: { bytes: base64, name: file.name } }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 429 a 5xx jsou „služba teď nemůže“, 4xx je odmítnuté PDF.
        const code = response.status === 429 || response.status >= 500
          ? 'eu_dss_unavailable'
          : 'eu_dss_error';

        throw new EuDssError(code, `HTTP ${response.status}`);
      }

      const payload: unknown = await response.json();

      if (!isDssReport(payload)) {
        throw new EuDssError('eu_dss_error', 'Invalid EU DSS response');
      }

      return mapReport(file, base64, payload, this.url);
    } catch (error) {
      if (error instanceof EuDssError) {
        throw error;
      }

      throw new EuDssError(
        'eu_dss_unavailable',
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readFileBase64(file: PdfUpload): Promise<string> {
  if (file.bytes) {
    return toBase64(file.bytes);
  }

  if (!file.uri) {
    throw new EuDssError('invalid_pdf');
  }

  // DocumentPicker i share intent dávají `content://`; `File` umí jen `file://`.
  // Nativní modul obsah zkopíruje do cache a vrátí `file://`.
  const uri = file.uri.startsWith('content://')
    ? (await copyPdf(file.uri, file.name))?.uri
    : file.uri;

  if (!uri) {
    throw new EuDssError('invalid_pdf');
  }

  return new File(uri).base64();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDssReport(value: unknown): value is DssReport {
  return isRecord(value) && (isRecord(value.SimpleReport) || isRecord(value.DetailedReport));
}

function mapReport(
  file: PdfUpload,
  base64: string,
  payload: DssReport,
  url: string,
): PdfVerification {
  const simple = payload.SimpleReport ?? {};
  const detailed = payload.DetailedReport ?? {};
  const qualifications = new Map<string, string>();

  for (const item of detailed.signatureOrTimestampOrEvidenceRecord ?? []) {
    const signature = item.Signature;

    if (signature?.Id) {
      qualifications.set(
        signature.Id,
        signature.ValidationSignatureQualification?.SignatureQualification ?? '',
      );
    }
  }

  const entries = (simple.signatureOrTimestampOrEvidenceRecord ?? [])
    .map((item) => item.Signature)
    .filter((signature): signature is DssSignature => Boolean(signature));
  const signatures = entries.map((signature) =>
    mapSignature(signature, qualifications.get(signature.Id ?? '') ?? ''),
  );
  const qes = signatures.filter((signature) => signature.kind === 'qes');
  const seals = signatures.filter((signature) => signature.kind === 'seal');
  const last = qes[qes.length - 1];
  const size = file.bytes?.length ?? (file.uri ? new File(file.uri).size : 0);

  return {
    file: { name: file.name, size, sha256: sha256Hex(base64) },
    verdict: computeVerdict(signatures),
    intact: signatures.length > 0 && signatures.every((signature) => signature.intact),
    trusted: qes.length > 0 && qes.every((signature) => signature.trusted),
    modified: signatures.some((signature) => !signature.intact),
    level: last?.level ?? 'none',
    coverage: last?.coverage ?? 'none',
    origin: 'unknown',
    revocation: revocationFor(entries),
    seal: { present: seals.length > 0, trusted: false, count: seals.length },
    signatures: signatures.filter(
      (signature) => signature.kind !== 'seal' && signature.kind !== 'timestamp',
    ),
    trusted_roots: [],
    messages: messagesFor(entries),
    validated_at: simple.ValidationTime ?? new Date().toISOString(),
    stored: false,
    provider: 'eu_dss',
    provider_name: 'EU DSS',
    provider_url: url,
  };
}

function mapSignature(signature: DssSignature, qualification: string): PdfVerificationSignature {
  const indication = signature.Indication ?? '';
  const subIndication = signature.SubIndication ?? '';
  const chain = (signature.CertificateChain?.Certificate ?? [])
    .map((certificate) => certificate.QualifiedName ?? '')
    .filter((name) => name.length > 0);

  return {
    kind: kindFor(signature, qualification),
    level: levelFor(qualification),
    intact: intactFor(indication, subIndication),
    // DSS vrací i `AdESig-QC` (AdES s kvalifikovaným certifikátem);
    // ten je důvěryhodný stejně jako `QESig`/`AdESig`, ale nesmí se zaměnit.
    trusted: indication === 'TOTAL_PASSED' && qualification.includes('Sig'),
    coverage: coverageFor(signature.SignatureScope),
    common_name: signature.SignedBy ?? null,
    subject: chain[0] ?? null,
    issuer: chain[1] ?? null,
    serial: null,
    signing_time: signature.SigningTime ?? null,
    not_before: null,
    not_after: null,
    chain,
  };
}

function kindFor(
  signature: DssSignature,
  qualification: string,
): PdfVerificationSignature['kind'] {
  if (qualification.includes('Seal')) {
    return 'seal';
  }

  if (qualification.includes('Sig')) {
    return 'qes';
  }

  // Kvalifikaci DSS neumí určit (např. test cert bez EU trusted listu);
  // pečeť DocuSealu se pozná podle názvu nebo formátu s časovým razítkem.
  if (signature.SignedBy === 'DocuSeal' || signature.SignatureFormat === 'PKCS7-T') {
    return 'seal';
  }

  // Bez qualification DSS zůstává podpis podepisujícího QES/AdES; `level`
  // zůstane `none`, ale UI nesmí hlásit „ne kvalifikovaný podpis“.
  return signature.SignatureFormat?.startsWith('PAdES') ||
    signature.SignatureFormat?.startsWith('CAdES')
    ? 'qes'
    : 'other';
}

function levelFor(qualification: string): QesLevel {
  if (qualification === 'QESig' || qualification === 'QESeal') {
    return 'qes';
  }

  if (qualification.startsWith('AdES')) {
    return 'ades';
  }

  return 'none';
}

function intactFor(indication: string, subIndication: string): boolean {
  if (indication === 'TOTAL_FAILED') {
    return false;
  }

  return !['HASH_FAILURE', 'SIG_CRYPTO_FAILURE', 'FORMAT_FAILURE'].includes(subIndication);
}

function coverageFor(scopes: DssSignature['SignatureScope']): PdfCoverage {
  if (!scopes || scopes.length === 0) {
    return 'none';
  }

  return scopes.some((scope) => scope.scope === 'FULL') ? 'full' : 'partial';
}

function revocationFor(signatures: DssSignature[]): PdfVerification['revocation'] {
  if (signatures.length === 0) {
    return 'not_checked';
  }

  if (signatures.some((signature) => ['REVOKED', 'REVOKED_NO_POE', 'REVOKED_CA_NO_POE'].includes(signature.SubIndication ?? ''))) {
    return 'revoked';
  }

  if (signatures.every((signature) => signature.Indication === 'TOTAL_PASSED')) {
    return 'good';
  }

  return 'unknown';
}

function messagesFor(signatures: DssSignature[]): PdfVerification['messages'] {
  return signatures.flatMap((signature) => {
    const details = signature.AdESValidationDetails;
    const qualification = signature.QualificationDetails;

    return [
      ...(details?.Error ?? []).map((detail) => ({
        status: 'error' as const,
        text: detail.value ?? detail.Key ?? '',
      })),
      ...(details?.Warning ?? []).map((detail) => ({
        status: 'warning' as const,
        text: detail.value ?? detail.Key ?? '',
      })),
      ...(qualification?.Error ?? []).map((detail) => ({
        status: 'error' as const,
        text: detail.value ?? detail.Key ?? '',
      })),
      ...(qualification?.Warning ?? []).map((detail) => ({
        status: 'warning' as const,
        text: detail.value ?? detail.Key ?? '',
      })),
    ];
  });
}

function computeVerdict(signatures: PdfVerificationSignature[]): PdfVerdict {
  if (signatures.length === 0) {
    return 'unsigned';
  }

  if (signatures.some((signature) => !signature.intact)) {
    return 'invalid';
  }

  const qes = signatures.filter((signature) => signature.kind === 'qes');

  if (qes.length === 0) {
    return 'valid_unqualified';
  }

  if (qes.some((signature) => !signature.trusted)) {
    return 'valid_untrusted';
  }

  return 'valid';
}

function sha256Hex(base64: string): string {
  const digest = forge.md.sha256.create();

  digest.update(forge.util.decode64(base64));

  return digest.digest().toHex();
}

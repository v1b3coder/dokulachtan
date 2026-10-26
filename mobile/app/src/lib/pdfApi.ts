// API přímého podpisu PDF (docs/15 § 5): appka nahrává PDF přes DocuSeal API
// a používá standardní tok — šablona s polem `qes`, submission a běžný obřad.
// API token je v SecureStore (nastavení), nikdy se neloguje.
import { assertResponseOrigin, signingOrigin } from './signingOrigin';
import type { QesLevel } from './types';

export const PDF_API_SETTINGS_KEY = 'cz.dokulachtan.signer.api';

export class PdfApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export interface PdfApiStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface PdfApiSettings {
  serverUrl: string;
  apiToken: string;
}

export async function loadPdfApiSettings(storage: PdfApiStorage): Promise<PdfApiSettings | null> {
  const raw = await storage.getItem(PDF_API_SETTINGS_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PdfApiSettings;

    return typeof parsed.serverUrl === 'string' && parsed.serverUrl.length > 0
      ? { serverUrl: parsed.serverUrl, apiToken: typeof parsed.apiToken === 'string' ? parsed.apiToken : '' }
      : null;
  } catch {
    return null;
  }
}

export async function savePdfApiSettings(storage: PdfApiStorage, settings: PdfApiSettings): Promise<void> {
  await storage.setItem(PDF_API_SETTINGS_KEY, JSON.stringify(settings));
}

export interface PdfPage {
  index: number;
  width: number;
  height: number;
  preview_url: string;
}

export interface PdfArea {
  uuid?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  attachment_uuid: string;
}

export interface PdfField {
  uuid: string;
  name: string;
  type: string;
  submitter_uuid: string;
  required: boolean;
  preferences: { level?: QesLevel };
  areas: PdfArea[];
}

export interface PdfDocument {
  template_id: number;
  folder: string;
  submitter_role: string;
  field: PdfField;
  document: { uuid: string; filename: string; pages: PdfPage[] };
  stamp: { width: number; height: number };
}

export interface PdfSubmitter {
  id: number;
  slug: string;
  name: string;
  email: string;
}

export interface PdfUser {
  id: number;
  email: string;
  first_name?: string;
  last_name?: string;
}

export interface PdfUpload {
  uri?: string;
  name: string;
  type: string;
  bytes?: Uint8Array;
}

export type PdfProvider = 'local' | 'eu_dss';

export type PdfVerdict =
  | 'valid'
  | 'valid_untrusted'
  | 'valid_unqualified'
  | 'invalid'
  | 'unsigned';

export type PdfCoverage = 'full' | 'partial' | 'none';

export interface PdfVerificationSignature {
  kind: 'qes' | 'seal' | 'timestamp' | 'other';
  level: QesLevel;
  intact: boolean;
  trusted: boolean;
  coverage: PdfCoverage;
  common_name: string | null;
  subject: string | null;
  issuer: string | null;
  serial: string | null;
  signing_time: string | null;
  not_before: string | null;
  not_after: string | null;
  chain: string[];
}

export interface PdfVerification {
  file: { name: string; size: number; sha256: string };
  verdict: PdfVerdict;
  intact: boolean;
  trusted: boolean;
  modified: boolean;
  level: QesLevel;
  coverage: PdfCoverage;
  origin: 'docuseal' | 'external' | 'unknown';
  revocation: 'not_checked' | 'good' | 'revoked' | 'unknown';
  seal: { present: boolean; trusted: boolean; count: number };
  signatures: PdfVerificationSignature[];
  trusted_roots: string[];
  messages: { status: 'success' | 'warning' | 'error'; text: string }[];
  validated_at: string;
  stored: boolean;
  provider: PdfProvider;
  provider_name: string;
  provider_url: string | null;
  template_id?: number;
  folder?: string;
}

export interface PdfApiOptions {
  fetchImpl?: typeof fetch;
}

export class PdfApi {
  private readonly serverUrl: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(serverUrl: string, apiToken: string, options: PdfApiOptions = {}) {
    this.serverUrl = signingOrigin(serverUrl);
    this.apiToken = apiToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async user(): Promise<PdfUser> {
    return this.request<PdfUser>('GET', '/api/user');
  }

  // Nahrání PDF: DocuSeal založí šablonu ve složce „Direct signing“ s jedním
  // podepisujícím a jedním polem `qes` a vrátí stránky s náhledy.
  async createDocument(
    file: PdfUpload,
    params: { displayName?: string; levelRequired?: QesLevel } = {},
  ): Promise<PdfDocument> {
    const form = new FormData();

    form.append('file', this.toBlob(file));

    if (params.displayName) {
      form.append('display_name', params.displayName);
    }

    if (params.levelRequired) {
      form.append('level_required', params.levelRequired);
    }

    return this.request<PdfDocument>('POST', '/api/qes/documents', form);
  }

  // Ověření PDF (docs/16): server vrátí report, PDF se neukládá.
  // `provider` je vždy lokální; externí ověření jde přes EU DSS v appce.
  async verifyDocument(file: PdfUpload): Promise<PdfVerification> {
    const report = await this.postPdf<Omit<PdfVerification, 'provider' | 'provider_name' | 'provider_url'>>(
      '/api/qes/verify',
      file,
    );

    return { ...report, provider: 'local', provider_name: 'DocuSeal', provider_url: null };
  }

  // Explicitní uložení ověřeného PDF do složky „Verified documents“.
  async storeVerifiedDocument(file: PdfUpload): Promise<PdfVerification> {
    const report = await this.postPdf<Omit<PdfVerification, 'provider' | 'provider_name' | 'provider_url'>>(
      '/api/qes/verified_documents',
      file,
    );

    return { ...report, provider: 'local', provider_name: 'DocuSeal', provider_url: null };
  }

  // Umístění pečeti = oblast pole `qes` v šabloně (normalizovaně, y shora).
  async setStampArea(
    document: PdfDocument,
    area: { x: number; y: number; w: number; h: number; page: number },
  ): Promise<void> {
    const field: PdfField = {
      ...document.field,
      areas: [{ ...area, attachment_uuid: document.document.uuid }],
    };

    await this.request('PATCH', `/api/templates/${document.template_id}`, { fields: [field] });
  }

  async createSubmission(
    document: PdfDocument,
    submitter: { name: string; email: string },
  ): Promise<PdfSubmitter> {
    const body = await this.request<unknown>('POST', `/api/templates/${document.template_id}/submissions`, {
      send_email: false,
      submitters: [{ role: document.submitter_role, name: submitter.name, email: submitter.email }],
    });

    const submitters = (Array.isArray(body) ? body : (body as { submitters: PdfSubmitter[] }).submitters) ?? [];

    if (submitters.length === 0) {
      throw new PdfApiError(422, 'submitter_missing');
    }

    return submitters[0] as PdfSubmitter;
  }

  // Spuštění obřadu (endpoint podpisového formuláře; slug je kapabilita).
  async startSession(submitterSlug: string, fieldUuid: string): Promise<{ token: string }> {
    return this.request<{ token: string }>(
      'POST',
      `/s/${encodeURIComponent(submitterSlug)}/qes_sessions`,
      { field_uuid: fieldUuid },
    );
  }

  // Dokončení submissionu: DocuSeal vygeneruje finální PDF a auditní stránku.
  async completeSubmission(submitterId: number): Promise<void> {
    try {
      await this.request('PUT', `/api/submitters/${submitterId}`, { completed: true });
    } catch (err) {
      // Odpověď prvního PUT se mohla ztratit; dokumenty pak načte downloadDocument.
      if (!(err instanceof PdfApiError) || err.status !== 422
        || err.code !== 'Submitter has already completed the submission.') throw err;
    }
  }

  // Finální PDF z DocuSealu (podepsané PDF, nikoli auditní stránka).
  // Vrací podepsanou URL; soubor stahuje appka nativně (docs/15 § 7.1).
  async documentUrl(submitterId: number): Promise<string> {
    const body = await this.request<{ documents: { name: string; url: string }[] }>(
      'GET',
      `/api/submitters/${submitterId}`,
    );

    const url = body.documents?.[0]?.url;

    if (!url) {
      throw new PdfApiError(404, 'document_missing');
    }

    return url;
  }

  private async postPdf<T>(path: string, file: PdfUpload): Promise<T> {
    const form = new FormData();

    form.append('file', this.toBlob(file));

    return this.request<T>('POST', path, form);
  }

  private toBlob(file: PdfUpload): Blob {
    // React Native bere `{uri, name, type}` v multipartu jako soubor; `bytes`
    // používají jen testy a e2e v Node.
    if (file.uri) {
      return { uri: file.uri, name: file.name, type: file.type } as unknown as Blob;
    }

    return new Blob([new Uint8Array(file.bytes ?? new Uint8Array())], { type: file.type });
  }

  private headers(): Record<string, string> {
    return { 'X-Auth-Token': this.apiToken, Accept: 'application/json', 'X-QES-Protocol': '1' };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const form = body instanceof FormData;
    // Tělo se posílá jen tam, kam patří (GET/HEAD nesmí mít tělo).
    const encoded = form ? body : body === undefined ? undefined : JSON.stringify(body);
    const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
      method,
      headers: form ? this.headers() : { ...this.headers(), 'Content-Type': 'application/json' },
      body: encoded,
    });

    assertResponseOrigin(response, this.serverUrl);

    if (!response.ok) {
      await throwError(response);
    }

    const text = await response.text();

    return (text.length > 0 ? JSON.parse(text) : {}) as T;
  }
}

async function throwError(response: Response): Promise<never> {
  const text = await response.text();
  let payload: { error?: string; message?: string } = {};

  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  const code = payload.error === 'Not authenticated' ? 'not_authenticated' : (payload.error ?? 'server_error');

  throw new PdfApiError(response.status, code, payload.message);
}

// Mapování klepnutí na normalizované souřadnice (docs/15 § 7.3): z obdélníku
// obrázku náhledu (`contain`) na střed pečeti 0-1 od levého horního rohu.
export function tapToPosition(
  tap: { x: number; y: number },
  box: { x0: number; y0: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: clamp01((tap.x - box.x0) / box.width),
    y: clamp01((tap.y - box.y0) / box.height),
  };
}

// Obrys pečeti v zobrazeném náhledu (poměr stran stránky je stejný).
export function stampOutline(
  position: { x: number; y: number },
  box: { x0: number; y0: number; width: number; height: number },
  page: { width: number; height: number },
  stamp: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const width = (stamp.width / page.width) * box.width;
  const height = (stamp.height / page.height) * box.height;

  return {
    left: box.x0 + position.x * box.width - width / 2,
    top: box.y0 + position.y * box.height - height / 2,
    width,
    height,
  };
}

// Oblast pole v šabloně: levý horní roh pečeti, normalizovaně 0-1 od shora.
export function stampArea(
  center: { x: number; y: number },
  page: { width: number; height: number },
  stamp: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const w = clamp01(stamp.width / page.width);
  const h = clamp01(stamp.height / page.height);

  return {
    x: Math.min(Math.max(center.x - w / 2, 0), 1 - w),
    y: Math.min(Math.max(center.y - h / 2, 0), 1 - h),
    w,
    h,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Klient QES API (SPEC § 5): token je jen v paměti, nikdy se neukládá.
import { assertResponseOrigin, signingOrigin } from './signingOrigin';

import type {
  QesAppMetadata,
  QesCertificatePayload,
  QesCertificateRequest,
  QesCompletedPayload,
  QesSessionPayload,
  SessionSource,
} from './types';

export class QesApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export interface QesApiOptions {
  serverUrl?: string;
  fetchImpl?: typeof fetch;
}

export class QesApi implements SessionSource {
  private readonly serverUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  constructor(serverUrl: string, token: string, options: QesApiOptions = {}) {
    this.serverUrl = signingOrigin(options.serverUrl ?? serverUrl);
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getSession(): Promise<QesSessionPayload> {
    return this.request<QesSessionPayload>('GET', `/qes/sessions/${encodeURIComponent(this.token)}`);
  }

  async getDocument(): Promise<Uint8Array> {
    const response = await this.fetchImpl(
      `${this.serverUrl}/qes/sessions/${encodeURIComponent(this.token)}/document`,
      { method: 'GET', headers: { Accept: 'application/pdf', 'X-QES-Protocol': '1' } },
    );
    assertResponseOrigin(response, this.serverUrl);
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      throw new QesApiError(response.status, payload.error ?? 'server_error');
    }
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') {
      throw new QesApiError(422, 'document_mismatch');
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async postCertificate(body: QesCertificateRequest): Promise<QesCertificatePayload> {
    return this.request<QesCertificatePayload>(
      'POST',
      `/qes/sessions/${encodeURIComponent(this.token)}/certificate`,
      body,
    );
  }

  async postComplete(signatureBase64: string): Promise<QesCompletedPayload> {
    return this.request<QesCompletedPayload>(
      'POST',
      `/qes/sessions/${encodeURIComponent(this.token)}/complete`,
      { signature: signatureBase64 },
    );
  }

  // Dokončení submissionu je vázané na session token, ne na submitter
  // z odkazu a plný API token účtu (S1).
  async completeSubmission(): Promise<{ state: string; submitter_id: number; completed: boolean }> {
    return this.request('POST', `/qes/sessions/${encodeURIComponent(this.token)}/complete_submission`);
  }

  async postAbort(code: string, message?: string): Promise<{ state: string }> {
    return this.request<{ state: string }>(
      'POST',
      `/qes/sessions/${encodeURIComponent(this.token)}/abort`,
      { code, message },
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-QES-Protocol': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    assertResponseOrigin(response, this.serverUrl);

    const payload = await readJsonPayload<T & { error?: string; message?: string }>(response);

    if (!response.ok) {
      throw new QesApiError(response.status, payload.error ?? 'server_error', payload.message);
    }

    return payload;
  }
}

// Chybová odpověď může být HTML (404/500 stránka), ne jen JSON; `response.json()`
// by jinak shodilo celý obřad na „Unexpected character: <“.
async function readErrorPayload(response: Response): Promise<{ error?: string }> {
  const text = await response.text();

  try {
    const parsed = text.length > 0 ? JSON.parse(text) : {};

    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function readJsonPayload<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (text.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new QesApiError(response.status, 'invalid_response');
  }
}

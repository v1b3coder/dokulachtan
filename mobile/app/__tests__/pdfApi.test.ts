import { File, Paths } from 'expo-file-system';

import { PdfApi, PdfApiError, type PdfUpload, stampArea, stampOutline, tapToPosition } from '../src/lib/pdfApi';

function jsonResponse(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  Object.defineProperty(response, 'url', { value: 'https://server/api/templates/7' });

  return response;
}

const document = {
  template_id: 7,
  folder: 'Direct signing',
  submitter_role: 'Jan Novák',
  field: {
    uuid: 'field-1',
    name: 'Certificate signature',
    type: 'qes',
    submitter_uuid: 'submitter-1',
    required: true,
    preferences: { level: 'ades' as const },
    areas: [],
  },
  document: {
    uuid: 'doc-1',
    filename: 'contract.pdf',
    pages: [{ index: 0, width: 595, height: 842, preview_url: 'https://server/file/0.png' }],
  },
  stamp: { width: 150, height: 44 },
};

describe('PdfApi', () => {
  it('uploads the PDF with the API token and returns the template', async () => {
    const calls: { url: string; token: string | null; body: BodyInit | null | undefined }[] = [];
    const api = new PdfApi('https://server/', 'secret', {
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          token: (init?.headers as Record<string, string>)['X-Auth-Token'] ?? null,
          body: init?.body,
        });

        return jsonResponse(document, 201);
      }) as typeof fetch,
    });

    const created = await api.createDocument(
      { name: 'contract.pdf', type: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) },
      { displayName: 'Jan Novák', levelRequired: 'ades' },
    );

    expect(created.template_id).toBe(7);
    expect(calls[0].url).toBe('https://server/api/qes/documents');
    expect(calls[0].token).toBe('secret');
    expect(calls[0].body).toBeInstanceOf(FormData);
  });

  it('sends a picked PDF as expo-file-system File (Expo fetch neumí RN {uri})', async () => {
    const api = new PdfApi('https://server', 'secret', { fetchImpl: jest.fn() as unknown as typeof fetch });
    const pdf = new File(Paths.cache, 'contract.pdf');

    pdf.create({ overwrite: true });
    await pdf.write(new Uint8Array([1, 2, 3]));

    const part = (await (api as unknown as { toBlob(file: PdfUpload): Promise<unknown> }).toBlob({
      uri: pdf.uri,
      name: 'contract.pdf',
      type: 'application/pdf',
    })) as { uri?: string; name?: string; type?: string; bytes?: () => Promise<Uint8Array> };

    // Expo fetch (SDK 58) umí jen `bytes`, ne RN tvar `{uri, name, type}`.
    expect(part.uri).toBeUndefined();
    expect(part.name).toBe('contract.pdf');
    expect(part.type).toBe('application/pdf');
    expect(typeof part.bytes).toBe('function');
    expect(Array.from(await part.bytes!())).toEqual([1, 2, 3]);
  });

  it('sets the stamp area as a template field', async () => {
    const calls: { url: string; method: string | undefined; body: string }[] = [];
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), method: init?.method, body: String(init?.body) });

        return jsonResponse({ id: 7 });
      }) as typeof fetch,
    });

    await api.setStampArea(document, { x: 0.5, y: 0.2, w: 0.25, h: 0.05, page: 0 });

    const body = JSON.parse(calls[0].body);

    expect(calls[0].url).toBe('https://server/api/templates/7');
    expect(calls[0].method).toBe('PATCH');
    expect(body.fields[0].uuid).toBe('field-1');
    expect(body.fields[0].areas[0]).toEqual({
      x: 0.5,
      y: 0.2,
      w: 0.25,
      h: 0.05,
      page: 0,
      attachment_uuid: 'doc-1',
    });
  });

  it('creates the submission and returns the submitter', async () => {
    const calls: { url: string; body: string }[] = [];
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });

        return jsonResponse([{ id: 11, slug: 'abc', name: 'Jan Novák', email: 'jan@example.com' }]);
      }) as typeof fetch,
    });

    const submitter = await api.createSubmission(document, { name: 'Jan Novák', email: 'jan@example.com' });
    const body = JSON.parse(calls[0].body);

    expect(submitter.id).toBe(11);
    expect(submitter.slug).toBe('abc');
    expect(calls[0].url).toBe('https://server/api/templates/7/submissions');
    expect(body.send_email).toBe(false);
    expect(body.submitters[0].role).toBe('Jan Novák');
  });

  it('starts the ceremony through the signing form endpoint', async () => {
    const calls: string[] = [];
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);

        return jsonResponse({ token: 'tok' }, 201);
      }) as typeof fetch,
    });

    const session = await api.startSession('abc', 'field-1');

    expect(session.token).toBe('tok');
    expect(calls).toEqual(['POST https://server/s/abc/qes_sessions']);
  });

  it('returns the final PDF URL', async () => {
    const calls: string[] = [];
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);

        return jsonResponse({ documents: [{ name: 'contract', url: 'https://server/file/contract.pdf' }] });
      }) as typeof fetch,
    });

    const url = await api.documentUrl(11);

    expect(url).toBe('https://server/file/contract.pdf');
    expect(calls).toEqual(['GET https://server/api/submitters/11']);
  });

  it('verifies a PDF and returns the server report', async () => {
    const calls: { url: string; body: BodyInit | null | undefined }[] = [];
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: init?.body });

        return jsonResponse({ verdict: 'valid', stored: false });
      }) as typeof fetch,
    });

    const report = await api.verifyDocument({
      name: 'contract.pdf',
      type: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(report.verdict).toBe('valid');
    expect(report.provider).toBe('local');
    expect(report.provider_name).toBe('DocuSeal');
    expect(report.provider_url).toBeNull();
    expect(calls[0].url).toBe('https://server/api/qes/verify');
    expect(calls[0].body).toBeInstanceOf(FormData);
  });

  it('stores a verified PDF in the Verified documents folder', async () => {
    const calls: string[] = [];
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async (url) => {
        calls.push(String(url));

        return jsonResponse({ verdict: 'valid', stored: true, template_id: 42, folder: 'Verified documents' });
      }) as typeof fetch,
    });

    const report = await api.storeVerifiedDocument({
      name: 'contract.pdf',
      type: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(report.stored).toBe(true);
    expect(report.template_id).toBe(42);
    expect(report.provider).toBe('local');
    expect(calls).toEqual(['https://server/api/qes/verified_documents']);
  });

  it('normalizes the unauthenticated error code', async () => {
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async () =>
        jsonResponse({ error: 'Not authenticated' }, 401)) as typeof fetch,
    });

    try {
      await api.verifyDocument({ name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array() });
    } catch (error) {
      expect((error as PdfApiError).code).toBe('not_authenticated');
      expect((error as PdfApiError).status).toBe(401);
    }
  });

  it('maps a 422 error code to a typed error', async () => {
    const api = new PdfApi('https://server', 'secret', {
      fetchImpl: (async () =>
        jsonResponse({ error: 'encrypted_pdf', message: 'nope' }, 422)) as typeof fetch,
    });

    await expect(
      api.createDocument({ name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array() }),
    ).rejects.toThrow(PdfApiError);

    try {
      await api.createDocument({ name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array() });
    } catch (error) {
      expect((error as PdfApiError).code).toBe('encrypted_pdf');
      expect((error as PdfApiError).status).toBe(422);
    }
  });

  it('maps a tap inside the preview image to normalized coordinates', () => {
    const box = { x0: 20, y0: 10, width: 200, height: 400 };

    expect(tapToPosition({ x: 120, y: 110 }, box)).toEqual({ x: 0.5, y: 0.25 });
  });

  it('clamps a tap outside of the preview image into the page', () => {
    const box = { x0: 20, y0: 10, width: 200, height: 400 };

    expect(tapToPosition({ x: 0, y: 1000 }, box)).toEqual({ x: 0, y: 1 });
  });

  it('sizes the stamp outline from the page and stamp dimensions', () => {
    const outline = stampOutline(
      { x: 0.5, y: 0.25 },
      { x0: 0, y0: 0, width: 600, height: 800 },
      { width: 600, height: 800 },
      { width: 150, height: 44 },
    );

    expect(outline).toEqual({ left: 225, top: 178, width: 150, height: 44 });
  });

  it('converts the tapped center to a clamped stamp area', () => {
    expect(stampArea({ x: 0.5, y: 0.25 }, { width: 600, height: 800 }, { width: 150, height: 44 })).toEqual({
      x: 0.375,
      y: 0.2225,
      w: 0.25,
      h: 0.055,
    });

    expect(stampArea({ x: 0.99, y: 0.01 }, { width: 600, height: 800 }, { width: 150, height: 44 })).toEqual({
      x: 0.75,
      y: 0,
      w: 0.25,
      h: 0.055,
    });
  });
});

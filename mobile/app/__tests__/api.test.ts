import { QesApi, QesApiError } from '../src/lib/api';

function jsonResponse(body: unknown, status = 200, url = 'https://server/qes/sessions/tok'): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  Object.defineProperty(response, 'url', { value: url, configurable: true });

  return response;
}

describe('QesApi', () => {
  it('loads the session metadata', async () => {
    const calls: string[] = [];
    const api = new QesApi('https://server', 'tok', {
      serverUrl: 'https://server',
      fetchImpl: (async (url, init) => {
        calls.push(`${init?.method} ${url}`);

        return jsonResponse({ session_id: 1, state: 'app_opened', level_required: 'ades' });
      }) as typeof fetch,
    });

    const session = await api.getSession();

    expect(session.level_required).toBe('ades');
    expect(calls).toEqual(['GET https://server/qes/sessions/tok']);
  });

  it('posts the certificate and returns data_to_sign', async () => {
    const api = new QesApi('https://server', 'tok', {
      serverUrl: 'https://server',
      fetchImpl: (async () => jsonResponse({ data_to_sign: 'AAA=', hash_algorithm: 'sha256' })) as typeof fetch,
    });

    const payload = await api.postCertificate({
      certificate: 'AAA=',
      chain: [],
      key_location: 'phone_keystore',
      app: { platform: 'android', version: '1.0.0' },
    });

    expect(payload.data_to_sign).toBe('AAA=');
  });

  it('maps 410 expired_token to a typed error', async () => {
    const api = new QesApi('https://server', 'tok', {
      serverUrl: 'https://server',
      fetchImpl: (async () =>
        jsonResponse({ error: 'expired_token', message: 'expired' }, 410)) as typeof fetch,
    });

    await expect(api.getSession()).rejects.toThrow(QesApiError);

    try {
      await api.getSession();
    } catch (error) {
      expect((error as QesApiError).code).toBe('expired_token');
      expect((error as QesApiError).status).toBe(410);
    }
  });

  it('maps 422 qes_required_qscd to a typed error', async () => {
    const api = new QesApi('https://server', 'tok', {
      serverUrl: 'https://server',
      fetchImpl: (async () =>
        jsonResponse({ error: 'qes_required_qscd', message: 'QES required' }, 422)) as typeof fetch,
    });

    try {
      await api.postCertificate({
        certificate: 'AAA=',
        chain: [],
        key_location: 'phone_keystore',
        app: { platform: 'android', version: '1.0.0' },
      });
    } catch (error) {
      expect((error as QesApiError).code).toBe('qes_required_qscd');
    }
  });
});

it('downloads the exact prepared PDF from the configured server', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 255, 0]);
  const response = new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } });
  Object.defineProperty(response, 'url', { value: 'https://server/qes/sessions/a%2Fb/document' });
  const fetchImpl = jest.fn().mockResolvedValue(response);
  const api = new QesApi('https://server', 'a/b', { serverUrl: 'https://server', fetchImpl });
  expect(await api.getDocument()).toEqual(bytes);
  expect(fetchImpl).toHaveBeenCalledWith('https://server/qes/sessions/a%2Fb/document',
    expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/pdf' }) }));
});

it('rejects a document response redirected to a foreign host', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const fetchImpl = jest.fn().mockImplementation(async () => {
    const response = new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } });
    Object.defineProperty(response, 'url', { value: 'https://attacker.test/qes/sessions/a/document' });
    return response;
  });
  const api = new QesApi('https://server', 'a', { serverUrl: 'https://server', fetchImpl });
  await expect(api.getDocument()).rejects.toMatchObject({ code: 'foreign_server' });
});

it('rejects a JSON response redirected to a foreign host', async () => {
  const fetchImpl = jest.fn().mockImplementation(async () => {
    const response = jsonResponse({ state: 'app_opened' });
    Object.defineProperty(response, 'url', { value: 'https://attacker.test/qes/sessions/a' });
    return response;
  });
  const api = new QesApi('https://server', 'a', { serverUrl: 'https://server', fetchImpl });
  await expect(api.getSession()).rejects.toMatchObject({ code: 'foreign_server' });
});

it('rejects a document response with the wrong media type', async () => {
  const api = new QesApi('https://server', 'tok', {
    serverUrl: 'https://server', fetchImpl: jest.fn().mockResolvedValue(jsonResponse({})),
  });
  await expect(api.getDocument()).rejects.toMatchObject({ code: 'document_mismatch' });
});

it('maps an HTML error page to a typed error instead of a JSON parse crash', async () => {
  const api = new QesApi('https://server', 'tok', {
    serverUrl: 'https://server',
    fetchImpl: (async () =>
      (() => {
        const response = new Response('<html><body>404</body></html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(response, 'url', { value: 'https://server/qes/sessions/tok' });

        return response;
      })()) as typeof fetch,
  });

  await expect(api.getDocument()).rejects.toMatchObject({ status: 404, code: 'server_error' });
});

it('maps an HTML 200 response to invalid_response', async () => {
  const api = new QesApi('https://server', 'tok', {
    serverUrl: 'https://server',
    fetchImpl: (async () =>
      (() => {
        const response = new Response('<html><body>login</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
        Object.defineProperty(response, 'url', { value: 'https://server/qes/sessions/tok' });

        return response;
      })()) as typeof fetch,
  });

  await expect(api.getSession()).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
});

it('sends redirect: error on every QES request', async () => {
  let redirect: RequestRedirect | undefined;
  const api = new QesApi('https://server', 'tok', {
    serverUrl: 'https://server',
    fetchImpl: (async (_url, init) => {
      redirect = init?.redirect;

      return jsonResponse({ session_id: 1, state: 'app_opened', level_required: 'ades' });
    }) as typeof fetch,
  });

  await api.getSession();

  expect(redirect).toBe('error');
});

it('rejects a response without a URL instead of skipping the origin check', async () => {
  const response = new Response(JSON.stringify({ session_id: 1, state: 'app_opened' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const api = new QesApi('https://server', 'tok', {
    serverUrl: 'https://server',
    fetchImpl: (async () => response) as typeof fetch,
  });

  await expect(api.getSession()).rejects.toMatchObject({ code: 'foreign_server' });
});

it('times out the certificate request instead of holding the unlocked key', async () => {
  jest.useFakeTimers();
  const api = new QesApi('https://server', 'tok', {
    serverUrl: 'https://server',
    fetchImpl: ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch,
  });

  try {
    const pending = api.postCertificate({
      certificate: 'AAA=', chain: [], key_location: 'phone_keystore',
      app: { platform: 'android', version: '1.3.9' },
    });
    jest.advanceTimersByTime(60_000);

    await expect(pending).rejects.toMatchObject({ status: 408, code: 'timeout' });
  } finally {
    jest.useRealTimers();
  }
});

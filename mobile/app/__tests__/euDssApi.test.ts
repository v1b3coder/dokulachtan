import { EuDssApi, EuDssError, EU_DSS_URL } from '../src/lib/euDssApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface SignatureOptions {
  signedBy?: string;
  indication?: string;
  subIndication?: string;
  qualification?: string;
  scope?: string;
}

function dssSignature({
  signedBy = 'Jan Novák',
  indication = 'TOTAL_PASSED',
  subIndication,
  qualification = 'QESig',
  scope = 'FULL',
}: SignatureOptions = {}) {
  return {
    Qualification: qualification,
    Signature: {
      Id: `S-${signedBy}`,
      SignedBy: signedBy,
      Indication: indication,
      SubIndication: subIndication ?? null,
      SigningTime: '2026-10-22T09:15:00Z',
      SignatureFormat: 'PAdES-BES',
      SignatureScope: [{ value: 'Full PDF', scope }],
      CertificateChain: {
        Certificate: [
          { QualifiedName: `CN=${signedBy}` },
          { QualifiedName: 'CN=PostSignum Qualified CA 4' },
          { QualifiedName: 'CN=PostSignum Root QCA 4' },
        ],
      },
      AdESValidationDetails: { Error: [], Warning: [], Info: [] },
      QualificationDetails: { Error: [], Warning: [], Info: [] },
    },
  };
}

function report(signatures: ReturnType<typeof dssSignature>[]) {
  return {
    SimpleReport: {
      ValidationTime: '2026-10-23T20:12:50Z',
      ValidSignaturesCount: signatures.length,
      SignaturesCount: signatures.length,
      signatureOrTimestampOrEvidenceRecord: signatures.map((item) => ({
        Signature: item.Signature,
      })),
    },
    DetailedReport: {
      signatureOrTimestampOrEvidenceRecord: signatures.map((item) => ({
        Signature: {
          Id: item.Signature.Id,
          ValidationSignatureQualification: {
            SignatureQualification: item.Qualification,
          },
        },
      })),
    },
  };
}

const PDF_BASE64 = 'JVBERi0BAgM=';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);

function upload() {
  return { name: 'contract.pdf', type: 'application/pdf', bytes: PDF_BYTES };
}

describe('EuDssApi', () => {
  it('sends the PDF to the public EU DSS endpoint and maps a valid QES', async () => {
    const calls: { url: string; body: string }[] = [];
    const api = new EuDssApi({
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });

        return jsonResponse(report([dssSignature()]));
      }) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    const result = await api.verifyDocument(upload());

    expect(calls[0].url).toBe(EU_DSS_URL);
    expect(JSON.parse(calls[0].body)).toEqual({
      signedDocument: { bytes: PDF_BASE64, name: 'contract.pdf' },
    });
    expect(result.provider).toBe('eu_dss');
    expect(result.provider_name).toBe('EU DSS');
    expect(result.provider_url).toBe(EU_DSS_URL);
    expect(result.verdict).toBe('valid');
    expect(result.level).toBe('qes');
    expect(result.intact).toBe(true);
    expect(result.trusted).toBe(true);
    expect(result.coverage).toBe('full');
    expect(result.origin).toBe('unknown');
    expect(result.revocation).toBe('good');
    expect(result.seal).toEqual({ present: false, trusted: false, count: 0 });
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0].common_name).toBe('Jan Novák');
    expect(result.signatures[0].issuer).toBe('CN=PostSignum Qualified CA 4');
    expect(result.file.size).toBe(8);
    expect(result.file.sha256).toBe(
      'bd37485629dc3d4a0c1074d1084e75a3274e9721d050c8db691080b3b1a7a18e',
    );
  });

  it('maps an untrusted QES certificate to valid_untrusted', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () =>
        jsonResponse(
          report(
            [
              dssSignature({
                indication: 'INDETERMINATE',
                subIndication: 'NO_CERTIFICATE_CHAIN_FOUND',
              }),
            ],
          ),
        )) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    const result = await api.verifyDocument(upload());

    expect(result.verdict).toBe('valid_untrusted');
    expect(result.level).toBe('qes');
    expect(result.intact).toBe(true);
    expect(result.trusted).toBe(false);
    expect(result.revocation).toBe('unknown');
  });

  it('maps AdES with a qualified certificate as trusted AdES', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () =>
        jsonResponse(report([dssSignature({ qualification: 'AdESig-QC' })]))) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    const result = await api.verifyDocument(upload());

    expect(result.verdict).toBe('valid');
    expect(result.level).toBe('ades');
    expect(result.trusted).toBe(true);
    expect(result.signatures[0].level).toBe('ades');
  });

  it('keeps the signer coverage when the seal follows', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () =>
        jsonResponse(
          report([
            dssSignature(),
            dssSignature({ signedBy: 'DocuSeal', qualification: 'QESeal', scope: 'PARTIAL' }),
          ]),
        )) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    const result = await api.verifyDocument(upload());

    expect(result.verdict).toBe('valid');
    expect(result.coverage).toBe('full');
    expect(result.seal).toEqual({ present: true, trusted: false, count: 1 });
  });

  it('maps a tampered document to invalid and modified', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () =>
        jsonResponse(
          report(
            [
              dssSignature({
                indication: 'TOTAL_FAILED',
                subIndication: 'HASH_FAILURE',
                qualification: 'N/A',
                scope: 'PARTIAL',
              }),
            ],
          ),
        )) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    const result = await api.verifyDocument(upload());

    expect(result.verdict).toBe('invalid');
    expect(result.intact).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.modified).toBe(true);
    expect(result.level).toBe('none');
    expect(result.coverage).toBe('partial');
  });

  it('aggregates the DocuSeal seal without trusting it', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () =>
        jsonResponse(
          report([
            dssSignature(),
            dssSignature({ signedBy: 'DocuSeal', qualification: 'QESeal' }),
          ]),
        )) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    const result = await api.verifyDocument(upload());

    expect(result.verdict).toBe('valid');
    expect(result.seal).toEqual({ present: true, trusted: false, count: 1 });
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0].kind).toBe('qes');
  });

  it('returns unsigned for a PDF without signatures', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () =>
        jsonResponse({
          SimpleReport: {
            ValidationTime: '2026-10-23T20:12:50Z',
            ValidSignaturesCount: 0,
            SignaturesCount: 0,
            signatureOrTimestampOrEvidenceRecord: [],
          },
        })) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    const result = await api.verifyDocument(upload());

    expect(result.verdict).toBe('unsigned');
    expect(result.signatures).toEqual([]);
    expect(result.intact).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.level).toBe('none');
    expect(result.coverage).toBe('none');
    expect(result.revocation).toBe('not_checked');
  });

  it('maps a rate limited response to eu_dss_unavailable', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () => new Response('', { status: 429 })) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    await expect(api.verifyDocument(upload())).rejects.toMatchObject({
      code: 'eu_dss_unavailable',
    });
  });

  it('maps a network error to eu_dss_unavailable', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () => {
        throw new TypeError('Network request failed');
      }) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    await expect(api.verifyDocument(upload())).rejects.toBeInstanceOf(EuDssError);
    await expect(api.verifyDocument(upload())).rejects.toMatchObject({
      code: 'eu_dss_unavailable',
    });
  });

  it('rejects an empty PDF before sending it to EU DSS', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () => jsonResponse(report([dssSignature()]))) as typeof fetch,
      readBase64: async () => '',
    });

    await expect(api.verifyDocument(upload())).rejects.toMatchObject({
      code: 'invalid_pdf',
    });
  });

  it('rejects a non-PDF payload before sending it to EU DSS', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () => jsonResponse(report([dssSignature()]))) as typeof fetch,
      readBase64: async () => 'AQID',
    });

    await expect(api.verifyDocument(upload())).rejects.toMatchObject({
      code: 'invalid_pdf',
    });
  });

  it('rejects an invalid EU DSS response', async () => {
    const api = new EuDssApi({
      fetchImpl: (async () => jsonResponse({ unexpected: true })) as typeof fetch,
      readBase64: async () => PDF_BASE64,
    });

    await expect(api.verifyDocument(upload())).rejects.toMatchObject({
      code: 'eu_dss_error',
    });
  });
});


it.each([
  ['TOTAL_PASSED', undefined, 'good'],
  ['INDETERMINATE', 'TRY_LATER', 'unknown'],
  ['TOTAL_FAILED', 'REVOKED', 'revoked'],
  ['INDETERMINATE', 'REVOKED_NO_POE', 'revoked'],
  ['INDETERMINATE', 'REVOKED_CA_NO_POE', 'revoked'],
  ['TOTAL_FAILED', 'HASH_FAILURE', 'unknown'],
])('aggregates passed + %s/%s as %s regardless of order', async (indication, subIndication, expected) => {
  const signatures = [dssSignature(), dssSignature({ signedBy: 'Partner', indication, subIndication })];
  for (const entries of [signatures, [...signatures].reverse()]) {
    const api = new EuDssApi({
      fetchImpl: jest.fn().mockResolvedValue(jsonResponse(report(entries))),
      readBase64: async () => PDF_BASE64,
    });
    expect((await api.verifyDocument(upload())).revocation).toBe(expected);
  }
});

it('gives revocation precedence over unknown status', async () => {
  const api = new EuDssApi({
    fetchImpl: jest.fn().mockResolvedValue(jsonResponse(report([
      dssSignature({ indication: 'INDETERMINATE', subIndication: 'TRY_LATER' }),
      dssSignature({ signedBy: 'Partner', indication: 'TOTAL_FAILED', subIndication: 'REVOKED' }),
    ]))),
    readBase64: async () => PDF_BASE64,
  });
  expect((await api.verifyDocument(upload())).revocation).toBe('revoked');
});

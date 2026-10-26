// Typy protokolu QES (SPEC § 5): metadata → certifikát → raw signatura.

export type QesLevel = 'none' | 'ades' | 'qes';

export type QesSessionPayload = QesPendingSessionPayload
  | (QesCompletedPayload & Partial<Omit<QesPendingSessionPayload, 'state'>>);

export interface QesPendingSessionPayload {
  session_id: number;
  state: 'created' | 'app_opened' | 'awaiting_signature' | 'embedding' | 'failed' | 'expired';
  provider: string;
  document_name: string | null;
  signer_name: string | null;
  hash_algorithm: string;
  level_required: QesLevel;
  requires_certificate: boolean;
  server_url: string;
  expires_at: string | null;
}

export interface QesCertificateInfo {
  subject: string;
  issuer: string;
  serial: string;
  not_before: string;
  not_after: string;
  level: QesLevel;
  qc_statements: string[];
  key_type: string;
  key_size: number;
}

export interface QesCertificatePayload {
  data_to_sign: string;
  byte_range: [number, number, number, number];
  document_digest: string;
  hash_algorithm: string;
  digest_algorithm_oid: string;
  signature_algorithm: string;
  expires_at: string | null;
  certificate_info: QesCertificateInfo;
}

export interface QesValidationReport {
  ok: boolean;
  intact: boolean;
  trusted: boolean;
  coverage: 'full' | 'partial' | 'none';
  level: QesLevel;
  signatures?: unknown[];
  validated_at?: string;
}

export interface QesCompletedPayload {
  state: 'completed';
  session_id: number;
  level: QesLevel;
  document_digest: string;
  signed_pdf_sha256: string;
  final_pdf_sha256?: string;
  seal_state?: string;
  validation?: QesValidationReport;
  completed_at?: string | null;
}

export type KeyLocation = 'phone_keystore' | 'card';

export interface QesAppMetadata {
  platform: string;
  version: string;
  reader?: string | null;
  container_ref?: string | null;
}

export interface QesCertificateRequest {
  certificate: string;
  chain: string[];
  key_location: string;
  app: QesAppMetadata;
}

// Zdroj podpisové session (SPEC § 9.3, docs/15 D12): dnešní zdroj je
// jednorázový token serveru (`QesApi`); offline core (mimo v1) doplní vlastní
// implementaci bez změny obřadu.
export interface SessionSource {
  getSession(): Promise<QesSessionPayload>;
  getDocument(): Promise<Uint8Array>;
  postAbort(code: string, message?: string): Promise<{ state: string }>;
  postCertificate(body: QesCertificateRequest): Promise<QesCertificatePayload>;
  postComplete(signatureBase64: string): Promise<QesCompletedPayload>;
}

export interface QesApiErrorBody {
  error: string;
  message?: string;
}

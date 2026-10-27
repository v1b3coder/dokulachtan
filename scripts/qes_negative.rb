# frozen_string_literal: true

# Pomocné úpravy pro negativní scénáře N1–N9 (SPEC § 15.2), spouští se
# uvnitř kontejneru přes `rails runner` s `QES_NEG_MODE`:
#   tamper_tbs   — přepíše byte v TBS PDF po `prepare` (N1)
#   expire       — nastaví `expires_at` do minulosti (N7)
#   tamper_final — přepíše byte ve finálním PDF a validuje (N9)
#   level        — nastaví úroveň pole `qes` (N5)
#   pdf_encrypted — vytvoří šifrované PDF (N13, docs/15)
#   pdf_signed   — vytvoří PDF s podpisovým polem (N14, docs/15)
#   pdf_foreign  — založí cizí účet s API tokenem (N16)
#   qes_sessions — vypíše stavy QES sessions posledního submittera (N17)
require 'json'

submission = Submission.order(:id).last
submitter = submission.submitters.order(:id).last
session = QesSession.where(submitter_id: submitter.id).order(:id).last

case ENV.fetch('QES_NEG_MODE')
when 'tamper_tbs'
  bytes = session.tbs_document.download
  range = Qes::TbsDocument.byte_range(bytes)
  index = range.present? ? range[1] / 2 : bytes.bytesize / 2
  bytes[index] = bytes[index] == 'x' ? 'y' : 'x'
  metadata = session.tbs_document.blob.metadata
  session.tbs_document.attach(io: StringIO.new(bytes), filename: "qes-neg-tampered-#{session.id}.pdf",
                              content_type: 'application/pdf', metadata:)

  puts JSON.generate({ mode: 'tamper_tbs', session_id: session.id, index:, byte_size: bytes.bytesize })
when 'expire'
  session.update!(expires_at: 1.minute.ago)

  puts JSON.generate({ mode: 'expire', session_id: session.id, state: session.state })
when 'tamper_final'
  bytes = session.final_document.download
  range = Qes::TbsDocument.byte_range(bytes)
  index = range.present? ? range[1] / 2 : bytes.bytesize / 2
  bytes[index] = bytes[index] == 'x' ? 'y' : 'x'
  tampered = "/qes-out/qes-neg-tampered.pdf"
  File.binwrite(tampered, bytes)

  roots = Qes::Config[:trust_roots].to_s.split(',').map { |path| OpenSSL::X509::Certificate.new(File.read(path)) }
  report = Qes::Validator.call(bytes, trust_roots: roots)

  puts JSON.generate({ mode: 'tamper_final', session_id: session.id, intact: report[:intact],
                       coverage: report[:coverage] })
when 'level'
  level = ENV.fetch('QES_NEG_LEVEL')
  fields = submission.template_fields.map do |field|
    field = field.merge('preferences' => field['preferences'].merge('level' => level)) if field['type'] == 'qes'

    field
  end
  submission.update!(template_fields: fields)

  puts JSON.generate({ mode: 'level', submission_id: submission.id,
                       levels: fields.select { |f| f['type'] == 'qes' }.map { |f| f['preferences']['level'] } })
when 'pdf_encrypted'
  pdf = HexaPDF::Document.new
  pdf.pages.add
  pdf.encrypt(algorithm: :aes, key_length: 256, user_password: 'secret')
  path = '/qes-out/qes-neg-encrypted.pdf'
  pdf.write(path)

  puts JSON.generate({ mode: 'pdf_encrypted', path:, byte_size: File.size(path) })
when 'pdf_signed'
  pdf = HexaPDF::Document.new(io: StringIO.new(File.binread('/qes-test/fixtures/input.pdf')))
  bytes = Qes::TbsDocument.sign(pdf)
  path = '/qes-out/qes-neg-signed.pdf'
  File.binwrite(path, bytes)

  puts JSON.generate({ mode: 'pdf_signed', path:, byte_size: bytes.bytesize })
when 'qes_sessions'
  sessions = QesSession.where(submitter_id: submitter.id).order(:id)

  puts JSON.generate({ mode: 'qes_sessions',
                        sessions: sessions.map { |s| { id: s.id, state: s.state, level: s.level } } })
when 'pdf_foreign'
  account = Account.create!(name: 'Foreign QES PDF', timezone: 'UTC', locale: 'en')
  user = account.users.create!(first_name: 'Foreign', last_name: 'Signer',
                              email: "foreign-#{SecureRandom.hex(4)}@example.com", password: 'password123')
  user.confirm if user.respond_to?(:confirm)
  user.save!

  puts JSON.generate({ mode: 'pdf_foreign',
                        token: (user.access_tokens.first || user.access_tokens.create!).token })
else
  raise "Neznámý QES_NEG_MODE: #{ENV.fetch('QES_NEG_MODE')}"
end

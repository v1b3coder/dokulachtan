#!/usr/bin/env python3
"""Jednorázová verifikace: stejný podepisující podepíše 2 pole téhož dokumentu na stagingu."""
from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from qes_staging_e2e import (  # noqa: E402
    BASE, FLY_APP, OUT, PKI, browser_create_session, download, fly_runner,
    run_app_ceremony, wait_for_staging,
)
from qes_e2e import (  # noqa: E402
    assert_acceptable_modifications, count_signatures, log, signature_lines, validate_pdf,
)

PDF_BASE64 = re.search(
    r"PDF_BASE64 = '([^']+)'",
    (ROOT / "scripts" / "qes_staging_bootstrap.rb").read_text(),
).group(1)

BOOTSTRAP = r'''
require 'base64'
require 'json'
account = Account.first
raise 'no account' if account.nil?
user = account.users.first
name = 'QES E2E same signer (staging)'
account.templates.where(name: name).find_each(&:destroy!)
pdf = Base64.decode64(ENV.fetch('QES_STAGING_PDF_B64'))
template = account.templates.new(name: name, author: user, source: :api)
attachment_uuid = SecureRandom.uuid
submitter = { 'uuid' => SecureRandom.uuid, 'name' => 'Same Signer' }
template.submitters = [submitter]
template.schema = [{ 'attachment_uuid' => attachment_uuid, 'name' => 'qes-staging' }]
template.fields = Array.new(2) do |i|
  { 'uuid' => SecureRandom.uuid, 'name' => "QES same #{i + 1}", 'type' => 'qes',
    'required' => true, 'submitter_uuid' => submitter['uuid'],
    'preferences' => { 'level' => 'ades' },
    'areas' => [{ 'x' => 0.1, 'y' => 0.8 - (0.1 * i), 'w' => 0.3, 'h' => 0.06, 'page' => 0,
                  'attachment_uuid' => attachment_uuid }] }
end
template.save!
template.documents_attachments.create!(
  uuid: attachment_uuid,
  blob: ActiveStorage::Blob.create_and_upload!(io: StringIO.new(pdf), filename: 'qes-staging.pdf')
)
submission = template.submissions.create!(account: account, created_by_user: user,
                                         template_fields: template.fields,
                                         template_schema: template.schema,
                                         template_submitters: template.submitters)
record = submission.submitters.create!(account: account, uuid: submitter['uuid'],
                                      name: submitter['name'], email: 'same@example.com')
puts JSON.generate({submission_id: submission.id, slug: record.slug,
                    field_uuids: template.fields.map { |f| f['uuid'] }})
'''

SAVE_FIELD = r'''
require 'json'
submitter = Submitter.find_by!(slug: ENV.fetch('QES_STAGING_SUBMITTER_SLUG'))
field_uuid = ENV.fetch('QES_STAGING_FIELD_UUID')
session = QesSession.where(submitter_id: submitter.id).order(:id).last
warden = Object.new
def warden.user(*) = nil
env = Rack::MockRequest.env_for('https://dokulachtan-staging.fly.dev/s/qes-staging',
                                'HTTP_USER_AGENT' => 'qes-staging-e2e')
env['warden'] = warden
request = ActionDispatch::Request.new(env)
params = ActionController::Parameters.new(values: { field_uuid => session.value_token })
Submitters::SubmitValues.call(submitter, params, request)
puts JSON.generate({field: field_uuid, state: session.reload.state,
                    value: submitter.reload.values[field_uuid]})
'''


def inline_runner(code: str, env: dict[str, str] | None = None) -> dict:
    encoded = base64.b64encode(code.encode()).decode()
    assignments = "".join(f'ENV["{k}"] = "{v}"; ' for k, v in (env or {}).items())
    command = (f"/app/bin/rails runner 'require \"base64\"; {assignments}"
               f"eval(Base64.decode64(\"{encoded}\"))'")
    proc = subprocess.run(["fly", "ssh", "console", "-a", FLY_APP, "-C", command],
                           capture_output=True, text=True, timeout=900)
    out = proc.stdout + proc.stderr
    lines = [line for line in out.splitlines() if line.strip().startswith("{")]
    if not lines:
        raise SystemExit(f"runner selhal: {out[-800:]}")
    return json.loads(lines[-1])


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("qes-staging-same-*.pdf"):
        old.unlink()

    wait_for_staging()
    log("- staging /up -> 200")

    boot = inline_runner(BOOTSTRAP, {"QES_STAGING_PDF_B64": PDF_BASE64})
    log(f"- bootstrap: {json.dumps(boot, ensure_ascii=False)}")

    for index, field_uuid in enumerate(boot["field_uuids"], start=1):
        status, created = browser_create_session(boot["slug"], field_uuid)
        log(f"- pole {index}: POST /s/:slug/qes_sessions -> HTTP {status} {created.get('state')}")
        if status != 201:
            raise SystemExit(f"Vytvoření session {index} selhalo: {created}")

        app_result = run_app_ceremony(created["token"])
        if app_result.get("completed", {}).get("state") != "completed":
            raise SystemExit(f"Podpis v appce selhal (pole {index})")

        saved = inline_runner(SAVE_FIELD, {"QES_STAGING_SUBMITTER_SLUG": boot["slug"],
                                          "QES_STAGING_FIELD_UUID": field_uuid})
        log(f"- pole {index}: value={saved['value']}, session={saved['state']}")

    done = fly_runner("qes_staging_complete.rb", {"QES_STAGING_SUBMITTER_SLUG": boot["slug"]})
    log(f"- submitter completed: {done.get('submitter_completed')}, submission: {done.get('submission_completed')}")

    final = OUT / "qes-staging-same-final.pdf"
    download(done["final_file"], final)
    count = count_signatures(final)
    lines = signature_lines(final, PKI / "root.crt")
    log(f"- finální PDF: {final.name} ({final.stat().st_size} B), signatur: {count}, INTACT: {bool(lines) and all('INTACT' in line for line in lines)}")
    log(validate_pdf(final, PKI / "root.crt"))

    if count != 6:
        raise SystemExit(f"Finální PDF má {count} signatur, očekáváno 6")
    if not lines or not all("INTACT" in line for line in lines):
        raise SystemExit("Některá signatura není INTACT")
    assert_acceptable_modifications(final.name, lines)
    log("- pyHanko: revize dalšího signera ACCEPTABLE_MODIFICATIONS (žádné ILLEGAL_MODIFICATIONS)")

    import qes_e2e

    (OUT / "qes-staging-same-signer-report.txt").write_text("\n".join(qes_e2e.report) + "\n")
    log("\nOK: stejný podepisující podepsal 2 pole, 6 signatur INTACT")
    log("- report: test/out/qes-staging-same-signer-report.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())

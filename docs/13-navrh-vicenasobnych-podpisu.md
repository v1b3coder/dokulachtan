# 13 — Návrh: vícenásobné digitální podpisy (firemní podpisy)

Status: **implementováno** (2026-10-17, doplněno o DocTS 2026-10-22) — fáze 1–4 hotové,
`make qes-e2e-two` zelené (6 signatur: 2× appka + 2× pečeť + 2× DocTS). Původní návrh je níže
ponechán jako rozhodovací záznam; aktuální pravidla jsou v SPEC § 4.6 a § 7.1.
Navazuje na DESIGN.md § 3.1, SPEC.md § 4.1 a § 7, AGENTS.md rozhodnutí #11.

**Oprava (2026-10-17):** stejná osoba může podepsat víc polí téhož dokumentu. `chained_base` proto
nejdřív bere **vlastní** poslední dokončenou session podepisujícího a teprve pak session předchozího
submittera; `Qes::ResultAttachments` bere poslední dokončenou session (ta už obsahuje všechny předchozí
revize). Test: `spec/lib/qes/chain_spec.rb` — „lets the same submitter sign twice with the same certificate“
(2× podpis appky + 2× pečeť + 2× DocTS, 6 signatur INTACT). Pole s `qes:<id>` se v UI nahrazuje přehledem
podpisu (`submissions/_value.html.erb`, `qes_summary.vue`, `summary_html` z `GET /s/:slug/qes_sessions/:id`).

## 1. Use case

Firma posílá dokument (typicky smlouvu), který musí digitálně podepsat **více stakeholderů**
(jednatel, finanční ředitel, HR, …), každý vlastním certifikátem (varianta B v telefonu,
případně A na čipu). Výsledné PDF musí být platně digitálně podepsané **všemi** — žádný
podpis nesmí být dalším podpisem zneplatněn.

## 2. Klíčový princip: řetězení revizí

PAdES podpis je inkrementální revize PDF. Další podpis se nesmí dělat přestavbou dokumentu,
ale jen přidáním nové revize nad předchozí. **DocuSeal přesně tohle už dělá** pro běžné
podepisování: `build_pdfs_index` použije dokumenty *posledního dokončeného podepisujícího*
jako základ pro dalšího (`find_last_submitter` → `EnsureResultGenerated`). Naše QES vrstva tedy
nemusí vymýšlet nový tok, jen musí zajistit, aby:

1. `documents` QES podepisujícího byl jeho **finální podepsaný PDF** (ne přegenerovaný),
2. TBS dalšího podepsaného vzniklo **otevřením tohoto PDF** (žádný `import` stránek),
3. hodnoty dalšího podepsaného se dokreslily jako nová revize a podpis se přidal inkrementálně.

```
signer 1:  TBS1 = šablona + hodnoty 1 ──podpis 1──▶ revize 1 ──pečeť 1──▶ final 1
signer 2:  TBS2 = final 1 + hodnoty 2 ──podpis 2──▶ revize 2 ──pečeť 2──▶ final 2
signer 3:  TBS3 = final 2 + hodnoty 3 ──podpis 3──▶ revize 3 ──pečeť 3──▶ final 3
```

Všechny revize zůstávají INTACT; `combined_document` je poslední revize.

## 3. Rozhodnutí

| # | Rozhodnutí | Důvod |
|---|---|---|
| D1 | **Všechny strany podepisují certifikátem** — šablona s `qes` polem musí mít `qes` pole u každého signera | uživatelský požadavek „výsledek musí být všemi digitálně podepsaný“; smíšené pořadí (kreslený podpis po QES) mimo rozsah |
| D2 | **Striktní pořadí** — `submitters_order: preserved` (nebo různá `order`), žádné paralelní skupiny | inkrementální podpis jinak nemá deterministický základ |
| D3 | **Pečeť po každé session** (status quo) | minimální změna; finální PDF má N podpisů + N pečetí, každá revize INTACT |
| D4 | **Artefakty zůstávají per-session** (status quo) | `documents` signera N = revize N, `combined_document` = poslední revize |
| D5 | **Appka, protokol, API a stavový automat beze změny** | každý podepisující má vlastní token i session |

Zamítnuté alternativy:

- **Pečeť jen jednou na konci** — vyžaduje regeneraci `documents` všech QES
  podepisujících po dokončení submissionu (více zásahů, složitější audit).
- **Paralelní podepisování** — dva podpisy nad stejným základem nelze sloučit.
- **Vlastní vykreslování polí na merged základ** — duplikace ~250 řádků upstream
  `fill_submitter_fields`; místo toho 2řádková úprava pro `page_offsets`.

## 4. Změny podle fází

### Fáze 1 — pořadí a validace šablony (malý upstream patch)

| Soubor | Změna | Řádků |
|---|---|---|
| `app/models/template.rb` | nahradit `qes_single_signer_only` validací `qes_signing_order` | ~15 |
| `app/controllers/submit_form_controller.rb` (ř. 28) | gating podle `submission.submitters_order_preserved?` místo `template.preferences[...]` | 1 |
| `app/models/submission.rb` | `before_validation :maybe_preserve_qes_order, on: :create` — vynutí `preserved` u QES šablon (API s `random`) | ~6 |
| `app/controllers/qes/form_sessions_controller.rb` | `409 awaiting_previous_signer` při přímém POST bez pořadí | ~5 |
| `app/javascript/template_builder/builder.vue#save` | zobrazit chybu 422 (volitelné; dnes je chyba tichá/500) | ~5 |

Validace `qes_signing_order` (nahrazuje dnešní omezení „jen jeden podepisující“):

- každý non-viewer submitter musí mít `qes` pole (`qes_all_signers_required`),
- při >1 signerovi musí být `preferences['submitters_order'] == 'preserved'` nebo
  každý signer vlastní `order` (`qes_signing_order_required`),
- dva signerové nesmí sdílet `order` (`qes_parallel_signers_not_allowed`).

### Fáze 2 — řetězení TBS (jádro, jen `app/lib/qes/`)

| Soubor | Změna | Řádků |
|---|---|---|
| `app/lib/qes/tbs_document.rb` | `chained_base`, `page_offsets`, vykreslení hodnot na základ, `sign` | ~60 |
| `app/lib/qes/result_attachments.rb` | `original_uuid` = `areas[0].attachment_uuid` pole `qes` (ne `field_uuid`) | 1 |
| `lib/submissions/generate_result_attachments.rb` | `fill_submitter_fields(..., page_offsets: {})` + globální index stránky | 2 |

`chained_base(submitter)`:

```ruby
previous = submitter.submission.submitters.reject(&:viewer?)
                     .select(&:completed_at?).max_by(&:completed_at)
session = previous && QesSession.completed.where(submitter_id: previous.id).order(:id).last
session&.final_document&.attached? ? HexaPDF::Document.new(io: StringIO.new(session.final_document.download)) : nil
```

- `nil` (první QES signer) → dnešní `merged_document` (staví se ze šablony + hodnot).
- nenil (další QES signer) → otevře se předchozí finální PDF, `fill_submitter_fields`
  dokreslí hodnoty aktuálního signera (skip `qes` polí), `Qes::Stamp.draw` dokreslí viditelnou
  pečeť, `pdf.sign` přidá podpisové pole a zapíše **inkrementálně**.

`page_offsets` se počítá z metadat `submission.schema_documents`
(`pdf.number_of_pages`) v pořadí `template_schema` — bez stahování souborů.
Pro více dokumentů se mapuje `attachment_uuid → globální index stránky`; jinak
zůstávají indexy per-attachment (dnešní chování).

### Fáze 3 — testy

- `spec/lib/qes/pipeline_spec.rb`: řetěz dvou signerů — TBS 2 nad `final_document`
  signera 1, oba podpisy INTACT, poslední pokrývá celý soubor; varianta se dvěma
  dokumenty (page_offsets).
- `spec/models/template_spec.rb`: validace pořadí (preserved / order / paralelní).
- `make qes-test-qes` zelené; `make qes-e2e` rozšířit na 2 submittery
  (sekvenčně přes API) a validovat `pyhanko validate` (bez `--fetch`) na finálním PDF.
- `make qes-e2e-card` ponechat s 1 signerem (fake čip).

### Fáze 4 — dokumentace

- SPEC § 4.1 (řetězení, pořadí), § 7.1 (TBS základ), § 7.6 (N podpisů + N pečetí),
  § 7.7 (řádky), § 15 (testy).
- DESIGN § 3.1 a § 4 (workflow více signerů).
- PLAN nová fáze P7 s výše uvedenými kroky.
- AGENTS.md rozhodnutí #11 nahradit; runbook `docs/10-qes.md`.

## 5. Co se nemění

- **Appka (Expo)** — každá session má vlastní deep link a token; pořadí řídí server.
- **Protokol** `GET/POST /qes/sessions/:token` — per-session, beze změny.
- **Stavový automat** `QesSession` — per-session, beze změny.
- **`Qes::Validator`, `Qes::Ltv`, `Qes::CmsBuilder`, `Qes::Seal`** — architektura zůstává; `Qes::Validator`
  se rozšířil o řetěz revocation a `Qes::PdfiumTrust` (SPEC § 7.5).
- **DB** — žádné nové sloupce ani migrace.
- **API a UI DocuSealu** — beze změny (jen validace šablony a gating).

## 6. Rizika a úskalí

| Riziko | Ošetření |
|---|---|
| `find_last_submitter(submission)` vrátí viewera | filtr `reject(&:viewer?)` |
| `find_last_submitter(submission, submitter:)` spadne při `completed_at = nil` | volat variantu bez `submitter:` a `with_headings` předat explicitně |
| `maybe_flatten_pdf` / `maybe_rotate_pdf` přepíše podepsaný základ | na podepsaný základ nevolat; případně jen s `incremental: true` |
| rezerva `QES_SIGNATURE_RESERVE` (64 kB) na jeden podpis | rezerva je per session, řetězení ji nezvětšuje |
| `EnsureResultGenerated` vytvoří při retry duplicitní attachment | stávající LockEvent guard; QES větev je idempotentní (bere hotovou session) |
| chyba validace šablony se dnes zobrazí jako 500 | volitelně doplnit 422 + alert v builderu |

## 7. Ověření (Definition of Done)

1. `make qes-test-qes` — nové specy zelené.
2. `make qes-e2e` (1 signer) a `make qes-e2e-two` (2 signeři) — finální PDF:
   - **podpisy appky** (ETSI.CAdES.detached) `INTACT:TRUSTED`; poslední pokrývá celý soubor,
   - **pečeti DocuSealu** (adbe.pkcs7.detached, vlastní ESIGN cert) `INTACT:UNTRUSTED` —
     nejsou QES, trust roots QES se na ně nevztahují (pyHanko CLI proto skončí `Error: Validation failed`);
   - **DocTS** (ETSI.RFC3161) `INTACT:UNTRUSTED` v test trust listu, v Adobe trusted;
   - Pdfium ve forku i `pdfsig` označí všechny signatury `INTACT`.
3. `pdfsig` / Pdfium — všechny podpisy INTACT (i pečeti).
4. Manuálně: 3 stakeholders na stagingu, každý podepíše z appky; finální PDF
   má 3 podpisy + 3 pečeti + 3 DocTS a všechny platné.
5. Stávající jednosigner scénáře beze změny (`make qes-e2e-card`).

## 8. Výsledek implementace

- Řetězení revizí, pořadí signerů a validace všech signatur jsou hotové a kryté
  `spec/lib/qes/chain_spec.rb`; finální PDF má N podpisů appky + N pečetí + N DocTS.
- Commity a podrobná historie jsou v gitu forku; aktuální stav dokumentuje
  [AGENTS.md](../AGENTS.md#stav) a SPEC § 4.6, § 7.1 a § 7.6.

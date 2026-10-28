# Login with Dokulachtan — feasibility study a návrh řešení

**Datum:** 2026-10-28
**Stav:** návrh k rozhodnutí (feasibility + design)
**Navazuje na:** [DESIGN.md](../DESIGN.md), [SPEC.md](../SPEC.md), [docs/04](04-architektura-fork.md),
[docs/07](07-pred-implementaci.md), [docs/10](10-qes.md), [docs/15](15-primy-podpis-pdf.md),
[docs/16](16-overeni-pdf.md), [docs/22](22-final-audit-fork.md)
**Název v UI:** „Přihlásit se certifikátem“ (EN: „Sign in with certificate“); pracovní název
„Login with Dokulachtan“ je jen označení funkce, ne nový poskytovatel identity.

---

## 1. Shrnutí a verdikt

**Technicky proveditelné: ano, s vysokou jistotou.** Server už má celý kryptografický základ
(parse certifikátu, řetěz k trust rootům, CRL, one-time token, stavový automat) a appka má
privátní klíč v biometrickém vaultu, podpisový obřad a deep linky. Login je nová **tenká vrstva**
nad tím, co už existuje, ne nový kryptografický systém.

**Doporučení: GO jako fáze P9, ale s omezeními:**

1. **V1 = telefonní klíč (AdES), ne čip eObčanky.** Reálná čtečka je zatím stub (P5), takže
   „přihlášení certifikátem z eObčanky“ je blokované stejným blokátorem jako QES podpis dokumentu.
   Telefonní klíč dnes umí AdES a to je pro přihlášení dostatečné.
2. **Nenahrazuje heslo.** Přihlášení certifikátem je další metoda vedle hesla; vynucení
   (`force`) je až budoucí politika s break-glass účtem.
3. **Feature flag `QES_LOGIN_ENABLED=false`**, zapnout nejdřív na stagingu, pak na produkci.
4. **Žádné automatické párování certifikátu podle e-mailu ze subjectu.** Registrace certifikátu
   je explicitní, po přihlášení heslem (nebo předpřipravená adminem).
5. **2FA zůstává.** Pokud má uživatel zapnuté TOTP, přihlášení certifikátem ho po ověření
   podpisu vyžádá také. Cert + biometrie je „possessed key + inherence“, ale server biometrii
   nevidí, takže TOTP je rozumná obrana navíc.
6. **Doménové oddělení podpisu.** Login podepisuje kanonický challenge s prefixem
   `DOKULACHTAN-LOGIN-V1`, nikdy PDF TBS. Appka formát ověří a podepíše jen exact bytes;
   server ověří podpis nad uloženým challenge. Tím se login nedá zneužít jako podpis dokumentu.

**Odhad pracnosti:** 13–18 člověkodnů (server 6–8, appka 3–4, testy/e2e 3–4, dokumentace a
nasazení 1–2). Bez reálné čtečky; ta je závislá na P5.

**Největší riziko:** login CSRF / phishing — útočník oběti podstrčí svůj browser a nechá ji
podepsat přihlášení do jeho session. Mitigace: krátký TTL, jednorázový token, kód zobrazený
v browseru i appce, origin v challenge, bind na browser session a explicitní potvrzení uživatele.
Zbytkové riziko zůstává, pokud uživatel kód neporovná; proto UI musí být hodně explicitní.

**Největší blokátor:** přihlášení čipem eObčanky (QES) nejde do produkce, dokud není hotová
reálná MOI SDK integrace v P5. Dnes je `StubCardSigner` a `FakeCardSigner`; login s kartou by
fungoval jen v testovacím režimu.

---

## 2. Co už dnes máme (výchozí body)

### 2.1 DocuSeal / Devise

| Věc | Soubor | Co z toho plyne |
|---|---|---|
| Devise `:two_factor_authenticatable`, `:lockable`, `:trackable`, `:recoverable`, `:rememberable`, `:validatable` | `app/models/user.rb:72` | `sign_in(user)` je k dispozici; OTP se ale **neověřuje** samotným `sign_in`, musíme ho ověřit explicitně |
| `active_for_authentication?` | `app/models/user.rb:87` | archivovaný uživatel/účet se nepřihlásí |
| Login controller řeší OTP | `app/controllers/sessions_controller.rb:31` | vzor pro OTP krok; cert login ho musí replikovat |
| `after_sign_in_path_for` s `redir` | `app/controllers/sessions_controller.rb:45` | pozor: vrací `params[:redir]` bez validace hostitele (existující open redirect; nový tok ho nesmí slepě převzít) |
| `ApplicationController` before_actions | `app/controllers/application_controller.rb:12-14` | nový controller musí `skip_before_action :authenticate_user!`, `skip_authorization_check`; `maybe_redirect_to_setup` naopak nechat |
| Login stránka | `app/views/devise/sessions/new.html.erb:21` | `_omniauthable.html.erb` je prázdný partial, ideální místo pro tlačítko |
| Profil / nastavení | `app/views/profile/index.html.erb` | místo pro správu certifikátů pro přihlášení |
| Uživatelé | `app/views/users/_form.html.erb`, `UsersController#edit` | místo pro admin revoke |
| Žádné SSO v AGPL | `_omniauthable.html.erb` je prázdný, `omniauth` není v Gemfile | nemusíme se hádat s Pro SSO; přidáme vlastní metodu |

### 2.2 QES vrstva (fork)

| Věc | Soubor | Reuse pro login |
|---|---|---|
| One-time token, v DB jen SHA-256 | `app/lib/qes/token.rb` | 1:1, jen jiný model (`QesLoginAttempt`) |
| Stavový automat | `app/lib/qes/session_manager.rb` | stejný princip, vlastní přechody |
| Parse certifikátu, QCStatements, key usage | `app/lib/qes/certificate_info.rb` | `validate_for_login!` (bez QcSSCD/location pravidel) |
| Ověření řetězu k trust rootům | `app/lib/qes/validator.rb` | 1:1 |
| CRL fetch, SSRF allowlist, revoked | `app/lib/qes/ltv.rb` | 1:1 + cache |
| Chybové odpovědi, limity certu/řetězu | `app/lib/qes/controller_concern.rb` | 1:1 |
| App API vzor (token v cestě, `X-QES-Protocol`, null session) | `app/controllers/qes/sessions_controller.rb` | 1:1 |
| QR / custom scheme / fallback stránka | `app/controllers/qes/app_controller.rb` | 1:1 |
| `.well-known` AASA a assetlinks | `app/controllers/qes/well_known_controller.rb` | přidat `/qes/login` |
| QR knihovna | `RQRCode` už je použité v `qes/app/show` | 1:1 |

### 2.3 Mobilní appka

| Věc | Soubor | Reuse pro login |
|---|---|---|
| Vault, AES-256-GCM, biometrie | `mobile/app/src/lib/crypto/vault.ts` | `unlockCertificate(vault, reason)` beze změny |
| PKCS#12, jen RSA, QcSSCD se odmítá | `mobile/app/src/lib/crypto/p12.ts` | telefonní klíč = AdES; QES/čip jen budoucí |
| Podpis raw bytes | `mobile/app/src/lib/crypto/softwareSigner.ts` | `signChallenge` = stejný primitiv, jen jiný účel |
| Obřad podpisu | `mobile/app/src/lib/ceremony.ts` | nový `loginCeremony` (jednodušší, bez PDF) |
| Origin a server URL | `mobile/app/src/lib/signingOrigin.ts` | 1:1 |
| Deep link mapping | `mobile/app/app/+native-intent.tsx` | `/qes/login` → `/login` už dnes projde stávajícím regexem |
| App obrazovka | `mobile/app/app/sign.tsx` | nová `login.tsx` podle stejného vzoru |
| Android intent filter | `mobile/app/app.json` (`pathPrefix: "/qes"`) | `/qes/login` už pokryto |
| iOS AASA | `Qes::WellKnownController` | přidat `/qes/login` |

**Závěr:** 70–80 % kódu je reuse; nové je jen párování certifikátu na uživatele, nový challenge,
browser binding, UI a testy.

---

## 3. Cíl a non-goals

### 3.1 Cíl

- Zaměstnanec se přihlásí do webového DocuSealu **bez hesla** tím, že v appce potvrdí
  challenge svým privátním klíčem (telefon) nebo čipem (budoucnost).
- Certifikát pro přihlášení se **jednorázově zaregistruje** k účtu (po přihlášení heslem).
- Server ověří: podpis challenge, řetěz k trust rootům, revokaci, že certifikát patří
  aktivnímu uživateli a že přihlášení inicioval **tento** browser.
- Vše je auditovatelné a uživatel má možnost certifikát odvolat.
- Není potřeba nová služba, nový QTSP, nový TSA ani nový volume.

### 3.2 Non-goals (v1)

- **Není to QES.** Přihlášení certifikátem není kvalifikovaný elektronický podpis; UI to tak
  nesmí nazývat. Certifikát může být kvalifikovaný, ale podepisuje se jen login challenge.
- **Nemění to podpis dokumentů.** QES/AdES pipeline, PAdES, pečeť, DocTS, DSS zůstávají beze změny.
- **Není to SSO/OIDC/SAML IdP.** Appka není identity provider; je to autentikátor.
- **Není to WebAuthn/passkey.** Klíč je RSA v appce, ne WebAuthn credential; viz § 4.3.
- **Není to mTLS.** Browser nemá privátní klíč; viz § 4.4.
- **Není to náhrada hesla vynucená politikou.** `force` je budoucí volba, ne v1.
- **Není to multi-tenant.** Self-hosted jeden účet; multi-tenant by potřeboval volbu účtu.
- **Není to login čipem v produkci.** Čtečka je stub (P5); jen telefonní klíč.

---

## 4. Varianty řešení

### 4.1 Browser-initiated: stejné zařízení + QR (doporučeno)

Browser vytvoří `LoginAttempt`, zobrazí QR (App Link) a kód. Telefon otevře odkaz, stáhne
challenge, zobrazí origin + kód, uživatel potvrdí biometrií, appka podepíše, server označí
attempt jako `approved`. Browser se refreshne, uživatel klikne „Přihlásit se“ a server ho přihlásí.

- **Pro:** funguje na mobilu (hlavní cíl) i na desktopu přes QR; žádná push infrastruktura;
  žádný nový server; reuse deep linků, vaultu, cert validace, CRL.
- **Proti:** na desktopu uživatel skenuje QR; login CSRF riziko řešené kódem + originem;
  jeden klik navíc po schválení (v1).
- **Proč doporučeno:** nejmenší nová plocha, nejlepší poměr cena/bezpečnost, sedí na
  „zaměstnanci, hlavně z mobilu“.

### 4.2 App-initiated: device code (jako BankID / Microsoft)

Uživatel otevře appku, zvolí „Přihlásit do DocuSealu“, appka vytvoří pokus a zobrazí
6místný kód; uživatel ho opíše do browseru.

- **Pro:** bez QR, bez deep linku; přirozené pro desktop; appka je iniciátor, takže login
  CSRF je obtížnější.
- **Proti:** uživatel musí přepisovat kód; appka potřebuje vědět, do kterého serveru se
  přihlašuje (další UI); horší UX; stále phishing (uživatel může kód dát útočníkovi).
- **Verdikt:** dobrý doplněk pro desktop, ale větší UX práce. V1 ne; případně v1.1 jako
  alternativa k QR.

### 4.3 WebAuthn/passkeys

Použít certifikát jako WebAuthn credential v prohlížeči.

- **Pro:** standard, prohlížeč řeší origin binding a UI; žádný deep link.
- **Proti:** WebAuthn vyžaduje specifické algoritmy (nejčastěji ES256/EdDSA) a formát
  credentialu; appčin klíč je RSA v PKCS#12 a appka není WebAuthn authenticator.
  Teoreticky by šlo postavit vlastní softwarový authenticator, ale to je nový velký projekt
  (CBOR, attestation, user verification, sync), ne tenká vrstva.
- **Verdikt:** dlouhodobě zajímavé, v1 ne.

### 4.4 mTLS (client certificate v browseru)

Browser pošle klientský certifikát při TLS handshake.

- **Pro:** standardní, server nemusí nic vymýšlet; žádný challenge.
- **Proti:** privátní klíč by musel být v browseru/OS key store; na mobilu to jde jen
  s nativním klíčem v OS, ale appka drží klíč ve svém vaultu. Pro eObčanku by browser
  potřeboval čtečku. Není to mobile-first a neumožňuje self-custody v appce.
- **Verdikt:** ne pro tento projekt.

### 4.5 SAML/OIDC s externím IdP

Napojit DocuSeal na existující firemní IdP.

- **Pro:** standardní, dobře podporované, méně kódu v DocuSealu.
- **Proti:** potřebuje IdP, správu identit a důvěru v poskytovatele; klíč není u člověka,
  ale u IdP. To je proti rozhodnutí #1 (self-custody, žádný remote QTSP).
- **Verdikt:** ne pro tento projekt; případně pro jiné zákazníky.

### 4.6 Srovnání

| Varianta | UX mobil | UX desktop | Login CSRF | Self-custody | Náročnost | Vhodnost |
|---|---|---|---|---|---|---|
| 4.1 browser + QR | dobré | QR + kód | střední, mitigace kód/origin | ano | střední | **doporučeno** |
| 4.2 app-initiated | dobré | opis kódu | nižší | ano | střední | v1.1 |
| 4.3 WebAuthn | výborné | výborné | nízké | částečně (nový authenticator) | vysoká | později |
| 4.4 mTLS | špatné | špatné | nízké | ne (klíč v browseru) | vysoká | ne |
| 4.5 SAML/OIDC | dobré | dobré | nízké | ne (klíč u IdP) | střední | ne |

---

## 5. Doporučený návrh

### 5.1 Tok

| Krok | Kdo | Co se děje | Bezpečnostní prvek |
|---|---|---|---|
| 1 | browser | `POST /qes/login/attempts` → `LoginAttempt` (`pending`) + `app_token`, `browser_secret`, `code`, `challenge` | CSRF, rate limit, session binding |
| 2 | browser | `GET /qes/login/attempts/:id` → QR + kód + „čeká na appku“ | `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| 3 | app | `GET /qes/login/sessions/:token` → challenge + origin + kód + `expires_in` | token v cestě, jen digest v DB, `X-QES-Protocol` |
| 4 | app | zobrazí origin + kód, uživatel potvrdí, biometrie, podepíše challenge | appka ověří prefix/origin/expiry; klíč se odemkne až po kontrole |
| 5 | app | `POST /qes/login/sessions/:token/complete` s certem, řetězem, podpisem | server ověří podpis, řetěz, CRL, párování na uživatele |
| 6 | browser | refresh stránky, stav `approved` → tlačítko „Přihlásit se“ | browser session + `browser_secret` |
| 7 | browser | `POST /qes/login/attempts/:id/finish` | CSRF, kontrola session, `sign_in` / OTP |
| 8 | server | `sign_in(user)` nebo OTP formulář, pak redirect | Devise session fixation protection |

**V1 bez JS:** krok 6 je `<meta http-equiv="refresh" content="2">`; po schválení se vykreslí
formulář s tlačítkem. Je to o jeden klik navíc, ale nulový JS a nulové CSP riziko.
**V1.1:** malý custom element `qes-login` polluje `GET /qes/login/attempts/:id/status`
a po `approved` automaticky odešle finish formulář.

### 5.2 Datový model

#### `qes_login_certificates` (registrované certifikáty pro přihlášení)

| Sloupec | Typ | Význam |
|---|---|---|
| `id` | bigint | PK |
| `account_id` | bigint, FK | účet |
| `user_id` | bigint, FK | uživatel |
| `fingerprint_sha256` | string, unique | SHA-256 DER certifikátu; lookup při loginu |
| `subject` | string | pro UI/audit |
| `issuer` | string | pro UI/audit |
| `serial` | string | pro UI/audit |
| `not_before`, `not_after` | datetime | platnost |
| `level` | string | `ades`/`qes` (jen informativní) |
| `key_type`, `key_size` | string/integer | RSA/ECDSA, 2048+ |
| `certificate_der` | text (base64) | veřejný certifikát pro audit |
| `enrolled_at` | datetime | kdy zaregistrován |
| `last_used_at` | datetime | poslední úspěšné přihlášení |
| `revoked_at` | datetime | lokální odvolání |
| `created_at`, `updated_at` | datetime | standard |

- Unikátní index na `fingerprint_sha256` (jeden certifikát = jeden uživatel).
- Index `[user_id, revoked_at]`.
- Privátní klíč se **nikdy** neukládá.

#### `qes_login_attempts` (challenge / login pokus)

| Sloupec | Typ | Význam |
|---|---|---|
| `id` | bigint | PK |
| `account_id` | bigint, nullable | doplní se po ověření |
| `user_id` | bigint, nullable | u `enroll` hned, u `login` po ověření |
| `qes_login_certificate_id` | bigint, nullable | po ověření |
| `purpose` | string | `login` / `enroll` |
| `state` | string | `pending`/`scanned`/`approved`/`consumed`/`expired`/`failed`/`cancelled` |
| `app_token_digest` | string, unique | SHA-256 tokenu pro appku |
| `browser_secret_digest` | string | SHA-256 secretu v browser session |
| `code` | string | 6 číslic pro porovnání browser/app |
| `challenge` | text | kanonický challenge |
| `challenge_digest` | string | SHA-256 challenge |
| `origin` | string | normalizovaný origin serveru |
| `certificate_fingerprint_sha256` | string, nullable | po ověření |
| `certificate_attempts` | integer | počet pokusů s jiným certem |
| `failure_code` | string, nullable | audit |
| `signature` | binary, nullable | podpis challenge pro audit |
| `key_location` | string, nullable | `phone_keystore`/`card` |
| `app_metadata` | text (JSON), nullable | platforma, verze, reader |
| `certificate_info` | text (JSON), nullable | subject/issuer/serial/level |
| `ip`, `user_agent` | string | audit |
| `expires_at` | datetime | TTL challenge |
| `approved_at`, `consumed_at`, `expired_at`, `failed_at`, `cancelled_at` | datetime | audit |
| `created_at`, `updated_at` | datetime | standard |

- `app_token_digest` unique; raw token jen v QR/deep linku, nikdy v DB.
- `browser_secret_digest`; raw secret jen v podepsané Rails session (HttpOnly cookie).
- `challenge` není tajný po načtení appkou, ale před načtením ho chrání `app_token`.
- `signature` je veřejný důkaz; ukládá se pro audit úspěšného přihlášení.

### 5.3 Endpointy

| Metoda | Cesta | Kdo | Účel |
|---|---|---|---|
| `POST` | `/qes/login/attempts` | browser | start loginu; vytvoří attempt, uloží browser secret do session, redirect na waiting page |
| `GET` | `/qes/login/attempts/:id` | browser | waiting page (QR, kód, stav); po `approved` formulář „Přihlásit se“ |
| `POST` | `/qes/login/attempts/:id/finish` | browser | ověří session, `sign_in` nebo redirect na OTP |
| `POST` | `/qes/login/attempts/:id/otp` | browser | ověří TOTP, `sign_in` |
| `DELETE` | `/qes/login/attempts/:id` | browser | zruší attempt |
| `GET` | `/qes/login?token=…` | browser | fallback stránka s QR, custom scheme a odkazem na appku |
| `GET` | `/qes/login/sessions/:token` | app | vrátí challenge, origin, kód, `expires_in`; `purpose` |
| `POST` | `/qes/login/sessions/:token/complete` | app | cert + chain + signature → `approved` |
| `POST` | `/qes/login/sessions/:token/abort` | app | `cancelled` |
| `GET` | `/qes/login/certificates` | browser (auth) | seznam certifikátů pro přihlášení |
| `POST` | `/qes/login/certificates` | browser (auth) | start registrace (`purpose=enroll`) |
| `DELETE` | `/qes/login/certificates/:id` | browser (auth) | odvolání certifikátu |

- `GET /qes/login/sessions/:token` a `POST …/complete` jsou bez `authenticate_user!`,
  s `protect_from_forgery with: :null_session` a rate limitem, stejně jako QES sessions.
- Browser endpointy mají normální CSRF a session; `POST …/finish` a `…/otp` jsou
  formuláře s CSRF, ne JSON.
- `GET …/status` je volitelný pro v1.1 (JS auto-submit); v1 stačí meta refresh.

#### Limity

| Limit | Hodnota | Kde |
|---|---|---|
| certifikát | 8 KB | `Qes::Login::ControllerConcern::MAX_CERTIFICATE_BYTES` |
| řetěz | 5 certifikátů | `Qes::Login::ControllerConcern::MAX_CHAIN` |
| podpis | 16 KB | `Qes::Login::ControllerConcern::MAX_SIGNATURE_BYTES` |
| start | 20 / 5 min / IP | `Qes::Login::RateLimiter` |
| app fetch | 60 / 5 min / IP | `Qes::Login::RateLimiter` |
| app fetch | 20 / 5 min / token | `Qes::Login::RateLimiter` |
| app complete | 20 / 5 min / IP | `Qes::Login::RateLimiter` |
| app complete | 5 / 5 min / token | `Qes::Login::RateLimiter` |
| app complete | 10 / 5 min / cert | `Qes::Login::RateLimiter` |
| finish | 10 / 5 min / session | `Qes::Login::RateLimiter` |
| OTP | 5 / 5 min / user | `RateLimit.call` |

### 5.4 Formát challenge

Challenge je UTF-8 text s pevným prefixem a jedním polem na řádek:

```text
DOKULACHTAN-LOGIN-V1
origin: https://dokulachtan.fly.dev
attempt: 42
purpose: login
code: 123456
nonce: 3q2-7wX9...
expires: 2026-10-28T12:34:56Z
```

- Appka podepíše **přesně tyto bajty** (SHA-256, RSA PKCS#1 v1.5; u karty stejný
  primitiv jako u QES).
- Server ověří podpis vůči **uloženému** challenge, ne vůči tomu, co pošle appka.
- Prefix `DOKULACHTAN-LOGIN-V1` je doménové oddělení: PDF TBS začíná `%PDF-`,
  login challenge začíná prefixem. Appka jiný prefix odmítne, takže kompromitovaný
  server nemůže přes login vynutit podpis dokumentu.
- `origin` se normalizuje (`scheme://host[:port]`, bez cesty/query); appka ho
  zobrazí a ověří proti serveru, na který posílá.
- `code` je 6 číslic; není tajný, je to kontrolní kód pro uživatele.
- `nonce` je 32 náhodných bajtů (base64url), `expires` je UTC ISO8601.
- Server challenge ukládá a ověřuje přesně; `challenge_digest` je pro audit.

### 5.5 Stavový automat

| Stav | Význam | Povolené přechody |
|---|---|---|
| `pending` | browser vytvořil attempt, čeká | `scanned`, `expired`, `failed`, `cancelled` |
| `scanned` | appka otevřela odkaz | `approved`, `expired`, `failed`, `cancelled` |
| `approved` | podpis ověřen, čeká na browser/OTP | `consumed`, `expired`, `cancelled` |
| `consumed` | browser dokončil `sign_in` | — |
| `expired` | TTL | — |
| `failed` | max cert pokusů / neplatný stav | — |
| `cancelled` | uživatel zrušil | — |

- Přechody jsou atomické (`UPDATE … WHERE id = ? AND state = ?`), stejně jako
  `Qes::SessionManager`.
- `scanned` je volitelný; pokud appka odkaz nikdy neotevře, `pending` expiruje.
- `approved` může expirovat, pokud browser nedokončí v `QES_LOGIN_ATTEMPT_TTL`.
- `consumed` je terminální; opakovaný finish vrací 410.

### 5.6 Registrace certifikátu pro přihlášení

- **Self-service (v1):** uživatel přihlášený heslem → Profil → „Přihlašování certifikátem“ →
  „Přidat certifikát“ → `POST /qes/login/certificates` → attempt `purpose=enroll` →
  stejná waiting page + QR/kód → appka podepíše → server uloží `QesLoginCertificate`
  pro `current_user` → browser finish → „Certifikát byl přidán“.
- **Admin (v1):** `UsersController#edit` zobrazí seznam certifikátů uživatele a
  „Odvolat“; oprávnění `can :manage, QesLoginCertificate, user: { account_id: … }`
  (DocuSeal dnes nemá striktní admin roli, každý uživatel účtu může spravovat
  uživatele; sjednotit s `can :manage, User`).
- **Žádné auto-provisioning podle e-mailu ze subjectu.** Kvalifikovaný certifikát
  nemusí mít e-mail a shoda e-mailu není důkaz totožnosti. Registrace je explicitní.
- **Idempotence:** stejný cert pro stejného uživatele = OK; pro jiného uživatele =
  `certificate_in_use`; stejný cert pro stejného uživatele znovu = update `last_used_at`.
- **Ověření při registraci:** stejné jako login (podpis challenge, řetěz, CRL,
  platnost, key usage). Ukládá se jen veřejný certifikát, nikdy privátní klíč.
- **Odvolání:** `revoked_at`; login ho odmítne. U archivovaného uživatele
  `active_for_authentication?` odmítne; při archivaci lze certy odvolat (volitelné).

### 5.7 Přihlášení, OTP, session a redirect

- **Bez OTP:** `POST …/finish` → `sign_in(user)` → `redirect_to after_sign_in_path_for(user)`.
- **S OTP:** `POST …/finish` → redirect na `GET …/otp`; OTP formulář → `POST …/otp` →
  `user.validate_and_consume_otp!` → `sign_in(user)`.
- **FORCE_MFA:** pokud uživatel nemá OTP a je zapnuté `FORCE_MFA`, `sign_in` ho pustí
  a `DashboardController#maybe_redirect_mfa_setup` ho pošle na setup; to je stejné jako
  u hesla. Není to nová díra, ale je to UX krok.
- **Session fixation:** `sign_in` v Devise obnoví session; attempt ID a browser secret
  se čtou před `sign_in`, po `sign_in` se klíče vymažou. Otestovat.
- **Open redirect:** `after_sign_in_path_for` dnes vrací `params[:redir]` bez validace
  hostitele. Pro nový tok `redir` buď ignorovat, nebo validovat `url_from`
  (povolit jen lokální cestu). Stávající chování neměnit, jen ho nekopírovat.
- **Remember me:** `User#remember_me` vrací `true`; Devise remember token se nastaví
  podle `remember_me` v `sign_in`. Pro login certem to nechat na výchozím chování.
- **Trackable:** `sign_in` zapíše `current_sign_in_at`, `last_sign_in_at`,
  `current_sign_in_ip`, `sign_in_count`; to je audit.
- **Lockable:** `active_for_authentication?` odmítne zamčený účet; chyby OTP se
  počítají do `failed_attempts` jen pokud použijeme Devise strategy. Pro cert login
  doporučuji explicitní rate limit a `failed_attempts` nechat na OTP.

### 5.8 App obrazovka (S16)

- `app/login.tsx` (nová route; App Link `/qes/login` → `/login` už dnes projde
  stávajícím `+native-intent.tsx` regexem, custom scheme `dokulachtan://login` taky).
- Načte `token` z query, `resolveSigningOrigin(platformVaultDeps().storage)` (bez
  `server` parametru; server URL je v Nastavení), `new LoginApi(origin, token)`.
- Zobrazí:
  - „Přihlášení do DocuSealu“ / „Přidání certifikátu pro přihlášení“
  - origin serveru
  - kód pro kontrolu (6 číslic)
  - subject certifikátu z vaultu
  - „Přihlásit se“ (primary), „Zrušit“ (text)
  - pokud není certifikát: „Importovat klíč“ (primary) + vysvětlení
  - pokud je potřeba čtečka: „Připojit čtečku“ (ale dnes stub → chyba)
- Po úspěchu: „Přihlášeno do <origin>. Vraťte se do prohlížeče.“ + „Zavřít“.
- Po registraci: „Certifikát byl přidán. Vraťte se do prohlížeče.“
- Chybové texty: `unknown_certificate`, `certificate_in_use`, `revoked`,
  `certificate_expired`, `not_trusted`, `not_qualified`, `signature_invalid`,
  `expired_token`, `used_token`, `unknown_token`, `foreign_server`, `invalid_server`,
  `rate_limited`, `network`, `no_signer`, `needs_reader`, `reader_not_found`.
- Token ani challenge se nikdy nelogují, neukládají do SecureStore a neposílají
  do error hlášky.

### 5.9 Web UI

- **Login stránka:** pod heslo formulář přidat tlačítko „Přihlásit se certifikátem“
  (`button_to` na `POST /qes/login/attempts`, `data: { turbo: false }`), jen když
  `QES_LOGIN_ENABLED=true`.
- **Waiting page:** karta s QR (App Link), custom scheme odkaz, kód, „čeká na
  potvrzení v appce“, tlačítko „Zrušit“; po `approved` formulář „Přihlásit se“.
- **Registrace:** sekce v Profilu „Přihlašování certifikátem“ se seznamem certů,
  „Přidat certifikát“ a „Odvolat“; jen při `QES_LOGIN_ENABLED=true`.
- **Admin:** v editaci uživatele seznam certů a „Odvolat“; volitelné pro v1.
- **Audit:** v1 DB + `last_used_at`; samostatná stránka historie přihlášení v1.1.
- **Bez změny:** `app/views/devise/sessions/new.html.erb` (jen partial), `sessions_controller.rb`
  (heslo/OTP beze změny), `verify_pdf_signature.rb` (bit-identický s upstreamem).

### 5.10 Konfigurace a nasazení

| ENV | Default | Význam |
|---|---|---|
| `QES_LOGIN_ENABLED` | `false` | feature flag; bez něj tlačítko není a endpointy vrací 404 |
| `QES_LOGIN_REQUIRE_QUALIFIED` | `true` | vyžadovat `QcCompliance` (AdES/QES), ne libovolný cert |
| `QES_LOGIN_REQUIRE_REVOCATION` | `true` | CRL kontrola; při nedostupnosti fail closed |
| `QES_LOGIN_TRUST_ROOTS` | fallback `QES_TRUST_ROOTS` | trust roots pro login |
| `QES_LOGIN_DEEP_LINK_BASE` | `dokulachtan://login` | custom scheme |
| `QES_LOGIN_ATTEMPT_TTL` | `120` | platnost challenge v sekundách |
| `QES_LOGIN_MAX_CERTIFICATE_ATTEMPTS` | `3` | kolik různých certů lze zkusit v jednom attemptu |
| `QES_LOGIN_CRL_CACHE_TTL` | `3600` | cache CRL (vteřiny) |
| `QES_LOGIN_RETENTION_DAYS` | `90` | retence auditních attemptů |
| `QES_PUBLIC_BASE_URL` | už existuje | origin v challenge a odkazy |
| `QES_LTV_ALLOWED_HOSTS` | už existuje | SSRF allowlist pro CRL |

- **Žádné nové secrets.** Žádný nový TSA, žádný nový volume, žádný Postgres.
- **Staging first:** `QES_LOGIN_ENABLED=true`, test root + PostSignum, `QES_LOGIN_REQUIRE_REVOCATION=true`,
  test CRL na staging hostu. Ověřit `make qes-login-staging`.
- **Produkce:** až po staging e2e; jen PostSignum, `QES_LOGIN_REQUIRE_QUALIFIED=true`,
  `QES_LOGIN_REQUIRE_REVOCATION=true`, CRL cache.
- **AASA:** přidat `/qes/login` do `apple_app_site_association`; Android `pathPrefix: "/qes"`
  už `/qes/login` pokrývá, žádná změna manifestu.
- **APK:** bump verze, `make qes-app-test` + `make qes-app-typecheck`, nový APK; testovací APK
  je debug-signed, produkční release-signed. `QES_ANDROID_CERT_SHA256` je fingerprint
  **Android podpisu APK**, ne certifikátu pro podpis dokumentů.
- **Staging App Links:** host v `app.json` je `dokulachtan.fly.dev`, staging by vyžadoval
  rebuild s `dokulachtan-staging.fly.dev`; custom scheme funguje vždy, proto je fallback.

### 5.11 Úklid

- `Qes::Login::ExpireAttemptsJob` každou minutu: `pending`/`scanned`/`approved` po
  `expires_at` → `expired`; staré `consumed`/`expired`/`failed`/`cancelled` po
  `QES_LOGIN_RETENTION_DAYS` smazat.
- Job se plánuje jen při `QES_LOGIN_ENABLED=true`, v testu ne.
- Stejný vzor jako `Qes::ExpireSessionsJob`.

### 5.12 Chybové kódy

| Kód | HTTP | Význam | UI |
|---|---|---|---|
| `unknown_token` | 404 | token neexistuje | „Neplatný odkaz.“ |
| `expired_token` | 410 | TTL | „Platnost odkazu vypršela.“ |
| `used_token` | 410 | consumed/cancelled | „Odkaz už byl použit.“ |
| `wrong_state` | 409 | neplatný přechod | „Požadavek už není platný.“ |
| `invalid_certificate` | 422 | cert nelze parsovat / příliš velký | „Certifikát se nepodařilo načíst.“ |
| `certificate_expired` | 422 | mimo platnost | „Platnost certifikátu vypršela.“ |
| `not_qualified` | 422 | chybí `QcCompliance` | „Server vyžaduje kvalifikovaný certifikát.“ |
| `unsupported_key` | 422 | EC/velikost | „Nepodporovaný klíč.“ |
| `not_trusted` | 422 | řetěz k trust rootu | „Certifikát není důvěryhodný.“ |
| `revoked` | 422 | CRL / lokální revokace | „Certifikát byl odvolán.“ |
| `ltv_unavailable` | 422 | CRL nedostupné | „Revokační data nejsou dostupná.“ |
| `signature_invalid` | 422 | podpis nesedí | „Podpis se nepodařilo ověřit.“ |
| `challenge_mismatch` | 422 | podepsaný challenge nesedí | „Challenge se změnil.“ |
| `unknown_certificate` | 422 | cert není registrovaný | „Certifikát není pro přihlášení zaregistrovaný.“ |
| `certificate_in_use` | 422 | cert patří jinému uživateli | „Certifikát je registrovaný pro jiného uživatele.“ |
| `account_disabled` | 422 | archivovaný uživatel/účet | „Účet je zablokovaný.“ |
| `rate_limited` | 429 | limit | „Příliš mnoho pokusů.“ |
| `disabled` | 404 | feature flag | „Přihlášení certifikátem není zapnuté.“ |

---

## 6. Bezpečnostní analýza

### 6.1 Threat model

| Hrozba | Dopad | Mitigace | Zbytkové riziko |
|---|---|---|---|
| **Login CSRF**: útočník vytvoří attempt a oběti podstrčí odkaz; oběť podepíše, útočníkův browser se přihlásí jako oběť | útočník vidí data oběti | kód v browseru i appce, origin v challenge, krátký TTL, browser session binding, explicitní „Přihlásit se“; appka varuje, pokud se právě nepřihlašuje | pokud uživatel kód neporovná, riziko zůstává; proto UI musí být explicitní |
| **Token phishing**: útočník pošle odkaz na vlastní server | podpis challenge pro cizí server | appka ověří origin proti Nastavení; `foreign_server`; challenge obsahuje origin | uživatel může změnit server v Nastavení; dokumentovat |
| **Replay** challenge | opakované přihlášení | one-time token, `consumed`, TTL, challenge v DB | žádné |
| **Krádež telefonu / malware** | podpis jako uživatel | biometrie, vault, krátký TTL; bez device attestation | malware s biometrií / root může podepsat; budoucí Play Integrity/App Attest |
| **Revokovaný cert** | přihlášení revokovaným certem | CRL + lokální `revoked_at`, fail closed | CRL může být nedostupné → login nedostupný (únosnost) |
| **Nedůvěryhodný cert** | falešná identita | řetěz k `QES_LOGIN_TRUST_ROOTS`, `QcCompliance` | kompromitovaná CA / trust root |
| **MITM** | krádež tokenu | TLS, `assertResponseOrigin`, `redirect: 'error'`, token jen v paměti | kompromitovaný server |
| **Session fixation** | převzetí session | Devise `sign_in` obnoví session; test | — |
| **Open redirect** | phishing po loginu | validovat `redir` nebo ignorovat | stávající chování `after_sign_in_path_for` je zranitelné; nový tok ho nesmí kopírovat |
| **Enumerace certů** | zjištění, kdo má cert | `unknown_certificate` až po podpisu; start bez e-mailu | útočník s soukromým klíčem se přihlásí tak jako tak |
| **DoS** | zahlecní login endpointů | rate limit per IP/token/cert, limity certu/řetězu, fronta | distribuovaný útok; Fly rate limit / WAF |
| **Log leakage** | token v logu | `filter_parameters` + lograge bez `path`; token nikdy v chybě | — |
| **Zneužití jako podpis dokumentu** | server vynutí podpis PDF | prefix `DOKULACHTAN-LOGIN-V1`; appka odmítne jiný prefix; raw challenge není CMS | — |

### 6.2 Co je potřeba dodržet

1. **Nikdy nepárovat cert podle e-mailu ze subjectu.** Jen explicitní registrace.
2. **Nikdy neposílat privátní klíč.** Server vidí jen veřejný cert, řetěz a podpis.
3. **Nikdy nenazývat login QES.** Je to autentizace certifikátem; certifikát může být
   kvalifikovaný, ale podepisuje se login challenge, ne dokument.
4. **Nikdy nedovolit podpis PDF TBS přes login challenge.** Prefix a kontrola v appce.
5. **Nikdy nespoléhat na to, že appka je důvěryhodná.** Server ověří vše, co může:
   podpis, řetěz, CRL, stav, session, expiry.
6. **Nikdy nezobrazovat token v UI ani v logu.** Appka ho drží jen v paměti.
7. **Nikdy nedovolit `finish` z appky.** Browser session + `browser_secret`; appka
   jen schválí, browser dokončí.
8. **Nikdy nezapnout `force` bez break-glass.** V1 `force` ne.

### 6.3 Residual risks

- Uživatel může ignorovat kód a potvrdit phishingový login. UI to musí říkat
  jasně; nejde to technicky vynutit.
- Malware s přístupem k biometrii nebo root může podepsat. Bez Play Integrity /
  App Attest to nejde spolehlivě detekovat.
- CRL nedostupné → login nedostupný (fail closed). Je to vědomá volba; konfigurovatelné.
- Staging App Links kvůli hostu v APK; custom scheme je fallback.
- Karta/QES login je blokovaný P5; telefonní klíč je AdES.

---

## 7. Testovací plán

### 7.1 Server

| Test | Co ověřuje |
|---|---|
| `spec/lib/qes/login/challenge_spec.rb` | prefix, canonical formát, parse, origin, expiry, code |
| `spec/lib/qes/login/verifier_spec.rb` | platný podpis, špatný podpis, expired cert, untrusted chain, revoked, unknown cert, archived user, replay |
| `spec/models/qes_login_certificate_spec.rb` | unique fingerprint, revocation, active scope, level info |
| `spec/models/qes_login_attempt_spec.rb` | stavový automat, token digest, browser secret, expiry, purpose |
| `spec/requests/qes_login_spec.rb` | start → app fetch → complete → status → finish → `sign_in`; OTP; cancel; replay; wrong session; rate limit; CSRF; disabled; cert in use; unknown cert |
| `spec/requests/qes_login_certificates_spec.rb` | enroll, list, revoke, authorization |
| `spec/requests/qes_views_spec.rb` | login button, waiting page, enrollment section |
| `spec/jobs/qes/expire_login_attempts_job_spec.rb` | expiry, retence |

### 7.2 Appka

| Test | Co ověřuje |
|---|---|
| `src/lib/loginApi.test.ts` | endpointy, origin, error payload, token jen v paměti |
| `src/lib/loginCeremony.test.ts` | challenge parse, signer selection, vault unlock, post, error mapping |
| `src/lib/loginChallenge.test.ts` | prefix, origin, code, expiry, malformed |
| `app/login.test.tsx` | UI stavy, success, error, no cert, enroll |
| `src/lib/signingOrigin.test.ts` | beze změny; jen regression |

### 7.3 E2E a negativní

- `make qes-login-e2e` (nový `scripts/qes_login_e2e.py`): bootstrap účet + test cert pro přihlášení
  → browser start → app fetch/complete (test cert) → browser finish → ověření `sign_in` a session.
- `make qes-login-staging`: proti stagingu, test root + test CRL; ověří, že login projde
  a že `last_used_at` se zapíše.
- `make qes-login-negative`: N1–N10: špatný podpis, expired cert, revoked cert,
  untrusted chain, unknown cert, replay, expired attempt, wrong browser session,
  rate limit, OTP fail.
- Manuálně: Android emulátor + desktop browser QR; staging; produkce s test certem
  (očekávaně `not_trusted`).

### 7.4 Co netestovat v T0

- Login nezasahuje do QES pipeline; T0 (`make qes-test-qes`) musí zůstat zelené.
- T1/T2 musí zůstat zelené; nové request specy přibudou do QES sady.
- `lib/verify_pdf_signature.rb` musí zůstat bit-identický s upstreamem.

---

## 8. Pracnost a fáze P9

| Fáze | Co | Odhad | Verifikace |
|---|---|---|---|
| **P9.1** | Server core: `QesLoginCertificate`, `QesLoginAttempt`, migrace, `Qes::Login::Config`, challenge, verifier, CRL cache, `validate_for_login!` | 3 dny | `make qes-test-qes` + nové lib/model specy |
| **P9.2** | Browser: start/waiting/finish/otp/cancel, login tlačítko, registrace v Profilu, admin revoke, rate limit, audit | 3 dny | request/view specy; manuálně browser + app |
| **P9.3** | Appka: `loginApi`, `loginCeremony`, `login.tsx`, challenge parser, error mapping, deep link | 3 dny | `make qes-app-test`, `make qes-app-typecheck` |
| **P9.4** | Testy: request/model/lib, Jest, e2e, negativní, staging | 3 dny | `make qes-login-e2e`, `make qes-login-negative`, `make qes-login-staging` |
| **P9.5** | Dokumentace, runbook, deploy, feature flag, APK | 1–2 dny | staging + produkce; `/up` 200; login e2e |
| **Celkem** | | **13–18 člověkodnů** | |

**Závislosti:**

- P9.1–P9.4 nezávisí na P5 (telefonní klíč).
- P9 s kartou/QES závisí na P5 reálné MOI SDK; dnes jen `FakeCardSigner` v testech.
- P9 lze začít po P4/P8; QES pipeline se nemění.

**Rebase cost:** ~11 doteků upstreamu (routes, partial, profile, user form, user model,
AASA, locales, schema, initializer, `certificate_info`, `ltv`), žádný zásah do
`verify_pdf_signature.rb` ani do QES signing pipeline. Menší než stávajících 21–24 doteků.

---

## 9. Rizika a otevřené otázky

| Riziko | Dopad | Mitigace |
|---|---|---|
| Login CSRF / phishing | útočník přihlásí oběť do svého browseru | kód + origin + TTL + explicitní potvrzení; dokumentovat zbytkové riziko |
| Krádež telefonu / malware | podpis jako uživatel | biometrie, krátký TTL; budoucí Play Integrity/App Attest |
| Reálná čtečka není hotová (P5) | QES/čip login nejde | v1 telefonní klíč (AdES); karta až po P5 |
| CRL PostSignum je velké / pomalé | login latency / nedostupnost | cache + fail closed; `QES_LOGIN_REQUIRE_REVOCATION` |
| Trust roots jen PostSignum | firemní certy neprojdou | `QES_LOGIN_TRUST_ROOTS`; dokumentovat |
| Staging App Links host | staging odkaz neotevře APK | custom scheme; dokumentovat |
| Stará appka bez `/login` | odkaz skončí v „Unmatched Route“ | fallback stránka s „aktualizujte appku“; bump verze |
| Open redirect v `after_sign_in_path_for` | phishing po loginu | validovat `redir` nebo ignorovat |
| 2FA | uživatel s TOTP má další krok | zachovat; rate limit; text |
| Registrace certu | uživatel musí nejdřív heslem | explicitní UI; žádný auto-provisioning |
| Rebase | Devise a views se mohou změnit | malé doteky, testy, dokumentace |

### 9.1 Otevřené otázky a doporučení

1. **Vyžadovat kvalifikovaný cert (`QcCompliance`)?** Doporučuji **ano** (`QES_LOGIN_REQUIRE_QUALIFIED=true`),
   protože projekt je o kvalifikovaných certifikátech a brání to použití libovolného TLS certu.
   Konfigurovatelné pro firemní CA.
2. **Vyžadovat OTP, pokud je zapnuté?** Doporučuji **ano**. Cert + biometrie je silné, ale server
   biometrii nevidí; TOTP je obrana navíc. Uživatel bez OTP má jen cert + biometrii.
3. **Vynutit cert login (`force`)?** V1 **ne**. Nejdřív sbírat zkušenosti; break-glass a admin
   bypass by byly potřeba. `AccountConfig::FORCE_SSO_AUTH_KEY` je vzor pro budoucnost.
4. **Registrace self-service, nebo admin?** V1 **self-service** po přihlášení heslem;
   admin revoke v editaci uživatele. Hromadný import certů (CSV) je v1.1.
5. **Karta/čip v v1?** **Ne**, dokud není reálná MOI SDK (P5). Dnes jen `FakeCardSigner`
   v testech; login s kartou by v produkci skončil `reader_not_found`.
6. **QR kód na desktopu?** **Ano**, je to hlavní cesta pro desktop. Na mobilu stačí
   tlačítko „Otevřít aplikaci“ (custom scheme) a App Link.
7. **Auto-close appky po úspěchu?** V1 **ne**; ukaž „Přihlášeno“ + „Zavřít“. Auto-close je
   platformově nespolehlivý a uživatel má vidět, co se stalo.
8. **Historie přihlášení v UI?** V1 **ne**; DB audit + `last_used_at`. UI historie v1.1.
9. **`server` parametr v odkazu?** V1 **volitelně**: pokud půjde snadno, přidat
   `&server=<origin>` pro staging; appka ho ověří proti Nastavení. Bez něj funguje
   produkce a staging s ručním nastavením serveru.
10. **Per-account politika?** V1 **ne**; globální ENV. Per-account `AccountConfig` je
    budoucnost pro multi-tenant.

---

## 10. Rozhodnutí a doporučení

### 10.1 Rozhodnutí

- **GO** pro P9 „Přihlášení certifikátem“ s telefonním klíčem (AdES), feature flag,
  staging first, bez `force`.
- **NO-GO** pro QES/čip login do dokončení P5 reálné čtečky; dnes jen testovací
  `FakeCardSigner`.
- **NO** pro nahrazení hesla v v1; cert login je další metoda.
- **NO** pro auto-provisioning podle e-mailu; jen explicitní registrace.
- **NO** pro nazývání „QES login“; je to autentizace certifikátem.
- **NO** pro zásah do `verify_pdf_signature.rb` a QES podpisové pipeline.

### 10.2 Co udělat, když bude schváleno

1. Přidat `docs/23-login-with-dokulachtan.md` do mapy v `AGENTS.md` a P9 do `PLAN.md`.
2. P9.1 server core + migrace + testy; `make qes-test-qes` zelené.
3. P9.2 browser flow + registrace + OTP + rate limit; request/view specy.
4. P9.3 appka `login.tsx` + `loginApi` + `loginCeremony`; `make qes-app-test` a typecheck.
5. P9.4 e2e + negativní + staging; `make qes-login-e2e`, `make qes-login-staging`.
6. P9.5 dokumentace, runbook, feature flag na produkci; `/up` 200; manuální test.
7. Teprve potom zvážit `force` a kartu/QES.

### 10.3 Co nedělat

- Nepřidávat novou službu, sidecar, Postgres, Redis, push notifikace, OIDC/SAML.
- Neměnit `lib/verify_pdf_signature.rb`.
- Neměnit QES podpisovou pipeline kromě volitelné cache v `Qes::Ltv`.
- Nepoužívat heslo k PKCS#12 při přihlášení; jen biometrie.
- Neukládat privátní klíč, token ani browser secret do logů.
- Neoznačovat login jako QES.

---

## 11. Závěr

„Login with Dokulachtan“ je **proveditelný a bezpečně realizovatelný** jako tenká vrstva nad
stávající QES infrastrukturou. Nejdražší není kryptografie, ale **bezpečný browser binding,
registrace certifikátu a UX**, aby uživatel nepodepsal cizí login. Doporučuji P9 spustit
s telefonním klíčem, feature flagem a stagingem; kartu/QES přidat až po reálné P5. Odhad
13–18 člověkodnů. Pokud se projekt rozhodne pokračovat, je další krok schválit tento návrh
a zapsat P9 do `PLAN.md`.

# Co dořešit před startem implementace

Datum: 2026-10-15

Stav: **rozhodnuto a implementováno**. Tento dokument je rozhodovací záznam z doby před
implementací forku a appky; aktuální stav je v [AGENTS.md](../AGENTS.md#stav) a v [PLAN.md](../PLAN.md).
Doporučení jsou označená „→“.

## A. Mobilní appka (varianta B) — rozhodnuto: **Expo**

1. **Technologie: Expo (React Native).** → Sdílené UI v JS/TS, hotové moduly pro
   bezpečné úložiště, biometrii, deep link i soubory. Signing v1 čistě v JS (`node-forge`),
   později nativní modul (Expo Modules API) pro podpis v nativní vrstvě.
2. **Platformy v1.** → **Android first** (v tomto prostředí testovatelné na emulátoru);
   Expo je cross-platform, iOS se přidá později (netestováno, potřebuje macOS/Xcode).
3. **Import klíče.** → **PKCS#12 soubor** přes document picker (přesně to, co umí iSignum
   exportovat). Později QR přenos z desktopu.
4. **Uložení klíče.** Importovaný PKCS#12 **nelze** dát do hardwarového keystore (Android
   Keystore / iOS Secure Enclave umí jen generovat klíče). → `expo-file-system` (app-private)
   + AES-GCM klíč v `expo-secure-store`, odemčení přes `expo-local-authentication`;
   biometrie při každém podpisu.
5. **Revize dokumentu.** → V prohlížeči (PDF už je tam); appka zobrazí hash + jméno dokumentu
   + cert a vyžádá biometrii.
6. **Push notifikace.** → v1 ne (deep link z e-mailu), `expo-notifications` později.
7. **Obnova certu.** → v1 upozornění na expiraci + ruční re-import.

**Expo moduly:** `expo-secure-store`, `expo-file-system`, `expo-local-authentication`,
`expo-linking`, `expo-document-picker`; signing `node-forge` (v1). Pro nativní modul
(později) je potřeba dev build (`npx expo run:android` — SDK i Gradle jsou k dispozici).

**Protokol podpisu:** server pošle **podepsané atributy CMS** (ne digest dokumentu), appka
podepíše SHA-256 přes `node-forge` (`rsa.sign`) a vrátí raw signaturu; server ji vloží do CMS
a PDF. (Ověřeno v mobile PoC: podepisovat atributy, ne digest dokumentu.)

## B. DocuSeal fork

8. **Repo strategie.** → fork ve větvi **`dokulachtan`** (upstream `docusealco/docuseal`, remote `upstream`),
   lineární historie, žádné merge commity, patch izolovaný (`app/lib/qes/…`). Podrobnosti a pravidla:
   [08 — Fork workflow](08-fork-workflow.md). Inicializace: `make fork-setup`.
9. **Hook do generování PDF.** → v `Submissions::GenerateResultAttachments` /
   `GenerateCombinedAttachment`: pokud existuje podepsané PDF, použije se místo generovaného.
10. **Pole `qes`.** Nový typ v template builderu; v signing formuláři tlačítko „Podepsat certifikátem“
    + stav (čeká na appku / podepsáno).
11. **Audit.** Zapisovat: subject/issuer/serial certu, čas, hash, úroveň (QES/AdES), výsledek validace;
    ukládat do DocuSeal auditu + vlastní log.
12. **Varianta A v1.** → **stub + fake card** v appce (rozhraní MOI Podpisové SDK; čtečky ACR 3901 U-S1,
    bR301 BLE, CT 1100, AirID 2, USB OTG); reálná čtečka je mimo v1. Server PKCS#11 neimplementuje
    (A je client-side). Detail: [DESIGN.md](../DESIGN.md) § 6 a [SPEC.md](../SPEC.md) § 9.4.

## C. Provoz a bezpečnost

13. **Deployment (staging).** → **varianta A**: 1 Fly app `dokulachtan` + volume + SQLite, region `fra`;
    konfigurace `deploy/docuseal/fly*.toml` v parent repu. Detail: [09 — Deployment na Fly.io](09-deployment-flyio.md).
14. **Varianta A je client-side.** Čtečka je u uživatele; server PKCS#11 neimplementuje. V cloudu ji
    řeší appka / lokální agent (nebo A jen v self-hosted/LAN).
15. **Kde běží příjem podpisu.** → součást forku (žádný sidecar): `POST /qes/sessions/:token/complete`.
16. **Trust roots pro validaci.** I.CA test root pro testy, produkční rooty pro reál; nikdy netrustovat vše.
17. **Token pro appku.** Jednorázový, vázaný na session + hash, TTL 5–10 min, HTTPS only.
18. **Licence.** Fork zůstává AGPL-3.0 + attribution; mobilní appka vlastní licence.

## D. Co je hotové

- Průzkum, rozhodnutí, e2e toolchain, DocuSeal baseline, negativní/LTV scénáře a mobile PoC.
- Fork (pole `qes`, `Qes::Providers`, hooky), mobilní appka a napojení appky na DocuSeal — hotové
  v P0–P8 kromě reálné čtečky (P5 je stub + fake card); viz [PLAN.md](../PLAN.md)
  a [AGENTS.md](../AGENTS.md#stav).

#!/usr/bin/env bash
# Test parseru otisku (#18.2): build-tools ≤36 a 37 tisknou jiný formát
# `apksigner verify --print-certs`, takže `awk -F': ' '{print $3}'` dalo prázdno
# a správně podepsaný APK byl odmítnut. Fixtures jsou skutečné výstupy obou verzí.
set -euo pipefail

cd "$(dirname "$0")/.."

script="./scripts/apk_fingerprint.sh"
expected="80dc86ef10a715961acf4959d11f56c944a91476a399558de17c1389595ec3e0"

fail() { echo "FAIL: $*" >&2; exit 1; }

check() {
  local name="$1" want="$2" got

  got="$(printf '%s\n' "${@:3}" | "$script")"
  [ "$got" = "$want" ] || fail "$name: '$got' != '$want'"
  echo "ok: $name"
}

# build-tools ≤36: "Signer #1 certificate SHA-256 digest: <hex>"
check "build-tools ≤36" "$expected" \
  'Signer #1 certificate DN: CN=Dokulachtan, O=Dokulachtan, C=CZ' \
  'Signer #1 certificate SHA-256 digest: 80DC86EF10A715961ACF4959D11F56C944A91476A399558DE17C1389595EC3E0' \
  'Signer #1 certificate SHA-1 digest: 89A93476180197EBED0C3B6A25CB9A88D7E6E250' \
  'Signer #1 certificate MD5 digest: EDA429B1303C90DE307D93A84A24C0B0'

# build-tools 37: "V2 Signer: certificate SHA-256 digest: <hex>"
check "build-tools 37" "$expected" \
  'V2 Signer: certificate DN: CN=Dokulachtan, O=Dokulachtan, C=CZ' \
  'V2 Signer: certificate SHA-256 digest: 80dc86ef10a715961acf4959d11f56c944a91476a399558de17c1389595ec3e0' \
  'V2 Signer: certificate SHA-1 digest: 89a93476180197ebed0c3b6a25cb9a88d7e6e250'

# SHA-1 (40 znaků) se nesmí splést s SHA-256
check "ignoruje SHA-1" "$expected" \
  'Signer #1 certificate SHA-1 digest: 80dc86ef10a715961acf4959d11f56c944a91476a399558de17c1389595ec3e0' \
  'Signer #1 certificate SHA-256 digest: 80DC86EF10A715961ACF4959D11F56C944A91476A399558DE17C1389595EC3E0'

# žádný otisk → nenulový exit (CI nesmí porovnávat prázdno)
if printf '%s\n' 'Signer #1 certificate DN: CN=X' | "$script" >/dev/null 2>&1; then
  fail "chybějící otisk musí selhat"
fi
echo "ok: chybějící otisk selhá"

echo "OK: apk_fingerprint (2 formáty + chybějící otisk)"

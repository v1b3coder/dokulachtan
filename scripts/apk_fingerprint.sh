#!/usr/bin/env bash
# Vytáhne SHA-256 otisk podpisu z výstupu `apksigner verify --print-certs`.
# Formát se mezi build-tools mění:
#   ≤36: "Signer #1 certificate SHA-256 digest: <hex>"
#   37+: "V2 Signer: certificate SHA-256 digest: <hex>"
# Proto se nehledá sloupec (issue #18.2), ale první 64hex pole; výstup je
# malými písmeny, stejně jako `ANDROID_RELEASE_CERT_SHA256` bez dvojteček.
set -euo pipefail

fingerprint="$(awk '{
  for (i = 1; i <= NF; i++) {
    if ($i ~ /^[0-9a-fA-F]{64}$/) { print tolower($i); exit }
  }
}' | head -1)"

if [ -z "$fingerprint" ]; then
  echo "apksigner nevydal SHA-256 otisk" >&2
  exit 1
fi

printf '%s\n' "$fingerprint"

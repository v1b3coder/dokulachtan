#!/usr/bin/env bash
# Push do obou remote: origin (gitea, s pre-push testy) a github (zrcadlo, bez druhého běhu).
# Použití: scripts/push.sh [<refspec>…]  — např. main, --force-with-lease main, v1.3.10
set -euo pipefail

# Hook běží pro každou push URL zvlášť, takže dva samostatné pushe = dva běhy F1.
git push origin "$@"
git push --no-verify github "$@"

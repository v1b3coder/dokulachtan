#!/usr/bin/env bash
# Připraví lokální klon forku a větev `dokulachtan` (rebasovatelný fork).
#
#   ./scripts/fork-setup.sh
#
# Klon je gitignored (vendor/docuseal/); pin = HEAD forku v vendor/docuseal.rev.
# Remote `origin` = náš fork, `upstream` = docusealco/docuseal (pro rebase).
set -euo pipefail

cd "$(dirname "$0")/.."

REV_FILE=vendor/docuseal.rev
UPSTREAM=https://github.com/docusealco/docuseal.git

# Lokální hodnoty (interní Gitea) mohou být v .env.local; veřejný default je GitHub zrcadlo.
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi
FORK="${FORK:-https://github.com/v1b3coder/docuseal.git}"
BRANCH=dokulachtan
DIR=vendor/docuseal
REV=$(cat "$REV_FILE")

if [ ! -d "$DIR/.git" ]; then
  echo "== klonuji fork =="
  git clone --quiet "$FORK" "$DIR"
  git -C "$DIR" remote add upstream "$UPSTREAM"
fi

git -C "$DIR" fetch --quiet origin
git -C "$DIR" fetch --quiet upstream

if git -C "$DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$DIR" checkout --quiet "$BRANCH"
else
  echo "== vytvářím větev $BRANCH z $REV =="
  git -C "$DIR" checkout --quiet -b "$BRANCH" "$REV"
fi

# CI (a explicitně FORK_SETUP_REV=1) testuje přesně pin, ne head větve.
if [ "${FORK_SETUP_REV:-0}" = 1 ]; then
  git -C "$DIR" checkout --quiet --detach "$REV"
fi

BASE=$(git -C "$DIR" merge-base HEAD upstream/master 2>/dev/null || echo "$REV")

# Repo-lokální hooky (core.hooksPath), ne globální git config.
if [ -x .githooks/pre-push ]; then
  git config core.hooksPath .githooks
fi

echo
echo "fork:    $DIR"
echo "branch:  $(git -C "$DIR" branch --show-current)"
echo "base:    $BASE"
echo "změny:   $(git -C "$DIR" diff --stat "$BASE"..HEAD | tail -1)"

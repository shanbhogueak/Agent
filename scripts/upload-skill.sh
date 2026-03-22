#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <skill-folder> <skill-id-or-new> [version]"
  echo "Example (new skill): $0 ./skills/summarizer new"
  echo "Example (new version): $0 ./skills/summarizer sk_123"
  exit 1
fi

SKILL_FOLDER="$1"
SKILL_TARGET="$2"
VERSION="${3:-latest}"

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is required"
  exit 1
fi

if [[ ! -f "$SKILL_FOLDER/SKILL.md" ]]; then
  echo "Expected $SKILL_FOLDER/SKILL.md"
  exit 1
fi

TMP_ZIP="$(mktemp /tmp/skill.XXXXXX.zip)"
(
  cd "$SKILL_FOLDER"
  zip -qr "$TMP_ZIP" .
)

if [[ "$SKILL_TARGET" == "new" ]]; then
  echo "Creating new hosted skill..."
  curl -sS -X POST "https://api.openai.com/v1/skills" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -F "files=@$TMP_ZIP;type=application/zip"
  echo
else
  echo "Uploading a new version to skill: $SKILL_TARGET"
  curl -sS -X POST "https://api.openai.com/v1/skills/$SKILL_TARGET/versions" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -F "files=@$TMP_ZIP;type=application/zip"
  echo

  if [[ "$VERSION" != "latest" ]]; then
    echo "Setting default version to $VERSION"
    curl -sS -X POST "https://api.openai.com/v1/skills/$SKILL_TARGET" \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"default_version\": $VERSION}"
    echo
  fi
fi

rm -f "$TMP_ZIP"

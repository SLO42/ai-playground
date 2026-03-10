#!/usr/bin/env bash
# Pre-commit hook: reject files with unresolved merge/stash conflict markers.
# Install: cp scripts/pre-commit-checks.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Or:      git config core.hooksPath scripts/git-hooks

set -euo pipefail

# Only check staged files (not the whole tree)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

CONFLICT_PATTERN='^(<{7}|>{7}|={7}|\|{7})'
FOUND=0

for file in $STAGED_FILES; do
  # Skip binary files
  if file --brief "$file" 2>/dev/null | grep -q "binary"; then
    continue
  fi

  if git diff --cached -- "$file" | grep -qE "$CONFLICT_PATTERN"; then
    if [ "$FOUND" -eq 0 ]; then
      echo "ERROR: Unresolved conflict markers found in staged files:"
      echo ""
    fi
    # Show the exact lines
    git diff --cached -- "$file" | grep -nE "$CONFLICT_PATTERN" | while read -r line; do
      echo "  $file: $line"
    done
    FOUND=1
  fi
done

if [ "$FOUND" -ne 0 ]; then
  echo ""
  echo "Please resolve all merge/stash conflicts before committing."
  echo "To bypass this check (not recommended): git commit --no-verify"
  exit 1
fi

exit 0

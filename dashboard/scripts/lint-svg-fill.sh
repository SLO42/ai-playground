#!/usr/bin/env bash
# Lint rule: Flag hardcoded SVG fill attributes that override CSS variables.
# Safe values: none, currentColor, transparent, inherit, url(...)
# Unsafe values: hex colors (#xxx), named colors, rgb/hsl, etc.
#
# This prevents regressions where an SVG fill attribute overrides
# CSS custom properties (e.g., high-contrast mode themes).
#
# Pre-existing violations are tracked in the KNOWN_VIOLATIONS allowlist.
# New violations will cause this script to fail (exit 1).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../src"

# Pre-existing violations (to be cleaned up separately).
# Format: "filename:line_number" — remove entries as they are fixed.
KNOWN_VIOLATIONS=(
	"BubbleGraph.svelte:218"
	"BubbleGraph.svelte:229"
	"BubbleGraph.svelte:244"
	"BubbleGraph.svelte:248"
)

# Match fill="..." but exclude safe values
# Safe: fill="none", fill="currentColor", fill="transparent", fill="inherit", fill="url(...)"
UNSAFE_PATTERN='fill="(?!none|currentColor|transparent|inherit|url\()[^"]*"'

ALL_VIOLATIONS=$(grep -rPn "$UNSAFE_PATTERN" "$SRC_DIR" --include="*.svelte" --include="*.svg" || true)

if [ -z "$ALL_VIOLATIONS" ]; then
	echo "SVG fill lint: OK (no hardcoded fill attributes found)"
	exit 0
fi

# Filter out known/allowlisted violations
NEW_VIOLATIONS=""
while IFS= read -r line; do
	is_known=false
	for known in "${KNOWN_VIOLATIONS[@]}"; do
		if echo "$line" | grep -qF "$known"; then
			is_known=true
			break
		fi
	done
	if [ "$is_known" = false ]; then
		NEW_VIOLATIONS="${NEW_VIOLATIONS}${line}"$'\n'
	fi
done <<< "$ALL_VIOLATIONS"

# Trim trailing newline
NEW_VIOLATIONS=$(echo "$NEW_VIOLATIONS" | sed '/^$/d')

if [ -n "$NEW_VIOLATIONS" ]; then
	echo "ERROR: Found NEW hardcoded SVG fill attributes that may override CSS variables."
	echo ""
	echo "Use CSS classes or Tailwind utilities (e.g., fill-current, class:fill-*) instead"
	echo "of hardcoded fill attributes. Safe values: none, currentColor, transparent, inherit, url(...)."
	echo ""
	echo "New violations:"
	echo "$NEW_VIOLATIONS"
	echo ""
	echo "To fix: replace fill=\"#color\" with a CSS class, or use fill=\"currentColor\""
	echo "with a text-* color utility on the SVG element."
	exit 1
fi

KNOWN_COUNT=$(echo "$ALL_VIOLATIONS" | wc -l)
echo "SVG fill lint: OK (no new violations; $KNOWN_COUNT known violations allowlisted)"

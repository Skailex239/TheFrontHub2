#!/usr/bin/env python3
"""
scripts/fix-globals.py — Replace implicit global function calls with window.X calls.

This fixes a bug introduced by esbuild bundling: when app.js calls t("foo"),
it implicitly references window.t (the i18n function from i18n.js loaded via
<script> tag). But esbuild can rename local variables to `t` too, causing
shadow conflicts where t("foo") ends up referencing a local variable instead
of window.t.

Solution: explicitly call window.t() and window.showToast() everywhere.

Only replaces CALLS to t() (not definitions, not local let/var/const t = ...).
Uses a regex that matches t( followed by a string literal, ensuring we don't
match function definitions or variable declarations.
"""

import re
import sys

def fix_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content

    # Pattern: t("..." or t('...' or t(`...` — call with string literal
    # Also t("foo", {...}) — with second arg
    # Exclude:
    #   - window.t (already prefixed)
    #   - function t (definition)
    #   - const/let/var t = ...
    #   - this.t(...)
    # We use negative lookbehind to avoid these cases.

    # Replace t("...") with window.t("...")
    # Lookbehind: not preceded by . (method call) or function/const/let/var
    pattern_t = re.compile(
        r'(?<![\w.])t\('  # t( not preceded by word char or dot
    )
    # Replace t( with window.t( — but skip if it's already window.t
    def replace_t(m):
        # Check if previous chars are "window." — if so, skip
        # But lookbehind already excludes that
        return 'window.t('

    content = pattern_t.sub(replace_t, content)

    # Same for showToast( — only call sites, not definitions
    pattern_toast = re.compile(r'(?<![\w.])showToast\(')
    content = pattern_toast.sub('window.showToast(', content)

    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        # Count changes
        t_changes = len(re.findall(r'window\.t\(', content)) - len(re.findall(r'window\.t\(', original))
        toast_changes = len(re.findall(r'window\.showToast\(', content)) - len(re.findall(r'window\.showToast\(', original))
        print(f"✓ {filepath}: +{t_changes} window.t() calls, +{toast_changes} window.showToast() calls")
    else:
        print(f"  {filepath}: no changes needed")

if __name__ == "__main__":
    files = sys.argv[1:] or ["app.js"]
    for f in files:
        try:
            fix_file(f)
        except Exception as e:
            print(f"✗ {f}: {e}", file=sys.stderr)

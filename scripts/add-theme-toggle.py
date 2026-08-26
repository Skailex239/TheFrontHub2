#!/usr/bin/env python3
"""
scripts/add-theme-toggle.py — Add theme toggle button to all HTML sidebars.

Inserts a <button class="theme-toggle"> after </nav> in every HTML page that
has a sidebar. The button calls window.toggleTheme() which is defined in
icons.js (loaded as a module on every page).
"""
import re
import sys
from pathlib import Path

THEME_TOGGLE_HTML = """    <!-- Theme toggle (light/dark/auto) -->
    <button class="theme-toggle" onclick="toggleTheme()" title="Changer de thème" aria-label="Basculer thème clair/sombre">
      <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"/>
        <line x1="12" y1="1" x2="12" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/>
        <line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
      <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    </button>

"""

# Pages with sidebar
PAGES = ["index.html", "profile.html", "dashboard.html", "lobby.html", "atlas.html", "tournois.html"]
# runs.html has a different structure (no sidebar), skip it

def add_toggle_to_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Check if already added
    if 'class="theme-toggle"' in content:
        print(f"  {filepath.name}: déjà présent, skip")
        return False

    # Find </nav> followed by sidebar-profile (or auth-zone)
    # Pattern: </nav>\n\n    <!-- Profile / Auth -->  OR  </nav>\n\n        <!-- Profile / Auth -->
    patterns = [
        r'(</nav>\s*\n)(\s*<!-- Profile / Auth)',
        r'(</nav>\s*\n)(\s*<!--\s*Profile / Auth)',
        r'(</nav>\s*\n)(\s*<div class="sidebar-profile">)',
    ]
    for pattern in patterns:
        m = re.search(pattern, content)
        if m:
            new_content = content[:m.end(1)] + "\n" + THEME_TOGGLE_HTML + m.group(2) + content[m.end(2):]
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"✓ {filepath.name}: theme toggle ajouté")
            return True

    print(f"✗ {filepath.name}: pattern non trouvé")
    return False

if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    count = 0
    for page in PAGES:
        p = root / page
        if p.exists():
            if add_toggle_to_file(p):
                count += 1
    print(f"\n{count}/{len(PAGES)} pages mises à jour")

#!/usr/bin/env python3
"""Génère des vignettes légères des cartes OpenFront pour l'onglet Atlas."""
from PIL import Image
from pathlib import Path
import os

SRC = Path("/home/z/openfront-src/map-generator/assets/maps")
DST = Path("/home/z/my-project/public/maps")
DST.mkdir(parents=True, exist_ok=True)

MAX_W = 320
total = 0
for d in sorted(SRC.iterdir()):
    img_path = d / "image.png"
    if not img_path.exists():
        continue
    out_path = DST / f"{d.name}.webp"
    if out_path.exists():
        continue
    try:
        img = Image.open(img_path).convert("RGB")
        w, h = img.size
        if w > MAX_W:
            nh = int(h * MAX_W / w)
            img = img.resize((MAX_W, nh), Image.LANCZOS)
        img.save(out_path, "WEBP", quality=72, method=4)
        total += out_path.stat().st_size
    except Exception as e:
        print("ERREUR", d.name, e)

size_mb = sum(f.stat().st_size for f in DST.glob("*.webp")) / 1e6
count = len(list(DST.glob("*.webp")))
print(f"{count} vignettes, {size_mb:.1f} Mo au total (moyenne {total/max(count,1)/1024:.0f} Ko)")

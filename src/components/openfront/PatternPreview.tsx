"use client";

import { useMemo } from "react";

// Rendu d'un motif de territoire OpenFront (le champ « pattern » des
// cosmétiques) : octet 0 = version, octets 1-2 = échelle + dimensions,
// puis 1 bit par case (0 = couleur primaire, 1 = couleur secondaire).
// Le rendu utilise un canvas 128x128 redimensionné en CSS.
export function PatternPreview({
  pattern,
  primaryColor,
  secondaryColor,
  className,
}: {
  pattern: string;
  primaryColor: string;
  secondaryColor: string;
  className?: string;
}) {
  const dataUrl = useMemo(() => {
    try {
      const b64 = pattern.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = new Uint8Array(
        atob(b64)
          .split("")
          .map((c) => c.charCodeAt(0)),
      );
      if (bytes.length < 4 || bytes[0] !== 0) return null;
      const byte1 = bytes[1];
      const byte2 = bytes[2];
      const scale = byte1 & 0x07;
      const width = (((byte2 & 0x03) << 5) | ((byte1 >> 3) & 0x1f)) + 2;
      const height = ((byte2 >> 2) & 0x3f) + 2;
      const expectedBits = width * height;
      const dataBytes = bytes.length - 3;
      if (dataBytes * 8 < expectedBits) return null;

      const size = 128;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const cellW = size / width;
      const cellH = size / height;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const byte = bytes[3 + (idx >> 3)];
          const bit = (byte ?? 0) & (1 << (idx & 7));
          ctx.fillStyle = bit === 0 ? primaryColor : secondaryColor;
          ctx.fillRect(
            Math.floor(x * cellW),
            Math.floor(y * cellH),
            Math.ceil(cellW),
            Math.ceil(cellH),
          );
        }
      }
      void scale;
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }, [pattern, primaryColor, secondaryColor]);

  if (!dataUrl) {
    return (
      <div
        className={`flex items-center justify-center bg-zinc-900 text-[10px] text-zinc-500 ${className ?? ""}`}
      >
        motif
      </div>
    );
  }
  return (
    <img
      src={dataUrl}
      alt="Aperçu du motif"
      className={className ?? ""}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

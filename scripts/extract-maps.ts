// Extrait la liste complète des cartes depuis Maps.gen.ts (dépôt officiel)
// et génère un JSON propre + vérifie les images disponibles.
import * as fs from "node:fs";

const mod = (await import("/home/z/openfront-src/src/core/game/Maps.gen.ts")) as {
  maps: Array<Record<string, unknown>>;
  mapCategoryOrder: string[];
};

const out = mod.maps.map((info) => ({
  id: String(info.id),
  type: String(info.type),
  categories: (info.categories ?? []) as string[],
  multiplayerFrequency: Number(info.multiplayerFrequency ?? 0),
  featuredRank:
    info.featuredRank !== undefined ? Number(info.featuredRank) : undefined,
  defaultNationCount: Number(info.defaultNationCount ?? 0),
}));

fs.writeFileSync(
  "/home/z/my-project/src/lib/openfront/maps.json",
  JSON.stringify({ categoryOrder: mod.mapCategoryOrder, maps: out }),
);
console.log("cartes:", out.length);
console.log("catégories:", mod.mapCategoryOrder.join(", "));

// Vérifie les images présentes
const dir = "/home/z/openfront-src/map-generator/assets/maps";
const have = fs
  .readdirSync(dir)
  .filter((d) => fs.existsSync(`${dir}/${d}/image.png`));
console.log("images disponibles:", have.length);
const missing = out.filter((m) => !have.includes(m.id.toLowerCase()));
if (missing.length > 0) {
  console.log("sans image:", missing.map((m) => m.id).join(", "));
}

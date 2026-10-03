"use client";

// Le catalogue des cosmétiques arrive en PROP : il est préchargé au niveau
// de la page et fait partie du premier rendu atomique (plus de requête
// propre à cet onglet, plus de « recharge » quand on clique sur Skins).
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PatternPreview } from "./PatternPreview";
import type { CosmeticsCompact } from "@/lib/openfront/types";
import { RARITY_LABELS, RARITY_STYLES, relativeTime } from "@/lib/openfront/format";

const DEFAULT_PALETTE = { primary: "#10b981", secondary: "#059669" };
const FALLBACK_PALETTES: Array<{ primary: string; secondary: string }> = [
  { primary: "#10b981", secondary: "#064e3b" },
  { primary: "#0d9488", secondary: "#134e4a" },
  { primary: "#f59e0b", secondary: "#78350f" },
  { primary: "#64748b", secondary: "#1e293b" },
];

type Category = "patterns" | "flags" | "crowns" | "skins" | "effects" | "palettes";

const CATEGORY_LABELS: Record<Category, string> = {
  patterns: "Motifs",
  flags: "Drapeaux",
  crowns: "Couronnes",
  skins: "Skins",
  effects: "Effets",
  palettes: "Palettes",
};

export function SkinsTab({
  data,
  fetchedAt,
}: {
  data: CosmeticsCompact | null;
  fetchedAt?: number;
}) {
  const [category, setCategory] = useState<Category>("patterns");
  const [query, setQuery] = useState("");
  const [rarity, setRarity] = useState<string>("all");

  const palettesByName = useMemo(() => {
    const map = new Map<string, { primaryColor: string; secondaryColor: string }>();
    for (const p of data?.palettes ?? []) {
      map.set(p.name, { primaryColor: p.primaryColor, secondaryColor: p.secondaryColor });
    }
    return map;
  }, [data]);

  const items = useMemo(() => {
    const c = data;
    if (!c) return [];
    const q = query.trim().toLowerCase();
    let list: Array<{
      key: string;
      name: string;
      rarity: string;
      artist?: string;
      priceHard?: number;
      url?: string;
      pattern?: string;
      palettes?: string[];
      category: string;
    }>;
    if (category === "palettes") {
      list = c.palettes.map((p) => ({
        key: `palette:${p.name}`,
        name: p.name,
        rarity: "common",
        category: "palette",
      }));
    } else {
      list = (c[category] ?? []).map((item) => ({
        key: `${category}:${item.name}`,
        name: item.name,
        rarity: item.rarity,
        artist: item.artist,
        priceHard: item.priceHard,
        url: item.url,
        pattern: item.pattern,
        palettes: item.palettes,
        category: item.category,
      }));
    }
    if (rarity !== "all") list = list.filter((i) => i.rarity === rarity);
    if (q) {
      list = list.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.artist ?? "").toLowerCase().includes(q),
      );
    }
    // Ordre alphabétique stable : pas de réordonnancement au rafraîchissement.
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [data, category, query, rarity]);

  const rarities = useMemo(() => {
    const set = new Set<string>();
    if (category === "palettes") return ["common"];
    for (const item of data?.[category] ?? []) set.add(item.rarity);
    return [...set];
  }, [data, category]);

  if (!data) {
    return (
      <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-6 text-center text-amber-300">
        Catalogue des cosmétiques momentanément indisponible — utilise le
        bouton « Rafraîchir » en haut de page.
      </div>
    );
  }

  const paletteFor = (item: { palettes?: string[] }, i: number) => {
    const name = item.palettes?.[i];
    if (!name) return i === 0 ? DEFAULT_PALETTE : FALLBACK_PALETTES[i % 4];
    const p = palettesByName.get(name);
    if (p) return { primary: p.primaryColor, secondary: p.secondaryColor };
    return DEFAULT_PALETTE;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">
            Catalogue des cosmétiques
          </h3>
          <p className="text-sm text-zinc-500">
            Miroir du catalogue officiel —{" "}
            {fetchedAt ? `actualisé ${relativeTime(fetchedAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {category !== "palettes" && rarities.length > 1 && (
            <Select value={rarity} onValueChange={setRarity}>
              <SelectTrigger className="w-36 bg-zinc-900 border-zinc-800 text-zinc-200">
                <SelectValue placeholder="Rareté" />
              </SelectTrigger>
              <SelectContent className="bg-zinc-900 border-zinc-800">
                <SelectItem value="all">Toutes raretés</SelectItem>
                {rarities.map((r) => (
                  <SelectItem key={r} value={r}>
                    {RARITY_LABELS[r] ?? r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nom ou artiste…"
            className="w-44 bg-zinc-900 border-zinc-800"
          />
        </div>
      </div>

      <Tabs value={category} onValueChange={(v) => setCategory(v as Category)}>
        <TabsList className="flex-wrap h-auto bg-zinc-900 border border-zinc-800">
          {(Object.keys(CATEGORY_LABELS) as Category[]).map((cat) => {
            const count =
              cat === "palettes"
                ? data?.palettes.length ?? 0
                : data?.[cat].length ?? 0;
            return (
              <TabsTrigger
                key={cat}
                value={cat}
                className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300"
              >
                {CATEGORY_LABELS[cat]} ({count})
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {category === "palettes" ? (
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {(data?.palettes ?? [])
            .filter((p) =>
              query.trim()
                ? p.name.toLowerCase().includes(query.trim().toLowerCase())
                : true,
            )
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 240)
            .map((p) => (
              <div
                key={p.name}
                className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60"
              >
                <div className="flex h-12">
                  <div className="flex-1" style={{ background: p.primaryColor }} />
                  <div className="flex-1" style={{ background: p.secondaryColor }} />
                </div>
                <p className="truncate px-2 py-1.5 text-xs text-zinc-300" title={p.name}>
                  {p.name}
                </p>
              </div>
            ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.slice(0, 120).map((item) => (
            <Card
              key={item.key}
              className="border-zinc-800 bg-zinc-900/60 overflow-hidden"
            >
              <div className="flex h-28 items-center justify-center bg-zinc-950">
                {item.pattern ? (
                  <div className="grid grid-cols-2 gap-1">
                    {[0, 1].map((i) => {
                      const pal = paletteFor(item, i);
                      return (
                        <PatternPreview
                          key={i}
                          pattern={item.pattern!}
                          primaryColor={pal.primary}
                          secondaryColor={pal.secondary}
                          className="h-14 w-14 rounded-md"
                        />
                      );
                    })}
                  </div>
                ) : item.url ? (
                  <img
                    src={`${item.url}?width=96`}
                    alt={item.name}
                    className="h-20 object-contain"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-800 text-xs text-zinc-500">
                    {item.category.replace("effect:", "effet · ")}
                  </div>
                )}
              </div>
              <CardContent className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium text-zinc-100" title={item.name}>
                    {item.name}
                  </p>
                  <Badge
                    variant="outline"
                    className={`shrink-0 ${RARITY_STYLES[item.rarity] ?? RARITY_STYLES.common}`}
                  >
                    {RARITY_LABELS[item.rarity] ?? item.rarity}
                  </Badge>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
                  <span className="truncate">
                    {item.artist && item.artist !== "DO NOT USE"
                      ? `par ${item.artist}`
                      : "—"}
                  </span>
                  {item.priceHard !== undefined && (
                    <span className="shrink-0 text-amber-400">
                      {item.priceHard} ⬤
                    </span>
                  )}
                </div>
                {item.palettes && item.palettes.length > 0 && category === "patterns" && (
                  <p className="mt-1 truncate text-[11px] text-zinc-600">
                    Palettes : {item.palettes.slice(0, 3).join(", ")}
                    {item.palettes.length > 3 ? "…" : ""}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
          {items.length === 0 && (
            <p className="col-span-full rounded-lg border border-dashed border-zinc-800 p-6 text-center text-zinc-500">
              Aucun cosmétique pour ces filtres.
            </p>
          )}
        </div>
      )}
      {items.length > 120 && category !== "palettes" && (
        <p className="text-xs text-zinc-600">
          {items.length} éléments correspondent — 120 affichés, affinez la
          recherche pour explorer le reste.
        </p>
      )}
    </div>
  );
}

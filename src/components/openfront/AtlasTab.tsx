"use client";

// Atlas : catalogue COMPLET des cartes OpenFront (132, généré depuis le dépôt
// officiel). Import statique → fait partie du premier rendu atomique, aucune
// requête réseau, aucune apparition différée.
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import atlas from "@/lib/openfront/maps.json";
import type { MapsCatalog } from "@/lib/openfront/types";
import { MAP_CATEGORY_LABELS, formatNumber } from "@/lib/openfront/format";

const CATALOG = atlas as unknown as MapsCatalog;

function MapThumb({ slug, name }: { slug: string; name: string }) {
  return (
    <img
      src={`/maps/${slug}.webp`}
      alt={`Carte ${name}`}
      loading="lazy"
      className="h-28 w-full object-contain"
    />
  );
}

export function AtlasTab() {
  const [category, setCategory] = useState<string>("featured");
  const [query, setQuery] = useState("");

  const availableCategories = useMemo(() => {
    const present = new Set(CATALOG.maps.flatMap((m) => m.categories));
    return CATALOG.categoryOrder.filter((c) => present.has(c));
  }, []);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of CATALOG.maps) {
      for (const c of m.categories) map.set(c, (map.get(c) ?? 0) + 1);
    }
    return map;
  }, []);

  const cards = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = CATALOG.maps;
    if (q) {
      list = list.filter((m) => m.type.toLowerCase().includes(q));
    } else {
      list = list.filter((m) => m.categories.includes(category));
    }
    const rank = (m: (typeof CATALOG.maps)[number]) =>
      m.categories.includes("featured")
        ? (m.featuredRank ?? 9999)
        : 9999;
    return [...list].sort(
      (a, b) => rank(a) - rank(b) || a.type.localeCompare(b.type),
    );
  }, [category, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">
            Atlas des cartes
          </h3>
          <p className="text-sm text-zinc-500">
            {formatNumber(CATALOG.maps.length)} cartes — miroir complet du
            catalogue officiel OpenFront, vignettes incluses.
          </p>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher une carte…"
          className="sm:max-w-xs bg-zinc-900 border-zinc-800"
        />
      </div>

      <Tabs value={query.trim() ? "__search" : category} onValueChange={(v) => {
        if (v !== "__search") setCategory(v);
      }}>
        <TabsList className="h-auto flex-wrap bg-zinc-900 border border-zinc-800">
          {availableCategories.map((c) => (
            <TabsTrigger
              key={c}
              value={c}
              className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300"
            >
              {MAP_CATEGORY_LABELS[c] ?? c}
              <Badge
                variant="outline"
                className="ml-1 border-zinc-700 text-zinc-500"
              >
                {counts.get(c) ?? 0}
              </Badge>
            </TabsTrigger>
          ))}
          {query.trim() && (
            <TabsTrigger value="__search" className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300">
              Recherche « {query.trim()} »
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cards.map((m) => (
          <div
            key={m.id}
            className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60 transition-colors hover:border-emerald-500/40"
          >
            <div className="flex h-32 items-center justify-center border-b border-zinc-800 bg-zinc-950">
              <MapThumb slug={m.id.toLowerCase()} name={m.type} />
            </div>
            <div className="p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-zinc-100" title={m.type}>
                  {m.type}
                </p>
                {m.categories.includes("new") && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-teal-500/40 text-teal-300"
                  >
                    nouvelle
                  </Badge>
                )}
                {m.categories.includes("featured") && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-amber-500/40 text-amber-400"
                  >
                    {m.featuredRank ? `★ ${m.featuredRank}` : "★"}
                  </Badge>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
                <span className="truncate">
                  {m.categories
                    .map((c) => MAP_CATEGORY_LABELS[c] ?? c)
                    .slice(0, 2)
                    .join(" · ")}
                </span>
                <span
                  className="shrink-0 text-zinc-400"
                  title={`${m.defaultNationCount} nations par défaut · rotation multi ${m.multiplayerFrequency}`}
                >
                  {m.defaultNationCount} nations
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {cards.length === 0 && (
        <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-zinc-500">
          Aucune carte ne correspond à cette recherche.
        </p>
      )}
    </div>
  );
}

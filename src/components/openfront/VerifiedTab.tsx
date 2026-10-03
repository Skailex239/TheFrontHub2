"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { VerifiedBadge } from "./VerifiedBadge";
import type { LeaderboardEntry, RegistryPlayer } from "@/lib/openfront/types";
import { baseName, formatNumber } from "@/lib/openfront/format";

export function VerifiedTab({
  verified,
  registry,
  onSelectPlayer,
}: {
  verified: LeaderboardEntry[];
  registry: RegistryPlayer[];
  onSelectPlayer: (publicId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const renamedBy = useMemo(() => {
    const map = new Map<string, { renamed: boolean; prev: string[] }>();
    for (const p of registry) {
      map.set(p.publicId, { renamed: !!p.renamedRecently, prev: p.prevUsernames });
    }
    return map;
  }, [registry]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Tri stable par elo décroissant : pas de « saute » entre rafraîchissements.
    const sorted = [...verified].sort((a, b) => b.elo - a.elo || a.username.localeCompare(b.username));
    if (!q) return sorted;
    return sorted.filter((e) => e.username.toLowerCase().includes(q));
  }, [verified, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">
            Joueurs vérifiés
          </h3>
          <p className="text-sm text-zinc-500">
            Pseudos sans point = nom « nu » réservé aux comptes vérifiés
            (premium ou administrateur). {verified.length} joueurs vérifiés
            dans les classements 1v1 et 2v2.
          </p>
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrer par pseudo…"
          className="sm:max-w-xs bg-zinc-900 border-zinc-800"
        />
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="w-12 text-zinc-500">#</TableHead>
              <TableHead className="text-zinc-500">Joueur</TableHead>
              <TableHead className="text-right text-zinc-500">Elo (max)</TableHead>
              <TableHead className="hidden text-right text-zinc-500 md:table-cell">V / D</TableHead>
              <TableHead className="hidden text-right text-zinc-500 lg:table-cell">Parties</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => (
              <TableRow
                key={entry.public_id}
                className="cursor-pointer hover:bg-zinc-900"
                onClick={() => onSelectPlayer(entry.public_id)}
              >
                <TableCell className="text-zinc-500">
                  {rows.indexOf(entry) + 1}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <VerifiedBadge />
                    <span className="truncate font-medium text-zinc-100">
                      {baseName(entry.username)}
                    </span>
                    {renamedBy.get(entry.public_id)?.renamed && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-amber-500/40 text-amber-400"
                        title={`Anciens pseudos : ${(renamedBy.get(entry.public_id)?.prev ?? []).join(", ")}`}
                      >
                        renommé
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono font-semibold text-emerald-400">
                  {formatNumber(entry.elo)}
                  <span className="ml-1 text-xs text-zinc-600">
                    ({formatNumber(entry.peakElo)})
                  </span>
                </TableCell>
                <TableCell className="hidden text-right text-zinc-400 md:table-cell">
                  <span className="text-emerald-500">{formatNumber(entry.wins)}</span>
                  <span className="text-zinc-600"> / </span>
                  <span className="text-red-400">{formatNumber(entry.losses)}</span>
                </TableCell>
                <TableCell className="hidden text-right text-zinc-400 lg:table-cell">
                  <Badge variant="outline" className="border-zinc-700 text-zinc-300">
                    {formatNumber(entry.total)}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows.length === 0 && (
          <p className="p-6 text-center text-zinc-500">Aucun joueur trouvé.</p>
        )}
      </div>
    </div>
  );
}

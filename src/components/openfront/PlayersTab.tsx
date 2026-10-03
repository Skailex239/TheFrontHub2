"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { VerifiedBadge } from "./VerifiedBadge";
import type { RegistryPlayer } from "@/lib/openfront/types";
import { baseName, isVerifiedUsername, relativeTime } from "@/lib/openfront/format";

interface SearchResults {
  results: RegistryPlayer[];
}

export function PlayersTab({
  registry,
  onSelectPlayer,
}: {
  registry: RegistryPlayer[];
  onSelectPlayer: (publicId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const queryClient = useQueryClient();

  const search = useQuery<SearchResults>({
    queryKey: ["player-search", query],
    queryFn: async () => {
      const res = await fetch(
        `/api/openfront/search?q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) throw new Error("recherche indisponible");
      return (await res.json()) as SearchResults;
    },
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });

  const track = useMutation({
    mutationFn: async (vars: { publicId: string; tracked: boolean }) => {
      const res = await fetch("/api/openfront/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error("suivi indisponible");
      return (await res.json()) as { ok: boolean };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["player-search"] });
    },
  });

  const tracked = registry.filter((p) => p.tracked);
  const candidates =
    query.trim().length >= 2 ? (search.data?.results ?? []) : [];
  const candidateIds = new Set(candidates.map((c) => c.publicId));

  const renderPlayerCard = (player: RegistryPlayer) => (
    <Card key={player.publicId} className="border-zinc-800 bg-zinc-900/60">
      <CardContent className="p-4 flex items-center justify-between gap-3">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onSelectPlayer(player.publicId)}
        >
          {isVerifiedUsername(player.username) && <VerifiedBadge />}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium text-zinc-100">
                {player.username === player.publicId
                  ? player.publicId
                  : baseName(player.username)}
              </p>
              {player.renamedRecently && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-500/40 text-amber-400"
                  title={`Anciens pseudos : ${player.prevUsernames.join(", ")}`}
                >
                  renommé
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-zinc-500">
              {player.elo !== null ? `Elo ${player.elo} · ` : ""}
              vu {relativeTime(Date.parse(player.lastSeenAt))}
              {player.prevUsernames.length > 0 && (
                <span
                  className="text-zinc-600"
                  title={`Historique : ${player.prevUsernames.join(" → ")}`}
                >
                  {" "}
                  · anciens pseudos : {player.prevUsernames.join(", ")}
                </span>
              )}
            </p>
          </div>
        </button>
        <Button
          variant={player.tracked ? "default" : "outline"}
          size="sm"
          className={
            player.tracked
              ? "h-8 bg-emerald-600 hover:bg-emerald-500 text-white"
              : "h-8 border-zinc-700 text-zinc-300 hover:border-emerald-500/50 hover:text-emerald-300"
          }
          disabled={track.isPending}
          onClick={() =>
            track.mutate({
              publicId: player.publicId,
              tracked: !player.tracked,
            })
          }
        >
          {player.tracked ? "Suivi" : "Suivre"}
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-300">
          Rechercher un joueur
        </h3>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Pseudo ou identifiant public (ex. Nvr_Kn ou hWNuSrnS)…"
          className="bg-zinc-900 border-zinc-800"
        />
        <div className="mt-3 flex flex-col gap-2">
          {query.trim().length >= 2 && search.isFetching && (
            <Skeleton className="h-16 w-full bg-zinc-900" />
          )}
          {candidates
            .filter((c) => !candidateIds.has("") )
            .map(renderPlayerCard)}
          {query.trim().length >= 2 &&
            !search.isFetching &&
            candidates.length === 0 && (
              <p className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">
                Aucun joueur connu pour « {query} ». Les pseudos apparaissent
                dans le registre dès qu&apos;ils sont croisés dans les
                classements.
              </p>
            )}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">
            Joueurs suivis
          </h3>
          <Badge variant="outline" className="border-zinc-700 text-zinc-400">
            {tracked.length}
          </Badge>
        </div>
        {tracked.length > 0 ? (
          <div className="flex flex-col gap-2">{tracked.map(renderPlayerCard)}</div>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
            Aucun joueur suivi pour l&apos;instant. Suivez un joueur depuis la
            recherche ci-dessus ou le classement : son pseudo sera surveillé
            et tout renommage sera signalé (au lieu de changer en silence).
          </p>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">
            Registre ({registry.length} joueurs croisés)
          </h3>
        </div>
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {registry
            .filter((p) => !p.tracked)
            .slice(0, 100)
            .map(renderPlayerCard)}
        </div>
      </section>
    </div>
  );
}

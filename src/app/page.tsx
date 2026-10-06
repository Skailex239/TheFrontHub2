"use client";

// ============================================================================
// OpenFront Tracker — page unique.
//
// Principes (correction des bugs signalés) :
//  1. CHARGEMENT ATOMIQUE : toutes les données (tableau de bord, lobbies,
//     cosmétiques) sont demandées EN PARALLÈLE au montage et le rendu est
//     bloqué derrière un squelette unique tant que tout n'est pas arrivé.
//     Plus jamais de sections qui apparaissent les unes après les autres
//     (joueurs → skins → badges).
//  2. AUCUN RECHARGEMENT D'ONGLET : tous les contenus d'onglets restent
//     montés (forceMount + masqués par CSS). Cliquer sur un onglet ne
//     déclenche AUCUNE requête, aucun squelette, aucun clignotement.
//  3. SOURCE LOBBIES CONFIGURABLE : par défaut le service local ; si une URL
//     de worker Cloudflare est renseignée (bouton ⚙), le navigateur interroge
//     directement ton worker — les lobbies marchent même si le service local
//     est au repos.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AtlasTab } from "@/components/openfront/AtlasTab";
import { LobbyTab } from "@/components/openfront/LobbyTab";
import { LeaderboardTab } from "@/components/openfront/LeaderboardTab";
import { PlayersTab } from "@/components/openfront/PlayersTab";
import { VerifiedTab } from "@/components/openfront/VerifiedTab";
import { SpeedrunTab } from "@/components/openfront/SpeedrunTab";
import { SkinsTab } from "@/components/openfront/SkinsTab";
import { PlayerModal } from "@/components/openfront/PlayerModal";
import type { CosmeticsCompact, DashboardPayload, LobbySnapshot } from "@/lib/openfront/types";
import { parisTime, relativeTime } from "@/lib/openfront/format";

const WORKER_URL_KEY = "openfront:worker-url";

function readStoredWorkerUrl(): string {
  try {
    return (localStorage.getItem(WORKER_URL_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              ok ? "bg-emerald-400" : "bg-red-500"
            }`}
          />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="bg-zinc-900 border-zinc-800 text-zinc-200">
        {ok ? "Source joignable" : "Source momentanément indisponible"}
      </TooltipContent>
    </Tooltip>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 bg-zinc-900" />
        ))}
      </div>
      <Skeleton className="h-8 w-64 bg-zinc-900" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-36 bg-zinc-900" />
        ))}
      </div>
      <p className="text-center text-sm text-zinc-500">
        Chargement atomique : joueurs, skins, badges et lobbies arriveront
        ensemble, en une seule passe — aucune section ne se remplace.
      </p>
    </div>
  );
}

export default function Home() {
  // 0 jusqu'au montage client : SSR et hydratation produisent EXACTEMENT le
  // même texte (aucune erreur d'hydratation, aucun arbre régénéré au
  // chargement). L'horloge n'est affichée qu'une fois monté.
  const [now, setNow] = useState(0);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [tab, setTab] = useState("lobby");
  // null = pas encore lu (montage client) ; "" = source locale.
  const [workerUrl, setWorkerUrl] = useState<string | null>(null);
  const [workerDraft, setWorkerDraft] = useState("");

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const stored = readStoredWorkerUrl();
    setWorkerUrl(stored);
    setWorkerDraft(stored);
  }, []);

  // --- 1. Tableau de bord : une requête, tout le contenu statique -----------
  const dashboard = useQuery<DashboardPayload>({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const res = await fetch("/api/openfront/dashboard");
      if (!res.ok) throw new Error("tableau de bord indisponible");
      return (await res.json()) as DashboardPayload;
    },
    placeholderData: (prev) => prev,
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  // --- 2. Lobbies : service local OU worker Cloudflare (au choix) -----------
  const activeWorkerUrl = workerUrl ?? "";
  const lobby = useQuery<LobbySnapshot>({
    queryKey: ["lobby", activeWorkerUrl],
    queryFn: async () => {
      const url = activeWorkerUrl
        ? `${activeWorkerUrl.replace(/\/+$/, "")}/lobbies`
        : "/api/openfront/lobby";
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error("flux lobbies indisponible");
      return (await res.json()) as LobbySnapshot;
    },
    // On attend la lecture du localStorage pour éviter une double requête.
    enabled: workerUrl !== null,
    placeholderData: (prev) => prev,
    staleTime: 2_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: false,
  });

  // --- 3. Cosmétiques : préchargés ici (plus jamais de retard sur l'onglet) -
  const cosmetics = useQuery<{ data: CosmeticsCompact; fetchedAt: number }>({
    queryKey: ["cosmetics"],
    queryFn: async () => {
      const res = await fetch("/api/openfront/cosmetics");
      if (!res.ok) throw new Error("cosmétiques indisponibles");
      return (await res.json()) as { data: CosmeticsCompact; fetchedAt: number };
    },
    placeholderData: (prev) => prev,
    staleTime: 60 * 60_000,
    refetchInterval: 60 * 60_000,
    refetchOnWindowFocus: false,
  });

  const refreshAll = useCallback(() => {
    void dashboard.refetch();
    void lobby.refetch();
    void cosmetics.refetch();
  }, [dashboard, lobby, cosmetics]);

  const saveWorkerUrl = useCallback(() => {
    const clean = workerDraft.trim().replace(/\/+$/, "");
    setWorkerUrl(clean);
    try {
      if (clean) localStorage.setItem(WORKER_URL_KEY, clean);
      else localStorage.removeItem(WORKER_URL_KEY);
    } catch {
      /* stockage indisponible : on garde juste en mémoire */
    }
  }, [workerDraft]);

  const d = dashboard.data;
  const apiOk = d?.apiOk ?? false;
  const wsOk = lobby.data?.connected ?? false;

  // --- Verrou atomique : on ne peint QUE lorsque TOUT est prêt (ou échoué) --
  const firstLoadPending =
    dashboard.isPending ||
    lobby.isPending ||
    cosmetics.isPending ||
    workerUrl === null;

  const tabsList = useMemo(
    () => [
      { value: "lobby", label: "Lobbies", badge: lobby.data?.games.length },
      { value: "classement", label: "Classement", badge: undefined },
      { value: "joueurs", label: "Joueurs", badge: undefined },
      { value: "verifies", label: "Vérifiés", badge: undefined },
      { value: "speedrun", label: "Speedrun", badge: undefined },
      { value: "skins", label: "Skins", badge: undefined },
      { value: "atlas", label: "Atlas", badge: undefined },
    ],
    [lobby.data?.games.length],
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
        {/* En-tête */}
        <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15 text-lg">
                🌍
              </div>
              <div>
                <h1 className="text-lg font-bold leading-tight">
                  OpenFront Tracker
                </h1>
                <p className="text-xs text-zinc-500">
                  Lobbies temps réel · classements · joueurs · speedrun · skins ·
                  atlas
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <StatusDot ok={apiOk} label="API" />
              <StatusDot ok={wsOk} label="Flux lobbies" />
              <span className="text-xs text-zinc-500">
                Données : {relativeTime(d?.generatedAt ?? 0, now)} · horloge{" "}
                {now > 0 ? parisTime() : "…"}
              </span>

              {/* Source des lobbies : service local ou worker Cloudflare */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`h-8 border-zinc-700 text-zinc-300 hover:border-fuchsia-500/50 hover:text-fuchsia-300 ${
                      activeWorkerUrl ? "border-fuchsia-500/50 text-fuchsia-300" : ""
                    }`}
                    title="Source des lobbies"
                  >
                    ⚙ Lobbies
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-96 border-zinc-800 bg-zinc-900 text-zinc-100">
                  <p className="text-sm font-semibold">Source des lobbies</p>
                  <p className="mt-1 text-xs text-zinc-400">
                    Par défaut : service local. Colle ici l&apos;URL de ton
                    worker Cloudflare (ex.{" "}
                    https://openfront.mondomaine.workers.dev) pour que les
                    lobbies passent directement par lui — panneau plus fiable,
                    valable même quand le service local dort.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Input
                      value={workerDraft}
                      onChange={(e) => setWorkerDraft(e.target.value)}
                      placeholder="https://mon-worker.mondomaine.workers.dev"
                      className="bg-zinc-950 border-zinc-800"
                    />
                    <Button
                      size="sm"
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                      onClick={saveWorkerUrl}
                    >
                      OK
                    </Button>
                  </div>
                  {activeWorkerUrl && (
                    <button
                      className="mt-2 text-xs text-amber-400 hover:text-amber-300"
                      onClick={() => {
                        setWorkerDraft("");
                        setWorkerUrl("");
                        try {
                          localStorage.removeItem(WORKER_URL_KEY);
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      Revenir au service local
                    </button>
                  )}
                </PopoverContent>
              </Popover>

              <Button
                variant="outline"
                size="sm"
                className="h-8 border-zinc-700 text-zinc-200 hover:border-emerald-500/50 hover:text-emerald-300"
                onClick={refreshAll}
                disabled={
                  dashboard.isFetching || lobby.isFetching || cosmetics.isFetching
                }
              >
                {dashboard.isFetching || lobby.isFetching || cosmetics.isFetching
                  ? "Rafraîchissement…"
                  : "Rafraîchir"}
              </Button>
            </div>
          </div>
        </header>

        {/* Corps */}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
          {firstLoadPending ? (
            <DashboardSkeleton />
          ) : dashboard.isError ? (
            <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-8 text-center">
              <p className="text-red-300">
                {(dashboard.error as Error).message}
              </p>
              <Button
                className="mt-4 border border-red-800 bg-red-950/50 text-red-200 hover:bg-red-900/50"
                variant="outline"
                onClick={() => void dashboard.refetch()}
              >
                Réessayer
              </Button>
            </div>
          ) : (
            <Tabs value={tab} onValueChange={setTab} className="gap-6">
              <TabsList className="flex h-auto flex-wrap bg-zinc-900 border border-zinc-800">
                {tabsList.map((t) => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    className="data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300"
                  >
                    {t.label}
                    {t.badge !== undefined && t.badge > 0 && (
                      <Badge
                        variant="outline"
                        className="ml-1.5 border-emerald-500/40 text-emerald-400"
                      >
                        {t.badge}
                      </Badge>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>

              {/* forceMount + masquage CSS : les onglets restent montés,
                  changer d'onglet ne déclenche aucune requête. */}
              <TabsContent
                value="lobby"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <LobbyTab
                  snapshot={
                    lobby.data ?? {
                      connected: false,
                      serverHost: "",
                      serverState: "",
                      numWorkers: 0,
                      version: "",
                      serverTime: Date.now(),
                      lastFullAt: 0,
                      lastFrameAt: 0,
                      lastError: "chargement",
                      reconnects: 0,
                      games: [],
                    }
                  }
                  viaWorker={!!activeWorkerUrl}
                />
              </TabsContent>
              <TabsContent
                value="classement"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <LeaderboardTab
                  leaderboard={d?.leaderboard ?? { "1v1": [], "2v2": [] }}
                  registry={d?.registry ?? []}
                  onSelectPlayer={setSelectedPlayer}
                />
              </TabsContent>
              <TabsContent
                value="joueurs"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <PlayersTab
                  registry={d?.registry ?? []}
                  onSelectPlayer={setSelectedPlayer}
                />
              </TabsContent>
              <TabsContent
                value="verifies"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <VerifiedTab
                  verified={d?.verified ?? []}
                  registry={d?.registry ?? []}
                  onSelectPlayer={setSelectedPlayer}
                />
              </TabsContent>
              <TabsContent
                value="speedrun"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <SpeedrunTab
                  speedrun={d?.speedrun ?? null}
                  onSelectPlayer={setSelectedPlayer}
                />
              </TabsContent>
              <TabsContent
                value="skins"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <SkinsTab
                  data={cosmetics.data?.data ?? null}
                  fetchedAt={cosmetics.data?.fetchedAt}
                />
              </TabsContent>
              <TabsContent
                value="atlas"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <AtlasTab />
              </TabsContent>
            </Tabs>
          )}
        </main>

        {/* Pied de page collé en bas */}
        <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
          <div className="mx-auto max-w-7xl px-4 py-3 text-xs text-zinc-600">
            Données : API publique OpenFront (api.openfront.io) + flux temps
            réel des lobbies (blue/green.openfront.io, décodage zbin) — ou ton
            worker Cloudflare si l&apos;URL est renseignée (⚙). Horodatage Paris
            · rafraîchissement automatique (lobbies 5 s, classements 60 s,
            speedrun 10 min). Atlas : 132 cartes, miroir du catalogue officiel.
          </div>
        </footer>

        <PlayerModal
          publicId={selectedPlayer}
          onClose={() => setSelectedPlayer(null)}
        />
      </div>
    </TooltipProvider>
  );
}

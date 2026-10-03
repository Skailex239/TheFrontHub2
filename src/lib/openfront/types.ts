// Types partagés pour les données OpenFront (côté serveur et client).

export interface LeaderboardEntry {
  rank: number;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  total: number;
  public_id: string;
  accountUsername: string;
  username: string;
}

export interface LeaderboardData {
  "1v1": LeaderboardEntry[];
  "2v2": LeaderboardEntry[];
}

export interface ClusterServer {
  host: string;
  numWorkers: number;
  version: string;
  state: string;
}

export interface ClusterData {
  latest: string;
  servers: Record<string, ClusterServer>;
}

export interface CompactCosmetic {
  name: string;
  rarity: string;
  artist?: string;
  priceHard?: number;
  url?: string;
  pattern?: string;
  palettes?: string[];
  category: string;
}

export interface CosmeticsCompact {
  patterns: CompactCosmetic[];
  flags: CompactCosmetic[];
  crowns: CompactCosmetic[];
  skins: CompactCosmetic[];
  effects: CompactCosmetic[];
  palettes: Array<{ name: string; primaryColor: string; secondaryColor: string }>;
}

export interface GameConfigInfo {
  gameMap?: string;
  gameMode?: string;
  maxPlayers?: number;
  difficulty?: string;
  gameType?: string;
  instantStart?: boolean;
  playerTeams?: number | null;
  nations?: number;
  initialCoins?: number;
}

export interface LobbyInfo {
  gameID: string;
  numClients: number;
  startsAt?: number;
  autoStartAt?: number;
  publicGameType: string;
  custom?: boolean;
  featured?: boolean;
  queued?: boolean;
  label?: { en?: string; fr?: string } & Record<string, unknown>;
  gameConfig?: GameConfigInfo;
}

export interface LobbySnapshot {
  connected: boolean;
  serverHost: string;
  serverState: string;
  numWorkers: number;
  version: string;
  serverTime: number;
  lastFullAt: number;
  lastFrameAt: number;
  lastError?: string;
  reconnects: number;
  games: LobbyInfo[];
  /** Instant de génération de l'instantané (worker Cloudflare). */
  generatedAt?: number;
}

export interface PlayerGame {
  gameId: string;
  start: string;
  durationSeconds: number;
  map: string;
  mode: string;
  type: string;
  playerTeams: number | null;
  rankedType: string;
  result: string;
  totalPlayers: number;
  username: string;
  clanTag: string | null;
}

export interface PlayerProfile {
  publicId: string;
  createdAt: string;
  username: string;
  stats: Record<string, unknown>;
  clans?: Array<{
    tag: string;
    name: string;
    role: string;
    joinedAt: string;
    memberCount: number;
  }>;
}

export interface SpeedrunRecord {
  publicId: string;
  username: string;
  gameId: string;
  map: string;
  mode: string;
  durationSeconds: number;
  start: string;
  totalPlayers: number;
  rankedType: string;
}

export interface RegistryPlayer {
  publicId: string;
  username: string;
  prevUsernames: string[];
  tracked: boolean;
  elo: number | null;
  wins: number | null;
  losses: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  renamedRecently?: boolean;
}

export interface DashboardPayload {
  generatedAt: number;
  apiOk: boolean;
  leaderboard: LeaderboardData;
  leaderboardFetchedAt: number;
  cluster: ClusterData | null;
  clusterFetchedAt: number;
  verified: LeaderboardEntry[];
  registry: RegistryPlayer[];
  speedrun: {
    computedAt: number;
    playerCount: number;
    top: SpeedrunRecord[];
    byMap: Array<{ map: string; record: SpeedrunRecord; count: number }>;
  } | null;
}

// --- Atlas : catalogue complet des cartes (généré depuis le dépôt officiel) ---
export interface AtlasMap {
  /** Identifiant du dossier (UpperCamelCase, sert pour la vignette). */
  id: string;
  /** Nom canonique affiché en jeu (format « wire »). */
  type: string;
  categories: string[];
  multiplayerFrequency: number;
  featuredRank?: number;
  defaultNationCount: number;
}

export interface MapsCatalog {
  categoryOrder: string[];
  maps: AtlasMap[];
}

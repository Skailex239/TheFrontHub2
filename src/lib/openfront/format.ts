// Formatage français — côté client.
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest} s`;
  return `${m} min ${rest.toString().padStart(2, "0")} s`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} s`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function relativeTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  if (!timestamp) return "jamais";
  const diff = Math.max(0, now - timestamp);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

export function parisTime(d: Date = new Date()): string {
  return d.toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("fr-FR").format(n);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

// Un pseudo sans point = joueur vérifié (nom « nu » réservé aux comptes
// premium/indefinite) — même règle que le client officiel OpenFront.
export function isVerifiedUsername(username: string): boolean {
  return !username.includes(".") && !/^TEMPORARY\d{4}$/.test(username);
}

export const RARITY_STYLES: Record<string, string> = {
  common: "bg-zinc-100 text-zinc-800 border-zinc-300",
  uncommon: "bg-emerald-100 text-emerald-800 border-emerald-300",
  rare: "bg-sky-100 text-sky-800 border-sky-300",
  epic: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300",
  legendary: "bg-amber-100 text-amber-900 border-amber-400",
};

export const RARITY_LABELS: Record<string, string> = {
  common: "Commun",
  uncommon: "Peu commun",
  rare: "Rare",
  epic: "Épique",
  legendary: "Légendaire",
};

export const GAME_TYPE_LABELS: Record<string, string> = {
  ffa: "Chacun pour soi",
  team: "Équipes",
  special: "Spécial",
  hosted: "Hébergées",
};

// Libellés français des catégories de cartes (atlas).
export const MAP_CATEGORY_LABELS: Record<string, string> = {
  featured: "Mises en avant",
  new: "Nouveautés",
  world: "Monde",
  continental: "Continentales",
  europe: "Europe",
  asia: "Asie",
  north_america: "Amérique du Nord",
  africa: "Afrique",
  south_america: "Amérique du Sud",
  oceania: "Océanie",
  antarctica: "Antarctique",
  countries: "Pays",
  cosmic: "Cosmiques",
  fictional: "Fictives",
  arcade: "Arcade",
  tournament: "Tournois",
};

export function baseName(username: string): string {
  const idx = username.indexOf(".");
  return idx === -1 ? username : username.slice(0, idx);
}

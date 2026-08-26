/**
 * Appels API OpenFront côté navigateur.
 *
 * Stratégie de résolution (par ordre de priorité) :
 *
 *   1. PROXY LOCAL Next.js  →  /api/openfront/<path>
 *      Fonctionne partout où l'app est servie par Next.js (dev, preview,
 *      Vercel, etc.). Aucun problème CORS car la requête est same-origin
 *      et le serveur Next.js fait le fetch vers OpenFront côté backend.
 *      C'est le chemin le plus rapide et le plus fiable.
 *
 *   2. PROXY CORS externes  →  corsproxy.io, codetabs, allorigins
 *      Utilisé uniquement si le proxy local n'existe pas (ex: hébergement
 *      statique GitHub Pages où /api/openfront/... renvoie une 404 HTML).
 *      On essaie plusieurs proxies en cascade car ils sont souvent
 *      surchargés ou devenus payants.
 *
 *   3. PROXY CUSTOM  →  window.OPENFRONT_API_PROXY ou <meta>
 *      URL de backend personnel (Render/Railway/Vercel) si défini.
 *
 * Note : l'API OpenFront n'autorise CORS que depuis openfront.io, d'où
 * le besoin d'un proxy côté serveur.
 */

import { parseSessionsPayload, normalizeSession } from "./openfront-parse.js";

export { parseSessionsPayload, normalizeSession };

export const API_BASE = "https://api.openfront.io";

/**
 * Configuration du proxy custom (optionnel).
 *   - URL complète (http...) → proxy custom
 *   - "false" / null         → désactivé
 */
const CORS_PROXY_META = typeof document !== "undefined"
  ? document.querySelector('meta[name="openfront-api-proxy"]')?.content
  : null;

const CORS_PROXY_GLOBAL = typeof window !== "undefined"
  ? window.OPENFRONT_API_PROXY
  : null;

const CUSTOM_PROXY = (CORS_PROXY_META || CORS_PROXY_GLOBAL || "").trim();
const CUSTOM_PROXY_ENABLED = CUSTOM_PROXY && CUSTOM_PROXY !== "false" && CUSTOM_PROXY.startsWith("http");

/**
 * Erreur typée transportant le statut HTTP.
 * Permet aux callers de distinguer un 404 « joueur introuvable »
 * (publicId invalide) d'une vraie erreur réseau/proxy.
 */
export class OpenFrontError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OpenFrontError";
    this.status = status ?? null;
  }
  get isNotFound() {
    return this.status === 404;
  }
}

/**
 * Liste des proxies CORS externes à essayer en cascade (fallback).
 * corsproxy.io est devenu payant côté serveur mais fonctionne encore
 * depuis un navigateur avec Origin ; codetabs et allorigins sont des
 * alternatives gratuites souvent surchargées.
 */
function buildCorsProxyUrls(apiPath) {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const encodedUrl = encodeURIComponent(API_BASE + path);
  const proxies = [
    // Cloudflare Worker (le plus fiable, ajoute le header x-skailex-access)
    `https://openfront-proxy.diofortnite3.workers.dev${path}`,
    // Fallbacks CORS gratuits
    `https://api.codetabs.com/v1/proxy/?quest=${encodedUrl}`,
    `https://api.allorigins.win/raw?url=${encodedUrl}`,
    `https://thingproxy.freeboard.io/fetch/${API_BASE}${path}`,
  ];
  if (CUSTOM_PROXY_ENABLED) {
    proxies.unshift(`${CUSTOM_PROXY}${path}`);
  }
  return proxies;
}

/**
 * fetch avec timeout basé sur AbortController.
 */
function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * Tente une URL et renvoie le JSON parsé.
 *
 * - 200 → retourne le JSON.
 * - 404 avec corps JSON → c'est une vraie réponse API (« Not found » pour
 *   un publicId invalide). On propage une OpenFrontError(404) pour que
 *   l'app puisse afficher « joueur introuvable » plutôt que de retomber
 *   sur le proxy suivant.
 * - 404 avec corps HTML (route proxy inexistante sur hébergement statique)
 *   → on rejette avec une erreur réseau pour enchaîner sur le proxy suivant.
 * - Autre statut → OpenFrontError(status).
 */
async function tryFetchJson(url, ms) {
  const r = await fetchWithTimeout(url, ms);
  const ct = r.headers.get("content-type") || "";
  if (r.ok) {
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new OpenFrontError(`Réponse non-JSON depuis ${url}`, r.status);
    }
  }
  // Non-OK : on regarde le corps pour distinguer une 404 API (JSON)
  // d'une 404 de route proxy (HTML).
  const body = await r.text().catch(() => "");
  const isJson = ct.includes("json") || body.trim().startsWith("{") || body.trim().startsWith("[");
  if (r.status === 404 && !isJson) {
    // Route proxy inexistante (ex: GitHub Pages) → enchaîner sur le suivant.
    throw new OpenFrontError(`Route proxy introuvable (HTML 404): ${url}`, -1);
  }
  // Vraie erreur API (404 JSON = joueur introuvable, 5xx, etc.)
  const snippet = body ? `: ${body.slice(0, 120)}` : "";
  throw new OpenFrontError(`HTTP ${r.status}${snippet}`, r.status);
}

/**
 * Fetch générique vers l'API OpenFront.
 *
 * Ordre :
 *   1. Proxy local Next.js (/api/openfront/...) — rapide, same-origin.
 *   2. Proxies CORS externes en cascade.
 *
 * Une OpenFrontError avec status=404 remonte immédiatement (joueur
 * introuvable) sans essayer les autres proxies, car un 404 de l'API
 * OpenFront est cohérent quel que soit le chemin.
 */
export async function fetchOpenFront(apiPath) {
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  let lastError = null;

  // ── 1. Proxy local Next.js (priorité — fonctionne en dev/preview/Vercel) ──
  try {
    return await tryFetchJson(`/api/openfront${path}`, 6000);
  } catch (e) {
    // 404 API (JSON) = joueur introuvable : on propage tout de suite.
    if (e instanceof OpenFrontError && e.status === 404) throw e;
    // Sinon (route absente, timeout, réseau) : on note et on enchaîne.
    lastError = e;
  }

  // ── 2. Proxies CORS externes (fallback — hébergement statique) ──
  const proxyUrls = buildCorsProxyUrls(apiPath);
  for (const proxyUrl of proxyUrls) {
    if (proxyUrl === `/api/openfront${path}`) continue; // déjà essayé
    try {
      return await tryFetchJson(proxyUrl, 8000);
    } catch (e) {
      if (e instanceof OpenFrontError && e.status === 404) throw e;
      lastError = e;
      // essaie le proxy suivant
    }
  }

  // ── 3. Échec total ──
  throw lastError instanceof OpenFrontError
    ? lastError
    : new OpenFrontError(
        `Échec de tous les proxies OpenFront: ${lastError?.message || "unknown"}`,
        null
      );
}

"use client";

// Badge « joueur vérifié » — même règle que le client officiel OpenFront :
// pseudo sans point = nom nu réservé (premium / indefini).
export function VerifiedBadge({
  className = "h-4 w-4 text-emerald-400",
  title = "Joueur vérifié (nom réservé)",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path
        d="M7.5 12.5l3 3 6-6.5"
        stroke="white"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

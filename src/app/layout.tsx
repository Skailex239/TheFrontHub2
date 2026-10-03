import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenFront Tracker — lobbies, classements, joueurs, speedrun, skins",
  description:
    "Tableau de bord temps réel pour OpenFront : lobbies publics en direct (flux WebSocket zbin), classements 1v1/2v2, joueurs vérifiés, records de vitesse et catalogue des cosmétiques.",
  keywords: [
    "OpenFront",
    "lobbies",
    "classement",
    "speedrun",
    "skins",
    "temps réel",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}

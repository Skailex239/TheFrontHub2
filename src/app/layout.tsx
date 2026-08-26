import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenFront · Tableau de bord — Top players all Time & this Week",
  description:
    "Classement des meilleurs joueurs OpenFront : Top players all Time (cumul carrière) et Top players this Week (depuis lundi, Europe/Paris). Données récupérées en direct via l'API OpenFront.",
  keywords: [
    "OpenFront",
    "leaderboard",
    "Top players",
    "classement",
    "FFA",
    "Team",
    "ranked",
  ],
  authors: [{ name: "TheFrontHub" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "OpenFront · Tableau de bord",
    description:
      "Top players all Time & this Week — classement en direct via l'API OpenFront.",
    siteName: "TheFrontHub",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenFront · Tableau de bord",
    description:
      "Top players all Time & this Week — classement en direct via l'API OpenFront.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}

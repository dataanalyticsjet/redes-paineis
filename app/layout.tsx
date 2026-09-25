import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#e60000",
  colorScheme: "light",
  viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "DASH BOARD - MONITORAMENTO DE COLETA",
    description:
      "Dashboard operacional com filtros por base, data e status a partir de arquivos Excel.",
    manifest: "/manifest.webmanifest",
    applicationName: "DASH BOARD - MONITORAMENTO DE COLETA",
    appleWebApp: {
      capable: true,
      title: "DASH BOARD",
      statusBarStyle: "black-translucent",
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      icon: [
        { url: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      shortcut: "/app-icon-192.png",
      apple: "/app-icon-192.png",
    },
    openGraph: {
      title: "DASH BOARD - MONITORAMENTO DE COLETA",
      description:
        "Base, data e status em uma visão operacional processada no navegador.",
      type: "website",
      locale: "pt_BR",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1672,
          height: 941,
          alt: "Dashboard de Monitoramento de Coletas J&T Express",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "DASH BOARD - MONITORAMENTO DE COLETA",
      description: "Dashboard operacional para arquivos Excel de coleta.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import "../styles/globals.css";

const applicationTitle = "DASH BOARD - MONITORAMENTO DE COLETA";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { name: "theme-color", content: "#e60000" },
      { name: "color-scheme", content: "light" },
      { name: "application-name", content: applicationTitle },
      {
        name: "description",
        content:
          "Dashboard operacional com filtros por base, data e status a partir de arquivos Excel.",
      },
      { title: applicationTitle },
      { property: "og:title", content: applicationTitle },
      {
        property: "og:description",
        content: "Base, data e status em uma visão operacional processada no navegador.",
      },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "pt_BR" },
      { property: "og:image", content: "/og.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: applicationTitle },
      {
        name: "twitter:description",
        content: "Dashboard operacional para arquivos Excel de coleta.",
      },
      { name: "twitter:image", content: "/og.png" },
      { name: "format-detection", content: "telephone=no" },
    ],
    links: [
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { rel: "shortcut icon", href: "/app-icon-192.png" },
      { rel: "apple-touch-icon", href: "/app-icon-192.png" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}

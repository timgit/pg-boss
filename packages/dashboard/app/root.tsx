import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { AppSidebar } from "~/components/sidebar";
import { ThemeToggle } from "~/components/ui/theme-toggle";
import { LoadingBar } from "~/components/loading-bar";
import { ThemeProvider } from "~/components/theme-provider";
import { Breadcrumbs } from "~/components/breadcrumbs";
import { SidebarProvider, SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { dbContext } from "~/lib/db-context";
import { toPublicDatabase } from "~/lib/config.server";
import { isReadOnly } from "~/lib/read-only.server";
import { capabilityContext } from "~/lib/capability-context";
import { DEFAULT_DENIAL, defaultCapabilities } from "~/lib/capabilities";
import faviconSource from "~/assets/pg-boss-favicon.svg?raw";
import markWhite from "~/assets/pg-boss-mark-white.svg?raw";
import { BRAND_COBALT, COLOR_HEX, DEFAULT_COLOR_THEME } from "~/lib/favicon";

function MainContent ({ children }: { children: React.ReactNode }) {
  const { open, isMobile, state } = useSidebar()

  return (
    <main
      className={cn(
        "flex-1 min-w-0 overflow-x-hidden transition-[padding] duration-150 ease-linear",
        !isMobile && (state === 'expanded' ? 'md:pl-[var(--sidebar-width)]' : 'md:pl-[var(--sidebar-width-icon)]')
      )}
      style={{ background: 'var(--gradient-app)' }}
    >
      {/* Frosted console topbar: breadcrumbs + global chrome */}
      <div
        className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 px-6 border-b border-[var(--border-subtle)] backdrop-blur-md backdrop-saturate-150"
        style={{ background: 'var(--surface-topbar)', boxShadow: 'var(--topbar-shadow)' }}
      >
        <div className="flex items-center gap-4">
          <SidebarTrigger />
          <Breadcrumbs />
        </div>
        <div className="flex items-center gap-2">
          {!open && (
            <>
              {/*
                The same construction as the sidebar header: a themed square
                with the knockout mark inlined on top, rather than an <img>
                whose square no CSS of ours could reach. The radius is the
                brand's own 36/160 of the width, 28 × 0.225 = 6.3, so it matches
                the sidebar at a different size. This is the only mark a
                phone-width viewport shows.
              */}
              <div
                className="w-7 h-7 rounded-[6.3px] bg-primary-600 shrink-0 md:hidden [&>svg]:w-full [&>svg]:h-full"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: markWhite }}
              />
              <span className="font-semibold text-sidebar-foreground md:hidden">pg-boss</span>
            </>
          )}
          {/*
            Light and dark live here rather than in the sidebar footer, where
            they were one of three items under a "Theme" heading. A setting that
            is flipped by feel — the room got dark — belongs where the eye
            already is, and the sidebar is collapsed on half the widths this
            runs at.
          */}
          <ThemeToggle />
        </div>
      </div>
      <div className="px-6 py-6 lg:px-8 lg:py-8">
        {children}
      </div>
    </main>
  )
}

// Inline script to prevent flash of wrong theme
const themeScript = `
  (function() {
    // The mark's own source, inlined at build time. Inside the IIFE so the page
    // gains no global; it is only ever read a few lines below.
    //
    // Every constant this script depends on is interpolated from ~/lib/favicon
    // rather than written out here: the script is a string and cannot import,
    // and a literal copy of the palette, the default theme or the brand hex is
    // a second thing to keep in step. The one that bites is the brand hex — a
    // copy here would keep tinting correctly after the module's own guard had
    // started failing, so the two must come from the same place.
    const MARK_SOURCE = ${JSON.stringify(faviconSource)};
    const colorHex = ${JSON.stringify(COLOR_HEX)};

    const stored = localStorage.getItem('pg-boss-theme');
    const mode = stored || 'system';
    let theme = mode;
    if (theme === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.add(theme);
    // Expose the selected mode (light/dark/system) so the sidebar theme label
    // can render from CSS on the first paint instead of client-only React state.
    document.documentElement.dataset.themeMode = mode;

    const colorTheme = localStorage.getItem('pg-boss-color-theme') || ${JSON.stringify(DEFAULT_COLOR_THEME)};
    document.documentElement.dataset.colorTheme = colorTheme;

    // Tint the mark's square to the chosen theme. This runs before first paint
    // and is the only thing that sets the icon on load — links() deliberately
    // emits none, because the server has never seen localStorage. Only the
    // square's fill is swapped, so the queue row comes straight from the asset
    // and cannot drift from the one the sidebar draws.
    const hex = colorHex[colorTheme] || colorHex[${JSON.stringify(DEFAULT_COLOR_THEME)}];
    const svg = MARK_SOURCE.split(${JSON.stringify(BRAND_COBALT)}).join(hex);
    var link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      document.head.appendChild(link);
    }
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  })();
`;

export async function loader({ context }: Route.LoaderArgs) {
  const { databases, currentDb } = context.get(dbContext);

  // Set by the Pro overlay from `loadContext`, absent in every free build. It is
  // read with a fallback rather than required, so the dashboard has exactly one
  // answer to "what may this person do" whether or not an overlay is mounted.
  const actor = context.get(capabilityContext);

  // Project before returning. The sidebar needs an id, a display name and the
  // schema; it never needs the connection string. A loader's return value is
  // serialized into the HTML for hydration, so returning the raw config puts
  // every connection string, passwords included, in page source.
  return {
    databases: databases.map(toPublicDatabase),
    currentDb: currentDb ? toPublicDatabase(currentDb) : currentDb,
    // Drives whether mutating controls render. The server refuses mutations
    // regardless — `read-only.server.ts` here, the overlay's middleware when one
    // is mounted — so this is presentation, not enforcement.
    //
    // One field, not two. A `readOnly` boolean beside this would be a second
    // answer to the same question, and the two would disagree the first time a
    // role permitted something the global switch forbade.
    can: actor?.capabilities ?? defaultCapabilities(isReadOnly()),
    denial: actor?.denial ?? DEFAULT_DENIAL,
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="bg-[var(--surface-app)]">
        <ThemeProvider>
          <LoadingBar />
          <SidebarProvider>
            <AppSidebar />
            <MainContent>{children}</MainContent>
          </SidebarProvider>
        </ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] text-center">
      <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-2">{message}</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-4">{details}</p>
      {stack && (
        <pre className="text-left bg-gray-100 dark:bg-gray-800 p-4 rounded-lg text-sm overflow-auto max-w-full">
          {stack}
        </pre>
      )}
    </div>
  );
}

export function meta() {
  return [
    { title: "pg-boss Dashboard" },
    { name: "description", content: "Monitor and manage pg-boss job queues" },
  ];
}

export function links() {
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400..600&display=swap",
    },
  ];
}

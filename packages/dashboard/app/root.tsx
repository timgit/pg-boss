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
import { LoadingBar } from "~/components/loading-bar";
import { ThemeProvider } from "~/components/theme-provider";
import { Breadcrumbs } from "~/components/breadcrumbs";
import { SidebarProvider, SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { dbContext } from "~/lib/db-context";

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
        {!open && (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary-600 flex items-center justify-center md:hidden">
              <span className="text-white font-bold text-xs">PG</span>
            </div>
            <span className="font-semibold text-sidebar-foreground md:hidden">pg-boss</span>
          </div>
        )}
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

    const colorHex = {
      cobalt: '#284fe0',
      emerald: '#059669',
      teal: '#0d9488',
      cyan: '#0891b2',
      sky: '#0284c7',
      blue: '#2563eb',
      indigo: '#4f46e5',
      violet: '#7c3aed',
      purple: '#9333ea',
    };
    const colorTheme = localStorage.getItem('pg-boss-color-theme') || 'cobalt';
    document.documentElement.dataset.colorTheme = colorTheme;

    // Create favicon with color theme
    const hex = colorHex[colorTheme] || colorHex.cobalt;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="' + hex + '"/><text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="bold" fill="white">PG</text></svg>';
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
  return {
    databases,
    currentDb,
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

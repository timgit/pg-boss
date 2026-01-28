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
import { AppSidebar } from "~/components/layout/sidebar";
import { LoadingBar } from "~/components/loading-bar";
import { ThemeProvider } from "~/components/theme-provider";
import { SidebarProvider, SidebarTrigger, useSidebar } from "~/components/ui/sidebar";

function MainContent ({ children }: { children: React.ReactNode }) {
  const { open } = useSidebar()

  return (
    <main className="flex-1 p-6 lg:p-8 w-full bg-gray-50 dark:bg-black">
      <div className="flex items-center gap-2 mb-6">
        <SidebarTrigger />
        {!open && (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary-600 flex items-center justify-center md:hidden">
              <span className="text-white font-bold text-xs">PG</span>
            </div>
            <span className="font-semibold text-sidebar-foreground md:hidden">pg-boss</span>
          </div>
        )}
      </div>
      {children}
    </main>
  )
}

// Inline script to prevent flash of wrong theme
const themeScript = `
  (function() {
    const stored = localStorage.getItem('pg-boss-theme');
    let theme = stored || 'system';
    if (theme === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.add(theme);
  })();
`;

export async function loader({ context }: Route.LoaderArgs) {
  return {
    databases: context.databases,
    currentDb: context.currentDb,
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body className="bg-gray-50 dark:bg-black">
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

// SVG favicon matching the sidebar logo
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%234f46e5"/><text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="bold" fill="white">PG</text></svg>`;

export function links() {
  return [
    {
      rel: "icon",
      type: "image/svg+xml",
      href: `data:image/svg+xml,${faviconSvg}`,
    },
  ];
}

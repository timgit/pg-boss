import { NavLink, useRouteLoaderData, useSearchParams, useNavigate } from "react-router";
import { useState } from "react";

interface DatabaseConfig {
  id: string;
  name: string;
  url: string;
  schema: string;
}

interface RootLoaderData {
  databases: DatabaseConfig[];
  currentDb: DatabaseConfig;
}

const navigation = [
  { name: "Overview", href: "/", icon: HomeIcon },
  { name: "Queues", href: "/queues", icon: QueueIcon },
  { name: "Warnings", href: "/warnings", icon: WarningIcon },
];

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  );
}

function QueueIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  );
}

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
    </svg>
  );
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

function DatabaseSelector({
  databases,
  currentDb,
  onSelect,
}: {
  databases: DatabaseConfig[];
  currentDb: DatabaseConfig;
  onSelect: (db: DatabaseConfig) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  if (databases.length <= 1) {
    return null;
  }

  return (
    <div className="px-3 py-3 border-b border-gray-200">
      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center justify-between px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <DatabaseIcon className="w-4 h-4 text-gray-500 flex-shrink-0" />
            <span className="font-medium text-gray-900 truncate">{currentDb.name}</span>
          </div>
          <ChevronIcon className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-10"
              onClick={() => setIsOpen(false)}
            />
            {/* Dropdown */}
            <div className="absolute left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
              {databases.map((db) => (
                <button
                  key={db.id}
                  type="button"
                  onClick={() => {
                    onSelect(db);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 ${
                    db.id === currentDb.id ? 'bg-primary-50 text-primary-700' : 'text-gray-700'
                  }`}
                >
                  <DatabaseIcon className={`w-4 h-4 flex-shrink-0 ${
                    db.id === currentDb.id ? 'text-primary-600' : 'text-gray-400'
                  }`} />
                  <span className="truncate">{db.name}</span>
                  {db.schema !== 'pgboss' && (
                    <span className="ml-auto text-xs text-gray-400">({db.schema})</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SidebarContent({
  databases,
  currentDb,
  onDatabaseSelect,
  onNavigate,
  dbParam,
}: {
  databases?: DatabaseConfig[];
  currentDb?: DatabaseConfig;
  onDatabaseSelect?: (db: DatabaseConfig) => void;
  onNavigate?: () => void;
  dbParam?: string | null;
}) {
  // Build href with db param preserved
  const buildHref = (path: string) => {
    if (!dbParam) return path;
    return `${path}?db=${dbParam}`;
  };
  return (
    <>
      <div className="flex items-center h-16 px-6 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">PG</span>
          </div>
          <span className="font-semibold text-gray-900">pg-boss</span>
        </div>
      </div>

      {databases && currentDb && onDatabaseSelect && databases.length > 1 && (
        <DatabaseSelector
          databases={databases}
          currentDb={currentDb}
          onSelect={onDatabaseSelect}
        />
      )}

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navigation.map((item) => (
          <NavLink
            key={item.name}
            to={buildHref(item.href)}
            end={item.href === "/"}
            onClick={onNavigate}
            className={({ isActive }) =>
              `group flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                isActive
                  ? "bg-primary-50 text-primary-700"
                  : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={`mr-3 h-5 w-5 flex-shrink-0 ${
                    isActive ? "text-primary-600" : "text-gray-400 group-hover:text-gray-500"
                  }`}
                />
                {item.name}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-200">
        <p className="text-xs text-gray-500">pg-boss Dashboard</p>
        {currentDb && databases && databases.length > 1 && (
          <p className="text-xs text-gray-400 mt-1 truncate" title={currentDb.schema}>
            Schema: {currentDb.schema}
          </p>
        )}
      </div>
    </>
  );
}

export function Sidebar() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const rootData = useRouteLoaderData("root") as RootLoaderData | undefined;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const databases = rootData?.databases || [];
  const currentDb = rootData?.currentDb;
  const dbParam = searchParams.get("db");

  const handleDatabaseSelect = (db: DatabaseConfig) => {
    // Navigate to same path with new db param
    const params = new URLSearchParams(searchParams);
    if (db.id === databases[0]?.id) {
      // Remove db param for default database
      params.delete('db');
    } else {
      params.set('db', db.id);
    }
    const newSearch = params.toString();
    navigate({
      pathname: window.location.pathname,
      search: newSearch ? `?${newSearch}` : '',
    });
  };

  return (
    <>
      {/* Mobile menu button */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 flex items-center h-16 px-4 bg-white border-b border-gray-200">
        <button
          type="button"
          className="p-2 -ml-2 text-gray-500 hover:text-gray-700"
          onClick={() => setMobileMenuOpen(true)}
        >
          <span className="sr-only">Open menu</span>
          <MenuIcon className="h-6 w-6" />
        </button>
        <div className="flex items-center gap-2 ml-2">
          <div className="w-7 h-7 rounded-lg bg-primary-600 flex items-center justify-center">
            <span className="text-white font-bold text-xs">PG</span>
          </div>
          <span className="font-semibold text-gray-900">pg-boss</span>
          {currentDb && databases.length > 1 && (
            <span className="text-xs text-gray-400 ml-1">({currentDb.name})</span>
          )}
        </div>
      </div>

      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-gray-900/50"
            onClick={() => setMobileMenuOpen(false)}
          />

          {/* Sidebar panel */}
          <div className="fixed inset-y-0 left-0 w-64 bg-white flex flex-col">
            <div className="absolute top-4 right-4">
              <button
                type="button"
                className="p-2 text-gray-500 hover:text-gray-700"
                onClick={() => setMobileMenuOpen(false)}
              >
                <span className="sr-only">Close menu</span>
                <CloseIcon className="h-6 w-6" />
              </button>
            </div>
            <SidebarContent
              databases={databases}
              currentDb={currentDb}
              onDatabaseSelect={handleDatabaseSelect}
              onNavigate={() => setMobileMenuOpen(false)}
              dbParam={dbParam}
            />
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden lg:flex lg:flex-shrink-0">
        <div className="flex flex-col w-64 border-r border-gray-200 bg-white">
          <SidebarContent
            databases={databases}
            currentDb={currentDb}
            onDatabaseSelect={handleDatabaseSelect}
            dbParam={dbParam}
          />
        </div>
      </div>
    </>
  );
}

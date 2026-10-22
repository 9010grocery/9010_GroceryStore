import { useState } from "react";
import { useNavigate } from "react-router-dom";

// ---------- Types ----------

interface ModuleTile {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  onClick?: () => void;
}

type AlertKind = "stock" | "request";

interface AlertItem {
  id: string;
  kind: AlertKind;
  label: string;
  title: string;
}

interface ForecastItem {
  id: string;
  product: string;
  confidence: number; // 0-100
}

interface KpiStat {
  id: string;
  label: string;
  value: string;
  trend?: string;
}

type RailItemId = "dashboard" | "products" | "reports" | "employees" | "settings";

interface OwnerDashboardProps {
  storeName?: string;
  ownerName?: string;
  ownerInitials?: string;
  kpis?: KpiStat[];
  forecast?: ForecastItem[];
  alerts?: AlertItem[];
  activeRailItem?: RailItemId;
  onRailNavigate?: (item: RailItemId) => void;
  onLogout?: () => void;
  onReviewReorderList?: () => void;
  onViewAllAlerts?: () => void;
  onNotesChange?: (value: string) => void;
}

// ---------- Icons ----------

const railIcons: Record<RailItemId, React.ReactNode> = {
  dashboard: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  products: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" />
    </svg>
  ),
  reports: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" /><path d="M18 17V9M13 17V5M8 17v-4" />
    </svg>
  ),
  employees: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  ),
};

const tileIcons = {
  refund: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
    </svg>
  ),
  inventory: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" />
    </svg>
  ),
  requests: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  ),
  settings: railIcons.settings,
  receipt: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h9l3 3v17l-3-2-2.5 2-2.5-2-2.5 2-2.5-2-3 2V5a3 3 0 0 1 3-3Z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  ),
  employees: railIcons.employees,
  pcs: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
    </svg>
  ),
  reports: railIcons.reports,
};

// ---------- Default mock data ----------

const defaultKpis: KpiStat[] = [
  { id: "sales", label: "Today's Sales", value: "Php 18,420.00", trend: "▲ 12% vs. yesterday" },
  { id: "transactions", label: "Transactions", value: "143", trend: "Across 3 terminals" },
  { id: "products", label: "Products Sold", value: "420", trend: "Units today" },
];

const defaultForecast: ForecastItem[] = [
  { id: "f1", product: "Lucky Me Pancit Canton", confidence: 92 },
  { id: "f2", product: "Datu Puti Vinegar 1L", confidence: 81 },
];

const defaultAlerts: AlertItem[] = [
  { id: "a1", kind: "stock", label: "Near expiry", title: "Fresh Milk 1L (x8) — 2 days" },
  { id: "a2", kind: "request", label: "New request", title: "Silver Swan Soy Sauce, 1 gal" },
];

const alertAccent: Record<AlertKind, string> = {
  stock: "border-l-[#E8862E]",
  request: "border-l-[#1E3A2F]",
};

const alertLabelColor: Record<AlertKind, string> = {
  stock: "text-[#C96E1E]",
  request: "text-[#1E3A2F]",
};

// ---------- Component ----------

export default function OwnerDashboard({
  storeName = "9010 Grocery Store",
  ownerName = "John Doe",
  ownerInitials = "JD",
  kpis = defaultKpis,
  forecast = defaultForecast,
  alerts = defaultAlerts,
  activeRailItem = "dashboard",
  onRailNavigate,
  onLogout,
  onReviewReorderList,
  onViewAllAlerts,
  onNotesChange,
}: OwnerDashboardProps) {
  const [notes, setNotes] = useState("");
  const navigate = useNavigate();

  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  const railItems: { id: RailItemId; title: string }[] = [
    { id: "dashboard", title: "Dashboard" },
    { id: "products", title: "Products & Inventory" },
    { id: "reports", title: "Reports" },
    { id: "employees", title: "Employees" },
    { id: "settings", title: "Settings" },
  ];

  const tiles: ModuleTile[] = [
    { id: "refund", label: "Return & Refund", icon: tileIcons.refund, onClick: () => navigate("/return-refund") },
    { id: "inventory", label: "Inventory", icon: tileIcons.inventory },
    { id: "requests", label: "Item Requests", icon: tileIcons.requests, badge: 5 },
    { id: "settings", label: "Settings", icon: tileIcons.settings },
    { id: "receipts", label: "Receipt History", icon: tileIcons.receipt, onClick: () => navigate("/receipt-history") },
    { id: "employees", label: "Manage Employees", icon: tileIcons.employees },
    { id: "pcs", label: "Manage PC's", icon: tileIcons.pcs },
    { id: "reports", label: "Report Center", icon: tileIcons.reports },
  ];

  function handleNotesChange(value: string) {
    setNotes(value);
    onNotesChange?.(value);
  }

  return (
    <div className="min-h-screen flex bg-[#F6F4EE] text-[#1C1E1B] font-[Manrope,sans-serif]">
      {/* Left icon rail */}
      <aside className="w-[72px] flex-shrink-0 flex flex-col items-center py-5 gap-1 bg-[#1E3A2F]">
        <div className="w-9 h-9 rounded-md flex items-center justify-center mb-6 bg-[#E8862E]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.3 4.6A1 1 0 0 0 5.6 19H17" />
            <circle cx="9" cy="21" r="1" /><circle cx="17" cy="21" r="1" />
          </svg>
        </div>

        {railItems.map((item) => (
          <button
            key={item.id}
            title={item.title}
            onClick={() => onRailNavigate?.(item.id)}
            className={`relative w-11 h-11 rounded-lg flex items-center justify-center transition-colors ${
              activeRailItem === item.id ? "text-white" : "text-white/55 hover:text-white/90"
            }`}
          >
            {activeRailItem === item.id && (
              <span className="absolute -left-[12px] w-1 h-5 rounded-r-full bg-[#E8862E]" />
            )}
            {railIcons[item.id]}
          </button>
        ))}

        <div className="mt-auto flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white bg-[#E8862E]">
            {ownerInitials}
          </div>
          <button onClick={onLogout} title="Log out" className="w-9 h-9 rounded-lg flex items-center justify-center text-white/55 hover:text-white/90">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between px-8 py-5 border-b border-[#E4E0D6] bg-white">
          <div>
            <p className="font-[Space_Grotesk,sans-serif] text-[20px] font-bold tracking-tight">DASHBOARD</p>
            <p className="text-[12px] text-[#6B7169]">{storeName} · Owner Console</p>
          </div>
          <div className="flex items-center gap-5">
            <div className="text-right hidden sm:block">
              <p className="text-[13px] font-semibold">{time}</p>
              <p className="text-[11px] text-[#6B7169]">{date}</p>
            </div>
            <div className="flex items-center gap-2 pl-4 border-l border-[#E4E0D6]">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white bg-[#1E3A2F]">
                {ownerInitials}
              </div>
              <div className="hidden md:block">
                <p className="text-[13px] font-semibold leading-tight">{ownerName}</p>
                <p className="text-[11px] text-[#6B7169]">Owner · Full Access</p>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 flex flex-col lg:flex-row gap-6 p-6 lg:p-8">
          {/* Left: KPIs + tile grid */}
          <section className="flex-1 flex flex-col gap-6">
            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {kpis.map((kpi) => (
                <div key={kpi.id} className="rounded-xl p-5 bg-white border border-[#E4E0D6]">
                  <p className="text-[12px] text-[#6B7169]">{kpi.label}</p>
                  <p className="font-[Space_Grotesk,sans-serif] text-[22px] font-bold mt-1 text-[#1E3A2F]">{kpi.value}</p>
                  {kpi.trend && <p className="text-[11px] mt-1 text-[#C96E1E]">{kpi.trend}</p>}
                </div>
              ))}
            </div>

            {/* Module tiles */}
            <div>
              <div className="flex items-baseline justify-between mb-4">
                <p className="font-[Space_Grotesk,sans-serif] text-[15px] font-semibold">Modules</p>
                <p className="text-[12px] text-[#6B7169]">{tiles.length} modules available</p>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {tiles.map((tile) => (
                  <button
                    key={tile.id}
                    onClick={tile.onClick}
                    className="relative text-left bg-white border border-[#E4E0D6] border-b-4 rounded-xl p-4 flex flex-col items-start gap-3
                               transition-transform duration-150 ease-out
                               hover:-translate-y-0.5 hover:border-b-[#1E3A2F]
                               active:translate-y-px active:border-b-2"
                  >
                    {tile.badge != null && (
                      <span className="absolute top-3 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full text-white bg-[#E8862E]">
                        {tile.badge}
                      </span>
                    )}
                    <div className="text-[#1E3A2F]">{tile.icon}</div>
                    <p className="font-[Space_Grotesk,sans-serif] text-[13px] font-semibold">{tile.label}</p>
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Right: Insights panel */}
          <aside className="w-full lg:w-[320px] flex-shrink-0 flex flex-col gap-4">
            {/* Demand Forecast */}
            <div className="rounded-xl p-4 bg-white border border-[#E4E0D6]">
              <div className="flex items-center justify-between mb-3">
                <p className="font-[Space_Grotesk,sans-serif] text-[13px] font-semibold">Demand Forecast</p>
              </div>
              <p className="text-[12px] font-semibold">Top items to reorder this week</p>
              <div className="mt-3 flex flex-col gap-2.5">
                {forecast.map((item) => (
                  <div key={item.id}>
                    <div className="flex justify-between text-[12px] mb-1">
                      <span>{item.product}</span>
                      <span className="text-[#6B7169]">{item.confidence}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#E7EEE9]">
                      <div className="h-1.5 rounded-full bg-[#1E3A2F]" style={{ width: `${item.confidence}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={onReviewReorderList} className="w-full mt-4 text-[12px] font-semibold py-2 rounded-md text-white bg-[#1E3A2F]">
                Review Reorder List
              </button>
            </div>

            {/* Alerts */}
            <div className="rounded-xl flex-1 flex flex-col bg-white border border-[#E4E0D6]">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#E4E0D6]">
                <p className="font-[Space_Grotesk,sans-serif] text-[13px] font-semibold">Alerts &amp; Notifications</p>
                <span className="w-2 h-2 rounded-full bg-[#E8862E] animate-pulse" />
              </div>
              <div className="p-3 flex flex-col gap-2.5">
                {alerts.map((alert) => (
                  <div key={alert.id} className={`rounded-lg p-3 bg-white border-l-[3px] ${alertAccent[alert.kind]}`}>
                    <p className={`text-[11px] font-bold uppercase tracking-wide ${alertLabelColor[alert.kind]}`}>
                      {alert.label}
                    </p>
                    <p className="text-[12.5px] font-semibold mt-0.5">{alert.title}</p>
                  </div>
                ))}
              </div>
              <div className="px-4 py-2.5 border-t border-[#E4E0D6] text-center mt-auto">
                <button onClick={onViewAllAlerts} className="text-[11.5px] font-semibold text-[#1E3A2F]">
                  View all notifications
                </button>
              </div>
            </div>

            {/* Notes */}
            <div className="rounded-xl p-4 bg-white border border-[#E4E0D6]">
              <p className="font-[Space_Grotesk,sans-serif] text-[13px] font-semibold mb-2">Notes</p>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => handleNotesChange(e.target.value)}
                placeholder="Jot a reminder for yourself or staff..."
                className="w-full text-[12px] rounded-md p-2.5 resize-none bg-[#F6F4EE] border border-[#E4E0D6] text-[#1C1E1B]"
              />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
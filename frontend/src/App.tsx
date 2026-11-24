import { NavLink, Route, Routes, useNavigate } from "react-router";
import { LogOut } from "lucide-react";
import { api } from "./api";
import { AppProvider, useApp } from "./app-context";
import { cx, Empty, ErrorNote, LoadingBlock } from "./ui";
import { ROLE_NAMES } from "./format";
import type { Role } from "./api";
import Queue from "./pages/Queue";
import Review from "./pages/Review";
import Report from "./pages/Report";
import TryIt from "./pages/TryIt";
import Evaluation from "./pages/Evaluation";
import SettingsPage from "./pages/Settings";

const NAV = [
  { to: "/", label: "Claims", end: true },
  { to: "/try", label: "Try it" },
  { to: "/evaluation", label: "Evaluation" },
  { to: "/settings", label: "Settings" },
];

function TopBar() {
  const { usage, role, setRole } = useApp();
  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      window.location.assign("/login");
    }
  };
  const atCap = usage ? usage.live_runs_today >= usage.daily_cap : false;
  return (
    <header className="no-print sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex h-12 max-w-[1560px] items-center gap-6 px-6">
        <NavLink to="/" className="text-sm font-semibold tracking-[-0.01em] whitespace-nowrap">
          Claims assessment
        </NavLink>
        <nav aria-label="Main" className="flex h-full items-stretch gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx(
                  "relative flex items-center px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                  isActive ? "text-ink after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:bg-ink" : "text-muted hover:text-ink",
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <div
            className="flex items-center gap-2"
            title="The demo has one password and no accounts. Switch between the two people in the flow to see each one's queue and actions."
          >
            <span className="hidden text-xs whitespace-nowrap text-muted md:inline">Viewing as</span>
            <div role="radiogroup" aria-label="Viewing as" className="flex rounded-md border border-line-strong p-0.5">
              {(["agent", "senior"] as Role[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={role === r}
                  onClick={() => setRole(r)}
                  className={cx(
                    "h-7 rounded-[5px] px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                    role === r ? "bg-ink text-white" : "text-muted hover:text-ink",
                  )}
                >
                  {ROLE_NAMES[r]}
                </button>
              ))}
            </div>
          </div>
          {usage ? (
            <span
              className={cx("num hidden text-xs whitespace-nowrap xl:inline", atCap ? "font-medium text-bad" : "text-muted")}
              title="Each live AI run costs a few cents, so the prototype caps them per day. Stored results don't count."
            >
              Live AI runs today: {usage.live_runs_today} of {usage.daily_cap}
            </span>
          ) : null}
          <button type="button" onClick={signOut} className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-muted hover:text-ink">
            <LogOut size={14} aria-hidden /> Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function NotFound() {
  const nav = useNavigate();
  return (
    <div className="mx-auto max-w-[1560px] px-6 py-6">
      <Empty title="This page doesn't exist">
        <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => nav("/")}>
          Back to the claims queue
        </button>
      </Empty>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider
      fallback={(error, retry) => (
        <div className="mx-auto max-w-md px-6 py-24">{error ? <ErrorNote onRetry={retry}>{error}</ErrorNote> : <LoadingBlock />}</div>
      )}
    >
      <TopBar />
      <main>
        <Routes>
          <Route path="/" element={<Queue />} />
          <Route path="/claims/:id" element={<Review />} />
          <Route path="/claims/:id/report" element={<Report />} />
          <Route path="/try" element={<TryIt />} />
          <Route path="/evaluation" element={<Evaluation />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </AppProvider>
  );
}

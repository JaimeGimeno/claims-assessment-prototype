import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, DependencyList, ReactNode } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import type { Confidence, Flags, Route, Status } from "./api";
import { stageName } from "./format";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- data loading

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

// ---------------------------------------------------------------- buttons and fields

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-white hover:bg-black border border-ink disabled:bg-line disabled:border-line disabled:text-faint",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-subtle hover:border-faint disabled:text-faint disabled:hover:bg-surface",
  ghost: "text-muted hover:text-ink hover:bg-ink/5 border border-transparent disabled:text-faint disabled:hover:bg-transparent",
  danger: "bg-surface text-bad border border-line-strong hover:bg-bad-soft hover:border-bad/40 disabled:text-faint",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  busy?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", busy, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors active:translate-y-px",
        size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        VARIANTS[variant],
        className,
      )}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export const inputClass =
  "h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/30 disabled:bg-subtle disabled:text-faint";

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
        checked ? "border-ink bg-ink" : "border-line-strong bg-line",
        disabled && "opacity-50",
      )}
    >
      <span className={cx("absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform", checked && "translate-x-4")} />
    </button>
  );
}

// ---------------------------------------------------------------- chips

type Tone = "neutral" | "ok" | "warn" | "info" | "bad" | "accent" | "plain";

const TONES: Record<Tone, string> = {
  neutral: "bg-ink/6 text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  info: "bg-info-soft text-info",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent-strong",
  plain: "border border-line-strong text-muted",
};

export function Chip({ tone = "neutral", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-xs leading-none font-medium whitespace-nowrap", TONES[tone], className)}
    >
      {children}
    </span>
  );
}

const ROUTE_TONE: Record<string, Tone> = { fast_track: "ok", full_review: "warn", need_more_information: "info" };

export function RouteChip({ route, name }: { route: Route; name: string }) {
  return <Chip tone={route ? ROUTE_TONE[route] : "neutral"}>{name}</Chip>;
}

export function StatusChip({ status, route, short }: { status: Status; route?: Route; short?: boolean }) {
  const tone: Tone =
    status === "approved" ? "ok" : status === "rejected" ? "bad" : status === "info_requested" ? "info" : status === "agent_checked" ? "accent" : "plain";
  const label = stageName(status, route);
  return (
    <Chip tone={tone} title={short ? label : undefined}>
      {short ? stageName(status, route, true) : label}
    </Chip>
  );
}

export function FlagChips({ flags }: { flags: Flags }) {
  return (
    <>
      {flags.total_loss ? (
        <Chip tone="bad" title="The estimate is close to or above the car's value">
          <AlertTriangle size={11} aria-hidden /> Possible total loss
        </Chip>
      ) : null}
      {flags.structural ? (
        <Chip tone="bad" title="The AI saw signs of structural damage">
          <AlertTriangle size={11} aria-hidden /> Structural
        </Chip>
      ) : null}
    </>
  );
}

export function ConfidenceChip({ level, title }: { level: Confidence; title?: string }) {
  const dot = level === "high" ? "bg-ok" : level === "medium" ? "bg-warn" : "bg-bad";
  return (
    <span title={title} className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-line px-1.5 text-xs leading-none whitespace-nowrap text-muted">
      <span className={cx("h-1.5 w-1.5 rounded-full", dot)} aria-hidden />
      {level}
    </span>
  );
}

/** Marks numbers that are not real. Quiet on purpose. */
export function SampleTag({ children = "Sample data", title }: { children?: ReactNode; title?: string }) {
  return (
    <span
      title={title ?? "Prices, labour hours, car values and shops in this prototype are sample data."}
      className="inline-flex h-[18px] items-center rounded-sm border border-dashed border-line-strong px-1.5 text-[11px] leading-none font-normal whitespace-nowrap text-faint"
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- surfaces and states

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-lg border border-line bg-surface", className)}>{children}</section>;
}

export function CardHeader({ title, aside, sub }: { title: ReactNode; aside?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {sub ? <span className="text-[13px] text-muted">{sub}</span> : null}
      </div>
      {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
    </header>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="shrink-0 animate-[spin_0.8s_linear_infinite]" aria-hidden />;
}

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorNote({ children, onRetry, className }: { children: ReactNode; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cx("flex items-start gap-2 rounded-md border border-bad/25 bg-bad-soft px-3 py-2 text-[13px] text-bad", className)}>
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">{children}</p> : null}
    </div>
  );
}

export function PageHeader({ title, sub, aside }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.01em]">{title}</h1>
        {sub ? <p className="mt-0.5 max-w-[110ch] text-[13px] text-muted">{sub}</p> : null}
      </div>
      {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- dialog

export function Modal({ open, onClose, title, children, footer, width = 460 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      className="m-auto rounded-lg border border-line-strong bg-surface p-0 text-ink shadow-[0_12px_40px_rgb(27_27_25/0.18)]"
    >
      {open ? (
        <div>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 rounded-sm p-1 text-muted hover:bg-ink/5 hover:text-ink">
              <X size={16} />
            </button>
          </div>
          <div className="px-4 py-4">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

// ---------------------------------------------------------------- tables

export const th = "px-3 py-2 text-left text-xs font-medium text-muted whitespace-nowrap";
export const thNum = "px-3 py-2 text-right text-xs font-medium text-muted whitespace-nowrap";
export const td = "px-3 py-2 align-top";
export const tdNum = "px-3 py-2 align-top text-right num whitespace-nowrap";

/** Elapsed seconds while something runs; resets when `running` turns on. */
export function useElapsed(running: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return;
    setS(0);
    const t = window.setInterval(() => setS((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return s;
}

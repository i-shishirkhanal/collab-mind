import { cn } from "@/lib/utils";

export const initialsOf = (name?: string | null, fallback = "?") =>
  (name || fallback).trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || fallback;

/** Round initials avatar matching the style used in the workspace sidebar. */
export function Initials({
  name,
  src,
  className,
  online,
}: {
  name?: string | null;
  src?: string | null;
  className?: string;
  /** undefined = hide the dot; true/false = show green/grey status dot */
  online?: boolean;
}) {
  return (
    <div className={cn("relative shrink-0", className ?? "w-10 h-10")}>
      <div className="w-full h-full rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 overflow-hidden">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          initialsOf(name)
        )}
      </div>
      {online !== undefined && (
        <span
          className={cn(
            "absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-slate-900",
            online ? "bg-green-500" : "bg-slate-600",
          )}
          title={online ? "Online" : "Offline"}
        />
      )}
    </div>
  );
}

"use client";

export const dynamic = "force-dynamic";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body className="bg-slate-950 text-slate-50 min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <h2 className="text-2xl font-bold">Something went wrong!</h2>
          <p className="text-slate-400 text-sm">{error?.message || "An unexpected error occurred."}</p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

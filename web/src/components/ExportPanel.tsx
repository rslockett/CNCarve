"use client";

import { useAppState } from "@/context/AppState";

type Props = {
  /** When set, shows a button that asks Kiri (iframe) to export and push G-code back here. */
  onFetchFromKiri?: () => void;
};

export function ExportPanel({ onFetchFromKiri }: Props) {
  const { exportedGcode, setExportedGcode } = useAppState();

  const download = () => {
    const blob = new Blob([exportedGcode], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "job.nc";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-white">G-code</h3>
        <p className="mt-1 text-sm text-slate-400">
          Pull from Kiri after you slice/export there, or paste text from Kiri&apos;s export dialog.
          This buffer is what USB streaming sends to the machine.
        </p>
      </div>
      {onFetchFromKiri && (
        <button
          type="button"
          onClick={onFetchFromKiri}
          className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500"
        >
          Get G-code from Kiri
        </button>
      )}
      <textarea
        className="min-h-[220px] w-full rounded-lg border border-white/10 bg-slate-950/80 p-3 font-mono text-xs text-slate-200"
        placeholder=";(Paste or auto-fill G-code here)"
        value={exportedGcode}
        onChange={(e) => setExportedGcode(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={download}
          disabled={!exportedGcode.trim()}
          className="rounded-lg border border-white/15 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
        >
          Download .nc (backup)
        </button>
      </div>
    </div>
  );
}

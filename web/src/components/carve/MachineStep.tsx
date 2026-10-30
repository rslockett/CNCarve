"use client";

import { CarveMachine, type MachineState } from "@/lib/carveMachine";
import { chooseRestartLine, clearCarve, loadCarve, loadProgress, type SavedCarve } from "@/lib/carveStore";
import type { CarveProgram } from "@/lib/relief/reliefCam";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

type Props = {
  machine: CarveMachine;
  /** The carve made in step 4 (null until toolpaths exist). */
  job: (CarveProgram & { name: string; bitLabel: string; spindleS: number }) | null;
};

const TONE: Record<string, string> = {
  info: "border-sky-500/40 bg-sky-950/40 text-sky-100",
  good: "border-emerald-500/40 bg-emerald-950/40 text-emerald-100",
  warn: "border-amber-500/40 bg-amber-950/40 text-amber-100",
  bad: "border-rose-500/50 bg-rose-950/50 text-rose-100",
};

const noopSubscribe = () => () => {};

function minutesText(min: number) {
  const m = Math.max(1, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** Estimated minutes done at `line`, using per-section estimates. */
function minutesDone(job: { sections: { start: number }[]; sectionMinutes: number[]; lineCount: number }, line: number) {
  let done = 0;
  job.sections.forEach((s, i) => {
    const end = job.sections[i + 1]?.start ?? job.lineCount;
    if (line >= end) done += job.sectionMinutes[i];
    else if (line > s.start) done += (job.sectionMinutes[i] * (line - s.start)) / Math.max(1, end - s.start);
  });
  return done;
}

export function MachineStep({ machine, job }: Props) {
  const s: MachineState = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);
  // USB support can only be known in the browser; the server render assumes it's there.
  const supported = useSyncExternalStore(noopSubscribe, () => machine.isSupported(), () => true);
  const [saved, setSaved] = useState<SavedCarve | null>(null);
  const [jogStep, setJogStep] = useState(1);
  const [probeMode, setProbeMode] = useState(false);
  const [plateMm, setPlateMm] = useState(() => {
    try {
      return Number(localStorage.getItem("cncarve:plateMm")) || 0;
    } catch {
      return 0;
    }
  });
  const [confirmStop, setConfirmStop] = useState(false);

  const refreshSaved = useCallback(() => {
    void loadCarve().then(setSaved);
  }, []);
  useEffect(() => {
    refreshSaved();
  }, [refreshSaved]);
  // A finished or newly started carve changes what's saved.
  useEffect(() => {
    if (s.busy === null) refreshSaved();
  }, [s.busy, refreshSaved]);

  if (!supported)
    return (
      <p className={`rounded-xl border p-3 text-sm ${TONE.warn}`}>
        This browser can&apos;t talk to the machine over USB. Use Chrome or Chromium (on the Raspberry Pi,
        Chromium works).
      </p>
    );

  const carving = s.busy === "carving" || s.busy === "stopping";
  const progress = saved ? loadProgress(saved.id) : null;
  const savedPct = saved && progress ? Math.round((100 * Math.max(0, progress.lastAcked)) / saved.lineCount) : 0;
  const unfinished = !!saved && !carving && s.busy !== "restarting";

  const settingsProblems = s.settings?.filter((i) => i.status !== "ok") ?? [];
  const ready = s.connected && s.homed && s.xyZeroSet && s.zZeroSet;

  const btn =
    "rounded-xl px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40";
  const primary = `${btn} bg-gradient-to-r from-teal-500 to-emerald-600 text-white shadow-lg`;
  const secondary = `${btn} border border-white/15 text-slate-100 hover:bg-white/5`;

  // ---------- while carving ----------
  if (carving && s.progress) {
    const p = s.progress;
    const src = saved && saved.lineCount === p.total ? saved : job && job.lineCount === p.total ? job : null;
    const est = src?.estMinutes ?? 0;
    const sectionMinutes = src?.sectionMinutes ?? null;
    const done = src && sectionMinutes ? minutesDone({ sections: src.sections, sectionMinutes, lineCount: src.lineCount }, p.line) : 0;
    const pct = Math.min(100, (100 * p.line) / Math.max(1, p.total));
    return (
      <div className="space-y-4">
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-white">{s.paused ? "Paused" : p.section || "Carving"}</span>
            <span className="text-slate-300">{pct.toFixed(0)}%</span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          {est > 0 && sectionMinutes && (
            <p className="mt-1.5 text-xs text-slate-400">About {minutesText(est - done)} left</p>
          )}
        </div>
        {s.notice && <p className={`rounded-xl border p-3 text-sm ${TONE[s.notice.tone]}`}>{s.notice.text}</p>}
        <div className="flex flex-wrap gap-2">
          {s.paused ? (
            <button type="button" className={primary} onClick={() => void machine.resume()}>
              Resume
            </button>
          ) : (
            <button type="button" className={secondary} onClick={() => void machine.pause()}>
              Pause
            </button>
          )}
          {confirmStop ? (
            <>
              <button
                type="button"
                className={`${btn} bg-rose-600 text-white`}
                onClick={() => {
                  setConfirmStop(false);
                  void machine.stop();
                }}
              >
                Yes, stop now
              </button>
              <button type="button" className={secondary} onClick={() => setConfirmStop(false)}>
                Keep carving
              </button>
            </>
          ) : (
            <button type="button" className={`${btn} border border-rose-500/50 text-rose-200`} onClick={() => setConfirmStop(true)}>
              Stop
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">
          Keep this page open. If anything interrupts the carve, your progress is saved and you can continue
          from where it stopped.
        </p>
      </div>
    );
  }

  // ---------- setup checklist ----------
  return (
    <div className="space-y-4">
      {unfinished && saved && (
        <div className={`rounded-xl border p-3 text-sm ${TONE.warn}`}>
          <p className="font-semibold">
            Unfinished carving: {saved.name} — about {savedPct}% done
          </p>
          <p className="mt-1 text-amber-100/80">
            Leave the board and the bit exactly where they are. Continue homes the machine, checks your zero,
            and picks up a little before where it stopped (the first moves may cut air).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {!s.connected ? (
              <button type="button" className={primary} disabled={s.busy !== null} onClick={() => void machine.connect()}>
                Connect to the 3018
              </button>
            ) : (
              <button
                type="button"
                className={primary}
                disabled={s.busy !== null}
                onClick={() => void machine.continueCarve(saved)}
              >
                {s.busy === "restarting" ? "Continuing…" : "Continue carving"}
              </button>
            )}
            <button
              type="button"
              className={secondary}
              disabled={s.busy !== null}
              onClick={() => {
                if (window.confirm("Forget the unfinished carving? You won't be able to continue it.")) {
                  void clearCarve().then(refreshSaved);
                }
              }}
            >
              Forget it
            </button>
          </div>
          {saved && progress && (
            <p className="mt-1.5 text-[11px] text-amber-100/60">
              Restarts at line {chooseRestartLine(saved, progress.lastAcked) + 1} of {saved.lineCount}.
            </p>
          )}
        </div>
      )}

      {s.notice && <p className={`rounded-xl border p-3 text-sm ${TONE[s.notice.tone]}`}>{s.notice.text}</p>}

      <ol className="space-y-4">
        <Row n={1} done={s.connected} title="Connect to the 3018 with the USB cable">
          {!s.connected ? (
            <button type="button" className={`${primary} mt-2`} disabled={s.busy === "connecting"} onClick={() => void machine.connect()}>
              {s.busy === "connecting" ? "Connecting…" : "Connect"}
            </button>
          ) : (
            <div className="mt-1 text-xs text-slate-400">
              {s.settings === null
                ? "Checking the machine's settings…"
                : settingsProblems.length === 0
                  ? "Machine settings look right."
                  : null}
              {settingsProblems.map((it) => (
                <p key={it.id} className={it.status === "problem" ? "text-rose-300" : "text-amber-200"}>
                  {it.status === "problem" ? "✕" : "!"} {it.title}. {it.detail}{" "}
                  {it.fix && (it.fix === "$32=0" || it.fix === "$13=0") && (
                    <button
                      type="button"
                      className="ml-1 rounded border border-teal-500/50 px-1.5 text-teal-200"
                      onClick={() => void machine.applyFix(it.fix!)}
                    >
                      Fix it
                    </button>
                  )}
                </p>
              ))}
            </div>
          )}
        </Row>

        <Row n={2} done={s.homed} title="Home the machine">
          {s.connected && !s.homed && (
            <>
              <p className="mt-1 text-xs text-slate-400">It moves to its corner switches so it knows exactly where it is.</p>
              <button type="button" className={`${primary} mt-2`} disabled={s.busy !== null} onClick={() => void machine.home()}>
                {s.busy === "homing" ? "Homing…" : "Home"}
              </button>
            </>
          )}
        </Row>

        <Row n={3} done={s.xyZeroSet && s.zZeroSet} title="Find the centre and top of the board">
          {s.homed && !(s.xyZeroSet && s.zZeroSet) && (
            <div className="mt-2 space-y-3">
              <p className="text-xs text-slate-400">
                {!s.xyZeroSet
                  ? "Draw pencil lines corner to corner on the board. Move the bit until it is right over where they cross."
                  : probeMode
                    ? "Put the probe plate on the board under the bit and clip the lead to the bit."
                    : "Slide a sheet of paper under the bit. Lower the bit in small steps until it just pinches the paper."}
              </p>
              <JogPad machine={machine} disabled={s.busy !== null} step={jogStep} setStep={setJogStep} />
              {s.wpos && (
                <p className="font-mono text-[11px] text-slate-500">
                  X {s.wpos.x.toFixed(2)} · Y {s.wpos.y.toFixed(2)} · Z {s.wpos.z.toFixed(2)} mm
                </p>
              )}
              {!s.xyZeroSet ? (
                <button type="button" className={primary} disabled={s.busy !== null} onClick={() => void machine.setXYZero()}>
                  The bit is over the centre
                </button>
              ) : probeMode ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-300">
                    Plate thickness (mm){" "}
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={plateMm}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setPlateMm(v);
                        try {
                          localStorage.setItem("cncarve:plateMm", String(v));
                        } catch {
                          /* ignore */
                        }
                      }}
                      className="ml-1 w-20 rounded-md border border-white/15 bg-slate-950 px-2 py-1 text-sm"
                    />
                  </label>
                  <button type="button" className={primary} disabled={s.busy !== null} onClick={() => void machine.probeZ(plateMm)}>
                    {s.busy === "probing" ? "Probing…" : "Probe"}
                  </button>
                  <button type="button" className="text-xs text-slate-400 underline" onClick={() => setProbeMode(false)}>
                    Use paper instead
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={primary} disabled={s.busy !== null} onClick={() => void machine.setZZeroHere()}>
                    The bit just touches the paper
                  </button>
                  <button type="button" className="text-xs text-slate-400 underline" onClick={() => setProbeMode(true)}>
                    Use the touch probe instead
                  </button>
                </div>
              )}
            </div>
          )}
        </Row>

        <Row n={4} done={s.traced} title="Check the outline (spindle off)">
          {ready && !s.traced && (
            <>
              <p className="mt-1 text-xs text-slate-400">
                The bit traces the edge of the carving 2 mm above the board. Make sure it stays on the wood and
                away from clamps.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={s.busy !== null || !job}
                  onClick={() => job && void machine.trace(job.traceGcode)}
                >
                  {s.busy === "tracing" ? "Tracing…" : "Trace the outline"}
                </button>
              </div>
            </>
          )}
        </Row>

        <Row n={5} done={false} title="Carve">
          {ready && (
            <>
              {!job ? (
                <p className="mt-1 text-xs text-amber-200">Make the toolpaths in step 4 first.</p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-slate-400">
                    One continuous carve, about {minutesText(job.estMinutes)}. Turn on dust collection and keep
                    this page open.
                  </p>
                  <button
                    type="button"
                    className={`${primary} mt-2 px-6 py-3 text-base`}
                    disabled={s.busy !== null || (unfinished && !!saved)}
                    onClick={() =>
                      void machine.startCarve({
                        id: `${job.name}-${Date.now()}`,
                        name: job.name,
                        bitLabel: job.bitLabel,
                        gcode: job.gcode,
                        lineCount: job.lineCount,
                        restartPoints: job.restartPoints,
                        sections: job.sections,
                        estMinutes: job.estMinutes,
                        sectionMinutes: job.sectionMinutes,
                        spindleS: job.spindleS,
                      })
                    }
                  >
                    Start carving
                  </button>
                  {!s.traced && <p className="mt-1 text-[11px] text-slate-500">Tip: trace the outline first.</p>}
                  {unfinished && saved && (
                    <p className="mt-1 text-[11px] text-amber-200">Finish or forget the unfinished carving above first.</p>
                  )}
                </>
              )}
            </>
          )}
        </Row>
      </ol>

      {s.connected && (
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>Machine: {s.status || "…"}</span>
          <button type="button" className="underline" onClick={() => void machine.disconnect()} disabled={s.busy !== null}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ n, done, title, children }: { n: number; done: boolean; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-emerald-500 text-white" : "bg-slate-700 text-slate-200"}`}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${done ? "text-slate-400" : "text-white"}`}>{title}</p>
        {children}
      </div>
    </li>
  );
}

function JogPad({
  machine,
  disabled,
  step,
  setStep,
}: {
  machine: CarveMachine;
  disabled: boolean;
  step: number;
  setStep: (n: number) => void;
}) {
  const b =
    "h-11 w-11 rounded-lg border border-white/15 bg-slate-800 text-lg text-white hover:bg-slate-700 active:bg-slate-600 disabled:opacity-40";
  const j = (axis: "X" | "Y" | "Z", dir: 1 | -1) => () => void machine.jog(axis, dir * step);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="grid grid-cols-3 gap-1.5">
        <span />
        <button type="button" className={b} disabled={disabled} onClick={j("Y", 1)} aria-label="Move away from you">
          ↑
        </button>
        <span />
        <button type="button" className={b} disabled={disabled} onClick={j("X", -1)} aria-label="Move left">
          ←
        </button>
        <span className="flex items-center justify-center text-[10px] text-slate-500">bit</span>
        <button type="button" className={b} disabled={disabled} onClick={j("X", 1)} aria-label="Move right">
          →
        </button>
        <span />
        <button type="button" className={b} disabled={disabled} onClick={j("Y", -1)} aria-label="Move toward you">
          ↓
        </button>
        <span />
      </div>
      <div className="flex flex-col gap-1.5">
        <button type="button" className={`${b} w-16 text-sm`} disabled={disabled} onClick={j("Z", 1)}>
          Up
        </button>
        <button type="button" className={`${b} w-16 text-sm`} disabled={disabled} onClick={j("Z", -1)}>
          Down
        </button>
      </div>
      <div className="flex flex-col gap-1 text-xs text-slate-300">
        <span className="text-slate-500">Step</span>
        {[10, 1, 0.1].map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setStep(v)}
            className={`rounded-md px-2 py-1 ${step === v ? "bg-teal-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
          >
            {v} mm
          </button>
        ))}
      </div>
    </div>
  );
}

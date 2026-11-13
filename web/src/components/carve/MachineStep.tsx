"use client";

import { CarveMachine, type MachineState } from "@/lib/carveMachine";
import { clearCarve, loadCarve, loadProgress, restartLineFor, type SavedCarve } from "@/lib/carveStore";
import type { BitShape, CarveProgram } from "@/lib/relief/reliefCam";
import { JogPad } from "./JogPad";
import { LiveCarveView } from "./LiveCarveView";
import { SpeedCheck } from "./SpeedCheck";
import { loadFactor } from "@/lib/carveTime";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

type Props = {
  machine: CarveMachine;
  /** The carve made in step 4 (null until toolpaths exist). */
  job:
    | (CarveProgram & {
        name: string;
        bitLabel: string;
        spindleS: number;
        bit: BitShape;
        area: { minX: number; maxX: number; minY: number; maxY: number };
        timeline: number[];
      })
    | null;
};

const DEFAULT_BIT: BitShape = { type: "vee", halfAngleDeg: 10, tipDiameterMm: 0.1, diameterMm: 3.175 };

/** Machined area from the program itself (for carves saved before the area was stored). */
function areaFromGcode(gcode: string) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const m of gcode.matchAll(/^G1 X(-?[\d.]+) Y(-?[\d.]+)/gm)) {
    const x = Number(m[1]), y = Number(m[2]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : { minX: -20, maxX: 20, minY: -20, maxY: 20 };
}

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
  // Learned time correction, read fresh each render (not cached by the compiler).
  const timeFactor = useSyncExternalStore(noopSubscribe, () => loadFactor()?.factor ?? 1, () => 1);
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
    const src = s.carve ?? (saved && saved.lineCount === p.total ? saved : job && job.lineCount === p.total ? job : null);
    const est = src?.estMinutes ?? 0;
    const sectionMinutes = src?.sectionMinutes ?? null;
    const done = src && sectionMinutes ? minutesDone({ sections: src.sections, sectionMinutes, lineCount: src.lineCount }, p.line) : 0;
    const pct = Math.min(100, (100 * p.line) / Math.max(1, p.total));
    const carve = s.carve;
    return (
      <div className="space-y-4">
        {carve && (
          <LiveCarveView
            carveId={carve.id}
            gcode={carve.gcode}
            bit={carve.bit ?? DEFAULT_BIT}
            area={carve.area ?? areaFromGcode(carve.gcode)}
            line={p.line}
            wpos={s.wpos}
            paused={s.paused}
          />
        )}
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-white">
              {s.paused ? "Paused" : s.pausing ? "Pausing…" : s.busy === "stopping" ? "Stopping…" : p.section || "Carving"}
            </span>
            <span className="text-slate-300">{pct.toFixed(0)}%</span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          {p.etaMinutes !== null ? (
            <p className="mt-1.5 text-xs text-slate-400">About {minutesText(p.etaMinutes)} left</p>
          ) : (
            est > 0 &&
            sectionMinutes && <p className="mt-1.5 text-xs text-slate-400">About {minutesText(est - done)} left</p>
          )}
        </div>
        {s.notice && <p className={`rounded-xl border p-3 text-sm ${TONE[s.notice.tone]}`}>{s.notice.text}</p>}
        <CarveControls machine={machine} s={s} size="large" />
        <p className="text-xs text-slate-500">
          Pause finishes the pass it&apos;s on, lifts the bit and turns the spindle off — your place is kept
          even if the computer sleeps or the power goes out. STOP is for emergencies and cancels the job.
        </p>
      </div>
    );
  }

  // ---------- setup checklist ----------
  return (
    <div className="space-y-4">
      {s.finishedCarve && (
        <div className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3">
          <LiveCarveView
            carveId={`${s.finishedCarve.id}-done`}
            gcode={s.finishedCarve.gcode}
            bit={s.finishedCarve.bit ?? DEFAULT_BIT}
            area={s.finishedCarve.area ?? areaFromGcode(s.finishedCarve.gcode)}
            line={s.finishedCarve.lineCount + 100}
            wpos={null}
            paused
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-emerald-100">Finished: {s.finishedCarve.name}</p>
            <button
              type="button"
              className={secondary}
              onClick={() => machine.dismissFinished()}
            >
              Done
            </button>
          </div>
        </div>
      )}
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
              Restarts at line {restartLineFor(saved, progress) + 1} of {saved.lineCount}.
            </p>
          )}
        </div>
      )}

      {s.notice && <p className={`rounded-xl border p-3 text-sm ${TONE[s.notice.tone]}`}>{s.notice.text}</p>}

      {s.connected && s.speedCheck.phase !== "off" && <SpeedCheck machine={machine} s={s} />}

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
              {s.grbl && s.speedCheck.phase === "off" && s.busy === null && (
                <button
                  type="button"
                  onClick={() => machine.openSpeedCheck()}
                  className={`mt-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${settingsProblems.some((i) => i.id === "accel") ? "bg-teal-600 text-white" : "border border-white/15 text-slate-300"}`}
                >
                  Speed check — carve faster safely
                </button>
              )}
              {settingsProblems.map((it) => (
                <p key={it.id} className={it.status === "problem" ? "text-rose-300" : "text-amber-200"}>
                  {it.status === "problem" ? "✕" : "!"} {it.title}. {it.detail}{" "}
                  {it.fix && (it.fix === "$32=0" || it.fix === "$13=0" || it.id === "zslip") && (
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
                    One continuous carve, about {minutesText(job.estMinutes * timeFactor)}. Turn on dust collection and keep
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
                        bit: job.bit,
                        area: job.area,
                        timeline: job.timeline,
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

/** Pause / Resume and the emergency STOP. Used in step 5 and in the bar along the bottom. */
export function CarveControls({ machine, s, size }: { machine: CarveMachine; s: MachineState; size: "large" | "small" }) {
  const carving = s.busy === "carving";
  const big = size === "large";
  const base = `rounded-xl font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${big ? "px-5 py-3 text-sm" : "px-3 py-1.5 text-xs"}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {carving &&
        (s.paused || s.pausing ? (
          <button
            type="button"
            className={`${base} bg-gradient-to-r from-teal-500 to-emerald-600 text-white shadow-lg`}
            onClick={() => void machine.resume()}
          >
            {s.pausing ? "Keep going" : "Resume"}
          </button>
        ) : (
          <button type="button" className={`${base} border border-white/20 bg-slate-800 text-white hover:bg-slate-700`} onClick={() => void machine.pause()}>
            Pause
          </button>
        ))}
      <StopButton machine={machine} s={s} big={big} />
    </div>
  );
}

/** One press, no questions: stops motion and the spindle at once. */
export function StopButton({ machine, s, big }: { machine: CarveMachine; s: MachineState; big: boolean }) {
  const jobActive = s.busy === "carving";
  return (
    <button
      type="button"
      disabled={!s.connected || s.busy === "stopping"}
      onClick={() => void machine.emergencyStop()}
      className={`flex flex-col items-center rounded-xl bg-rose-600 font-bold text-white shadow-lg shadow-rose-950/50 ring-2 ring-rose-400/40 hover:bg-rose-500 disabled:opacity-40 ${big ? "px-5 py-2" : "px-3 py-1"}`}
    >
      <span className={big ? "text-sm tracking-wider" : "text-xs tracking-wider"}>■ STOP</span>
      {jobActive && <span className={`font-medium text-rose-100 ${big ? "text-[11px]" : "text-[9px]"}`}>cancels the job</span>}
    </button>
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

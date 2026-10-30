/**
 * Plain-English check of GRBL `$$` settings for carving on a 3018-class machine.
 * Reads only — never changes a setting.
 */

export type GrblSettings = Record<number, number>;

export type MachineCheckItem = {
  id: string;
  status: "ok" | "warn" | "problem";
  title: string;
  detail: string;
  /** Command the user can type to fix it, when there is a safe one. */
  fix?: string;
};

/** Parse lines like `$30=1000` (GRBL 1.1 may append `(comment)` on old builds). */
export function parseGrblSettingLine(line: string): [number, number] | null {
  const m = /^\$(\d+)=(-?\d+(?:\.\d+)?)/.exec(line.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

export function checkMachineSettings(s: GrblSettings): MachineCheckItem[] {
  const out: MachineCheckItem[] = [];
  const has = (k: number) => Number.isFinite(s[k]);

  if (has(32)) {
    out.push(
      s[32] === 1
        ? {
            id: "laser",
            status: "problem",
            title: "Laser mode is ON",
            detail:
              "In laser mode GRBL stops the spindle during fast moves, so the bit can enter the wood barely spinning. Turn it off before carving (turn it back on only when using a laser module).",
            fix: "$32=0",
          }
        : { id: "laser", status: "ok", title: "Laser mode is off", detail: "Right for carving with a spindle." },
    );
  }

  if (has(22)) {
    const homing = (s[22] & 1) === 1;
    out.push(
      homing
        ? {
            id: "homing",
            status: "ok",
            title: "Homing is on",
            detail: "After any stop, homing puts your zero back exactly where it was.",
          }
        : {
            id: "homing",
            status: "warn",
            title: "Homing is off",
            detail:
              "Without homing, a reset or USB drop loses your zero and the piece. The 3018-PROVer has limit switches, so homing can usually be turned on.",
            fix: "$22=1",
          },
    );
  }

  if (has(30)) {
    const v = s[30];
    out.push(
      v === 1000 || v === 10000 || v === 12000
        ? {
            id: "spindle",
            status: "ok",
            title: `Spindle full speed is set to S${v}`,
            detail:
              "CNCarve engine jobs ask for full speed; GRBL caps it at this number, so the spindle runs flat out.",
          }
        : {
            id: "spindle",
            status: "warn",
            title: `Spindle maximum is an unusual S${v}`,
            detail:
              "The 3018-PROVer normally uses 1000. CNCarve engine jobs still run at full speed, but Kiri jobs may run slower than intended.",
          },
    );
  }

  const rates = [110, 111, 112].filter(has);
  if (rates.length) {
    const slow = rates.filter((k) => s[k] < (k === 112 ? 200 : 600));
    out.push(
      slow.length
        ? {
            id: "rates",
            status: "warn",
            title: "Some speed limits are very low",
            detail: `Max speed X ${s[110] ?? "?"}, Y ${s[111] ?? "?"}, Z ${s[112] ?? "?"} mm/min. Jobs will run slower than their estimates.`,
          }
        : {
            id: "rates",
            status: "ok",
            title: "Speed limits are fine",
            detail: `Max speed X ${s[110]}, Y ${s[111]}, Z ${s[112]} mm/min.`,
          },
    );
  }

  if (has(100) && has(101)) {
    out.push(
      Math.abs(s[100] - s[101]) < 1e-6
        ? {
            id: "steps",
            status: "ok",
            title: "X and Y scaling match",
            detail: `${s[100]} steps/mm on both — carvings won't come out stretched.`,
          }
        : {
            id: "steps",
            status: "warn",
            title: "X and Y scaling differ",
            detail: `X is ${s[100]} and Y is ${s[101]} steps/mm. On a 3018 they are normally the same; if not on purpose, carvings will be stretched one way.`,
          },
    );
  }

  if (has(13) && s[13] === 1) {
    out.push({
      id: "inches",
      status: "warn",
      title: "Positions are shown in inches",
      detail: "Jobs still run in millimetres, but the position read-out will be in inches.",
      fix: "$13=0",
    });
  }

  return out;
}

export function summarizeMachineCheck(items: MachineCheckItem[]): "ok" | "warn" | "problem" {
  if (items.some((i) => i.status === "problem")) return "problem";
  if (items.some((i) => i.status === "warn")) return "warn";
  return "ok";
}

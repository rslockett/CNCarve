/**
 * Minimal GRBL sender over Web Serial API (Chrome / Edge).
 */

export type SerialWireStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; portLabel: string }
  | { kind: "streaming"; line: number; total: number }
  | { kind: "error"; message: string };

const BAUD = 115200;

export class GrblSerial {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private textDecoder = new TextDecoder();
  private rxBuf = "";
  private ackResolvers: Array<(ok: boolean, msg?: string) => void> = [];

  /**
   * Reject every in-flight `waitAck` (e.g. stuck mid–G-code stream). Replacing the array with `[]`
   * orphans those Promises forever and can make Unlock / Soft reset feel dead while the writer is wedged.
   */
  private rejectAllPendingAcks(reason: string): void {
    const pending = this.ackResolvers.splice(0, this.ackResolvers.length);
    for (const res of pending) {
      res(false, reason);
    }
  }

  isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.serial;
  }

  async connect(): Promise<void> {
    if (!this.isSupported()) {
      throw new Error("Web Serial is not available. Use Chrome or Edge on desktop.");
    }
    this.ackResolvers = [];
    const serial = navigator.serial;
    if (!serial) {
      throw new Error("Web Serial is not available.");
    }
    this.port = await serial.requestPort({});
    await this.port.open({ baudRate: BAUD });
    this.writer = this.port.writable!.getWriter();
    this.reader = this.port.readable!.getReader();
    void this.pumpRead();
  }

  async disconnect(): Promise<void> {
    this.rejectAllPendingAcks("disconnected");
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    this.reader = null;
    try {
      await this.writer?.close();
    } catch {
      /* ignore */
    }
    this.writer = null;
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
  }

  private async pumpRead(): Promise<void> {
    if (!this.reader) return;
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.rxBuf += this.textDecoder.decode(value, { stream: true });
          const lines = this.rxBuf.split(/\r?\n/);
          this.rxBuf = lines.pop() ?? "";
          for (const line of lines) {
            const ln = line.trim();
            if (!ln) continue;
            const low = ln.toLowerCase();
            if (low.startsWith("ok") || low.startsWith("error")) {
              const res = this.ackResolvers.shift();
              res?.(!low.startsWith("error"), ln);
            }
            this.onLine?.(ln);
          }
        }
      }
    } catch {
      /* disconnected */
    }
  }

  onLine?: (line: string) => void;

  async sendRaw(line: string): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    const enc = new TextEncoder();
    await this.writer.write(enc.encode(line + "\n"));
  }

  /** GRBL realtime command, no newline (e.g. ?, !, ~, 0x18). */
  async sendRealtime(command: "?" | "!" | "~"): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    const enc = new TextEncoder();
    await this.writer.write(enc.encode(command));
  }

  /** Raw bytes (no newline) — for GRBL realtime commands like soft reset 0x18. */
  async writeBytes(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(data);
  }

  /** Send one line and wait for ok/error (ordering-safe). */
  async sendCommand(line: string): Promise<void> {
    await this.sendRaw(line);
    await this.waitAck();
  }

  /**
   * GRBL realtime soft reset (Ctrl+X, byte 0x18). Do not append newline.
   * After this, flush any stale ok/error waiters — responses may be startup text, not ok.
   */
  async softReset(): Promise<void> {
    this.rejectAllPendingAcks("soft reset (Ctrl+X)");
    await this.writeBytes(new Uint8Array([0x18]));
  }

  /**
   * Clear GRBL alarm lock. Many boards ignore `$X` until after a realtime soft reset, so we send
   * 0x18, wait for boot text, then `$X` (same practical sequence as Candle when alarm won’t clear).
   */
  async unlockAlarm(): Promise<void> {
    this.rejectAllPendingAcks("alarm unlock");
    await this.writeBytes(new Uint8Array([0x18]));
    await new Promise((r) => window.setTimeout(r, 450));
    await this.sendCommand("$X");
  }

  /** Wait for one ok/error after sending a command */
  private waitAck(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = window.setTimeout(() => {
        reject(new Error("GRBL did not respond in time."));
      }, timeoutMs);
      this.ackResolvers.push((ok, msg) => {
        window.clearTimeout(t);
        if (ok) resolve();
        else reject(new Error(msg ?? "GRBL error"));
      });
    });
  }

  /** Stream G-code: one line at a time after ok */
  async streamGcode(
    gcode: string,
    onProgress?: (i: number, total: number) => void,
    shouldAbort?: () => boolean,
  ): Promise<void> {
    const stripComments = (line: string) => {
      const noParen = line.replace(/\([^)]*\)/g, "");
      const semi = noParen.indexOf(";");
      return semi >= 0 ? noParen.slice(0, semi).trim() : noParen.trim();
    };

    const lines = gcode
      .split(/\r?\n/)
      .map(stripComments)
      .filter((l) => l.length > 0 && l !== "%");

    for (let i = 0; i < lines.length; i++) {
      if (shouldAbort?.()) break;
      const line = lines[i];
      try {
        await this.sendCommand(line);
      } catch (error) {
        const base = error instanceof Error ? error.message : String(error);
        throw new Error(`Stopped near line ${i + 1}/${lines.length}: ${line} (${base})`);
      }
      onProgress?.(i + 1, lines.length);
    }
  }
}

"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { WizardAnswers } from "@/lib/presets/types";
import type { PatternSize } from "@/lib/stockTransform";
import { defaultWizardAnswers } from "@/lib/wizard";

type AppCtx = {
  answers: WizardAnswers;
  setAnswers: React.Dispatch<React.SetStateAction<WizardAnswers>>;
  stlFile: File | null;
  setStlFile: (f: File | null) => void;
  stlBuffer: ArrayBuffer | null;
  setStlBuffer: (b: ArrayBuffer | null) => void;
  stlNativeSize: PatternSize | null;
  setStlNativeSize: (s: PatternSize | null) => void;
  exportedGcode: string;
  setExportedGcode: React.Dispatch<React.SetStateAction<string>>;
  serialLog: string[];
  appendSerialLog: (line: string) => void;
  clearSerialLog: () => void;
};

const Ctx = createContext<AppCtx | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [answers, setAnswers] = useState<WizardAnswers>(defaultWizardAnswers());
  const [stlFile, setStlFile] = useState<File | null>(null);
  const [stlBuffer, setStlBuffer] = useState<ArrayBuffer | null>(null);
  const [stlNativeSize, setStlNativeSize] = useState<PatternSize | null>(null);
  const [exportedGcode, setExportedGcode] = useState("");
  const [serialLog, setSerialLog] = useState<string[]>([]);

  const appendSerialLog = useCallback((line: string) => {
    setSerialLog((prev) => [...prev.slice(-400), line]);
  }, []);

  const clearSerialLog = useCallback(() => setSerialLog([]), []);

  const value = useMemo(
    () =>
      ({
        answers,
        setAnswers,
        stlFile,
        setStlFile,
        stlBuffer,
        setStlBuffer,
        stlNativeSize,
        setStlNativeSize,
        exportedGcode,
        setExportedGcode,
        serialLog,
        appendSerialLog,
        clearSerialLog,
      }) satisfies AppCtx,
    [
      answers,
      stlFile,
      stlBuffer,
      stlNativeSize,
      exportedGcode,
      serialLog,
      appendSerialLog,
      clearSerialLog,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState requires provider");
  return v;
}

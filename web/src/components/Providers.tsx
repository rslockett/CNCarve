"use client";

import { AppStateProvider } from "@/context/AppState";

export function Providers({ children }: { children: React.ReactNode }) {
  return <AppStateProvider>{children}</AppStateProvider>;
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { answer } from "./copilot";
import {
  createInitialWorld,
  placeOrder as placeOrderPure,
  tick,
  type OrderResult,
  type PersonaKey,
  type TraderKey,
  type World,
} from "./world";
import type { Side } from "./market";

const STORAGE_KEY = "nx-prototype-world";

type Ui = {
  traceOpen: boolean;
  traceRunId: string | null;
  copilotOpen: boolean;
  copilotSiteId: string | null;
  copilotTyping: boolean;
};

type Store = {
  world: World;
  hydrated: boolean;
  act: (fn: (w: World) => World) => void;
  setPersona: (p: PersonaKey) => void;
  placeOrder: (
    trader: TraderKey,
    siteId: string,
    side: Side,
    units: number,
  ) => OrderResult;
  reset: () => void;
  ui: Ui;
  openTrace: (runId?: string | null) => void;
  closeTrace: () => void;
  openCopilot: (siteId?: string | null) => void;
  closeCopilot: () => void;
  ask: (question: string, siteId: string | null) => void;
};

const Ctx = createContext<Store | null>(null);

function load(): World | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as World;
    return parsed.schema === 3 ? parsed : null;
  } catch {
    return null;
  }
}

function save(world: World) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(world));
  } catch {
    // Private mode or full storage: the demo still works for this tab.
  }
}

export function PrototypeProvider({ children }: { children: ReactNode }) {
  const [world, setWorld] = useState<World>(() => createInitialWorld());
  const [hydrated, setHydrated] = useState(false);
  const worldRef = useRef(world);
  worldRef.current = world;
  const [ui, setUi] = useState<Ui>({
    traceOpen: false,
    traceRunId: null,
    copilotOpen: false,
    copilotSiteId: null,
    copilotTyping: false,
  });

  useEffect(() => {
    const stored = load();
    if (stored) setWorld(stored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) save(world);
  }, [world, hydrated]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setWorld((w) => tick(w, Date.now() & 0xffff));
    }, 9000);
    return () => window.clearInterval(id);
  }, []);

  const act = useCallback(
    (fn: (w: World) => World) => setWorld((w) => fn(w)),
    [],
  );

  const placeOrder = useCallback(
    (trader: TraderKey, siteId: string, side: Side, units: number) => {
      const result = placeOrderPure(
        worldRef.current,
        trader,
        siteId,
        side,
        units,
      );
      if (result.ok) {
        worldRef.current = result.world;
        setWorld(result.world);
      }
      return result;
    },
    [],
  );

  const reset = useCallback(() => {
    setWorld((w) => createInitialWorld(w.persona));
    setUi((u) => ({ ...u, traceOpen: false, copilotOpen: false }));
  }, []);

  const ask = useCallback((question: string, siteId: string | null) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setWorld((w) => ({
      ...w,
      seq: w.seq + 1,
      copilot: [
        ...w.copilot,
        {
          id: `msg-${w.seq + 1}`,
          role: "user",
          text: trimmed,
          siteId,
          citations: [],
        },
      ],
    }));
    setUi((u) => ({ ...u, copilotTyping: true }));
    window.setTimeout(() => {
      setWorld((w) => {
        const reply = answer(w, trimmed, siteId);
        return {
          ...w,
          seq: w.seq + 1,
          copilot: [
            ...w.copilot,
            {
              id: `msg-${w.seq + 1}`,
              role: "assistant",
              text: reply.text,
              siteId,
              citations: reply.citations,
            },
          ],
        };
      });
      setUi((u) => ({ ...u, copilotTyping: false }));
    }, 900);
  }, []);

  const value = useMemo<Store>(
    () => ({
      world,
      hydrated,
      act,
      setPersona: (p) => setWorld((w) => ({ ...w, persona: p })),
      placeOrder,
      reset,
      ui,
      openTrace: (runId = null) =>
        setUi((u) => ({
          ...u,
          traceOpen: true,
          traceRunId: runId,
          copilotOpen: false,
        })),
      closeTrace: () => setUi((u) => ({ ...u, traceOpen: false })),
      openCopilot: (siteId = null) =>
        setUi((u) => ({
          ...u,
          copilotOpen: true,
          copilotSiteId: siteId,
          traceOpen: false,
        })),
      closeCopilot: () => setUi((u) => ({ ...u, copilotOpen: false })),
      ask,
    }),
    [world, hydrated, act, placeOrder, reset, ui, ask],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrototype() {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("usePrototype must be used inside <PrototypeProvider>");
  return ctx;
}

export function useSite(id: string) {
  const { world } = usePrototype();
  return world.sites.find((s) => s.id === id);
}

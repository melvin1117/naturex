/**
 * World bootstrap: the one place that knows how the app learns its world. The backend derives
 * the world from the `nx_session` cookie (ADR-0005 §2, T73): anonymous visitors and password
 * accounts read the live world, a demo session its own sandbox. `GET /world` returns that
 * world plus `me` (the signed-in account, or null). Screens, hooks and the API client go
 * through this module, so session changes (T55 demo sessions) stay here.
 */
import type { components } from "./api/schema";
import { toApiError, type ApiError } from "./api/errors";

export type World = components["schemas"]["WorldOut"];

/** The route that returns the session's world and the signed-in account. Sets no cookie. */
export const BOOTSTRAP_PATH = "/world";

/** Cookies a server-side fetch forwards to the backend (the world comes from the session). */
export const SESSION_COOKIES = ["nx_session"] as const;

/**
 * 401 `detail` codes that mean "re-read the world, then retry once" (deps.py AUTH_REQUIRED).
 * A signed-in request gets one only if its session ended (signed out elsewhere, expired, or
 * its demo sandbox was pruned); re-reading `GET /world` updates `world` and `me` so the app
 * sees it's signed out, and the retry returns the 401 to the caller if it still is.
 */
const SESSION_EXPIRED_CODES: ReadonlySet<string> = new Set(["auth_required"]);

export function isSessionExpired(status: number, body: unknown): boolean {
  if (status !== 401 || !body || typeof body !== "object") return false;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === "string" && SESSION_EXPIRED_CODES.has(detail);
}

/** Reads a clone, so the caller can still consume `response`. */
export async function isSessionExpiredResponse(
  response: Response,
): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    return isSessionExpired(401, await response.clone().json());
  } catch {
    return false;
  }
}

/** The subset of Next.js `ReadonlyRequestCookies` we need; easy to fake in tests. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * The `Cookie` header a server-side fetch sends so the backend sees the visitor's session.
 * Only the session cookies are forwarded, never the visitor's other cookies.
 */
export function forwardedCookieHeader(
  cookies: CookieReader,
): string | undefined {
  const pairs = SESSION_COOKIES.flatMap((name) => {
    const value = cookies.get(name)?.value;
    return value ? [`${name}=${value}`] : [];
  });
  return pairs.length ? pairs.join("; ") : undefined;
}

export type SessionStatus = "idle" | "loading" | "ready" | "error";

export interface SessionState {
  status: SessionStatus;
  world: World | null;
  error: ApiError | null;
}

export interface SessionBootstrap {
  /** Resolve once the world exists. Single-flight: concurrent callers share one request. */
  ensure(): Promise<World>;
  /**
   * Bootstrap again after a 401 `auth_required`. Pass the `generation` the failing request
   * was sent under: if another caller already re-bootstrapped since then, no new request.
   */
  refresh(sentUnderGeneration?: number): Promise<World>;
  /** Bumps on every successful bootstrap. */
  readonly generation: number;
  /** Replace the world (e.g. after `POST /world/reset`). */
  set(world: World): void;
  getSnapshot(): SessionState;
  subscribe(listener: () => void): () => void;
}

const IDLE: SessionState = { status: "idle", world: null, error: null };

export function createSessionBootstrap(
  load: () => Promise<World>,
): SessionBootstrap {
  let state = IDLE;
  let inflight: Promise<World> | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  function setState(next: SessionState) {
    state = next;
    listeners.forEach((listener) => listener());
  }

  function run(): Promise<World> {
    if (inflight) return inflight;
    if (state.status !== "ready") {
      setState({ status: "loading", world: state.world, error: null });
    }
    inflight = load()
      .then((world) => {
        generation += 1;
        setState({ status: "ready", world, error: null });
        return world;
      })
      .catch((error: unknown) => {
        const apiError = toApiError(error);
        // A failed re-bootstrap keeps the app mounted; the failing request reports it.
        setState({
          status: state.world ? "ready" : "error",
          world: state.world,
          error: apiError,
        });
        throw apiError;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    ensure() {
      if (state.status === "ready" && state.world)
        return Promise.resolve(state.world);
      return run();
    },
    refresh(sentUnderGeneration) {
      const alreadyRefreshed =
        sentUnderGeneration !== undefined && sentUnderGeneration !== generation;
      if (alreadyRefreshed && state.world && !inflight) {
        return Promise.resolve(state.world);
      }
      return run();
    },
    get generation() {
      return generation;
    },
    set(world) {
      setState({ status: "ready", world, error: null });
    },
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

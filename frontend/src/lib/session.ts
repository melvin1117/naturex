/**
 * World (and, from T55, session) bootstrap: the one place that knows how the visitor gets a
 * sandbox world. Today that's `GET /world`, which sets the `nx_world` cookie. ADR-0005 / T55
 * replace the cookie with an `nx_session` session; when that lands, only this module (the
 * bootstrap path, the cookie names and the "expired" codes) should need to change: screens,
 * hooks and the API client go through it.
 */
import type { components } from "./api/schema";
import { toApiError, type ApiError } from "./api/errors";

export type World = components["schemas"]["WorldOut"];

/** The route that creates or returns the visitor's world (and sets its cookie). */
export const BOOTSTRAP_PATH = "/world";

/** Cookies a server-side fetch forwards to the backend. `nx_session` arrives with T55. */
export const SESSION_COOKIES = ["nx_world", "nx_session"] as const;

/** 401 `detail` codes that mean "bootstrap again, then retry" (deps.py WORLD_REQUIRED). */
const SESSION_EXPIRED_CODES: ReadonlySet<string> = new Set(["world_required"]);

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
 * The `Cookie` header a server-side fetch sends so the backend sees the visitor's world.
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
   * Bootstrap again after a 401 `world_required`. Pass the `generation` the failing request
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

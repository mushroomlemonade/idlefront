import { z } from "zod";
import {
  NewPersistentWorldControllerSessionSchema,
  PersistentWorldCardSchema,
  PersistentWorldControllerSessionSchema,
  PersistentWorldLobbySnapshotSchema,
  PersistentWorldReminderSelectionSchema,
  type CreatePersistentWorldRequest,
  type NewPersistentWorldControllerSession,
  type PersistentWorldCard,
  type PersistentWorldControllerSession,
  type PersistentWorldLobbySnapshot,
  type PersistentWorldReminderSelection,
} from "../core/PersistentWorldSchemas";

const SESSION_TOKEN_KEY = "pressure-atlas.world-controller.v1";
const INVITATION_KEY_PREFIX = "pressure-atlas.world-invitation.v1.";

const CreatedPersistentWorldResponseSchema = z
  .object({
    snapshot: PersistentWorldLobbySnapshotSchema,
    invitationSecret: z.string().min(16).max(512).nullable(),
  })
  .strict();

const GameplayIdentityBindingResponseSchema = z
  .object({
    bound: z.literal(true),
    playToken: z.string().min(1).optional(),
  })
  .strict();

export interface CreatedPersistentWorldResponse {
  snapshot: PersistentWorldLobbySnapshot;
  invitationSecret: string | null;
}

export class PersistentWorldApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PersistentWorldApiError";
  }
}

function safeStorage(
  storage: Storage,
  operation: (storage: Storage) => string | void | null,
): string | void | null {
  try {
    return operation(storage);
  } catch {
    return null;
  }
}

export function invitationStorageKey(worldId: string): string {
  return `${INVITATION_KEY_PREFIX}${worldId}`;
}

export function invitationFromHash(hash: string): string | null {
  if (!hash.startsWith("#")) return null;
  const value = new URLSearchParams(hash.slice(1)).get("invite");
  return value && value.length >= 16 ? value : null;
}

/**
 * Invitation credentials arrive after `#`, so they are never sent in the
 * initial HTTP request. Move the credential into tab-scoped storage and scrub
 * it from the address bar before any user interaction or analytics event.
 */
export function consumeInvitationFragment(worldId: string): string | null {
  const fromHash = invitationFromHash(window.location.hash);
  if (fromHash) {
    safeStorage(window.sessionStorage, (storage) =>
      storage.setItem(invitationStorageKey(worldId), fromHash),
    );
    history.replaceState(
      history.state,
      "",
      window.location.pathname + window.location.search,
    );
    return fromHash;
  }
  return (
    (safeStorage(window.sessionStorage, (storage) =>
      storage.getItem(invitationStorageKey(worldId)),
    ) as string | null) ?? null
  );
}

export function rememberInvitation(worldId: string, secret: string): void {
  safeStorage(window.sessionStorage, (storage) =>
    storage.setItem(invitationStorageKey(worldId), secret),
  );
}

export function invitationForWorld(worldId: string): string | null {
  return (
    (safeStorage(window.sessionStorage, (storage) =>
      storage.getItem(invitationStorageKey(worldId)),
    ) as string | null) ?? null
  );
}

export function persistentWorldShareUrl(
  worldId: string,
  invitationSecret?: string | null,
): string {
  const url = new URL(`/world/${encodeURIComponent(worldId)}`, window.origin);
  if (invitationSecret) {
    url.hash = new URLSearchParams({ invite: invitationSecret }).toString();
  }
  return url.toString();
}

export class PersistentWorldApi {
  constructor(private readonly basePath = "/api/worlds") {}

  rememberGameWorld(gameId: string, worldId: string): void {
    safeStorage(window.localStorage, (storage) =>
      storage.setItem(`idlefront.game-world.${gameId}`, worldId),
    );
  }

  worldForGame(gameId: string): string | null {
    return safeStorage(window.localStorage, (storage) =>
      storage.getItem(`idlefront.game-world.${gameId}`),
    ) as string | null;
  }

  sessionToken(): string | null {
    return (
      (safeStorage(window.localStorage, (storage) =>
        storage.getItem(SESSION_TOKEN_KEY),
      ) as string | null) ?? null
    );
  }

  forgetSession(): void {
    safeStorage(window.localStorage, (storage) =>
      storage.removeItem(SESSION_TOKEN_KEY),
    );
  }

  async createGuestSession(
    displayName: string,
  ): Promise<NewPersistentWorldControllerSession> {
    const created = await this.request(
      "/session",
      NewPersistentWorldControllerSessionSchema,
      {
        method: "POST",
        body: { displayName },
        authenticated: false,
      },
    );
    safeStorage(window.localStorage, (storage) =>
      storage.setItem(SESSION_TOKEN_KEY, created.bearerToken),
    );
    return created;
  }

  resumeSession(): Promise<PersistentWorldControllerSession> {
    return this.request("/session", PersistentWorldControllerSessionSchema, {
      authenticated: true,
    });
  }

  async bindGameIdentity(playToken: string): Promise<void> {
    await this.bindGameIdentityResponse(playToken);
  }

  async bindGameIdentityWithToken(playToken: string): Promise<string | null> {
    const result = await this.bindGameIdentityResponse(playToken);
    return result.playToken ?? null;
  }

  private async bindGameIdentityResponse(playToken: string): Promise<{
    bound: true;
    playToken?: string;
  }> {
    const result = await this.request(
      "/session/game-identity",
      GameplayIdentityBindingResponseSchema,
      {
        method: "POST",
        body: { playToken },
        authenticated: true,
      },
    );
    return result;
  }

  listPublic(): Promise<PersistentWorldCard[]> {
    return this.request("/public", z.array(PersistentWorldCardSchema), {
      authenticated: false,
      optionalAuthentication: true,
    });
  }

  listMine(): Promise<PersistentWorldCard[]> {
    return this.request("/mine", z.array(PersistentWorldCardSchema), {
      authenticated: true,
    });
  }

  createWorld(
    input: CreatePersistentWorldRequest,
  ): Promise<CreatedPersistentWorldResponse> {
    return this.request("", CreatedPersistentWorldResponseSchema, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  getSnapshot(
    worldId: string,
    invitationSecret?: string | null,
  ): Promise<PersistentWorldLobbySnapshot> {
    return this.request(
      `/${encodeURIComponent(worldId)}`,
      PersistentWorldLobbySnapshotSchema,
      {
        authenticated: false,
        optionalAuthentication: true,
        invitationSecret,
      },
    );
  }

  unlockWorld(
    worldId: string,
    password: string,
    displayName: string,
  ): Promise<{ unlocked: true }> {
    return this.request(
      `/${encodeURIComponent(worldId)}/unlock`,
      z.object({ unlocked: z.literal(true) }),
      {
        method: "POST",
        body: { password, displayName },
        authenticated: true,
      },
    );
  }

  worldPlayToken(worldId: string): Promise<{ playToken: string }> {
    return this.request(
      `/${encodeURIComponent(worldId)}/play-token`,
      z.object({ playToken: z.string() }),
      {
        method: "POST",
        body: {},
        authenticated: true,
      },
    );
  }

  rsvp(
    worldId: string,
    teamId?: string | null,
    invitationSecret?: string | null,
  ): Promise<PersistentWorldLobbySnapshot> {
    return this.request(
      `/${encodeURIComponent(worldId)}/rsvp`,
      PersistentWorldLobbySnapshotSchema,
      {
        method: "PUT",
        // Capabilities never enter JSON or a URL. The router accepts the
        // invitation only through the dedicated header below.
        body: { teamId: teamId ?? null },
        authenticated: true,
        invitationSecret,
      },
    );
  }

  async leave(worldId: string): Promise<void> {
    await this.requestWithoutResponse(`/${encodeURIComponent(worldId)}/rsvp`, {
      method: "DELETE",
      authenticated: true,
    });
  }

  async postQuickChat(worldId: string, phraseKey: string): Promise<void> {
    const id = this.randomId();
    await this.requestWithoutResponse(
      `/${encodeURIComponent(worldId)}/quick-chat`,
      {
        method: "POST",
        body: { id, phraseKey },
        authenticated: true,
      },
    );
  }

  setReminders(
    worldId: string,
    leadTimesMs: number[],
  ): Promise<PersistentWorldReminderSelection> {
    return this.request(
      `/${encodeURIComponent(worldId)}/reminders`,
      PersistentWorldReminderSelectionSchema,
      {
        method: "PUT",
        body: { leadTimesMs },
        authenticated: true,
      },
    );
  }

  startCustomWorld(worldId: string): Promise<PersistentWorldLobbySnapshot> {
    return this.request(
      `/${encodeURIComponent(worldId)}/start`,
      PersistentWorldLobbySnapshotSchema,
      { method: "POST", body: {}, authenticated: true },
    );
  }

  cancel(worldId: string): Promise<PersistentWorldLobbySnapshot> {
    return this.request(
      `/${encodeURIComponent(worldId)}/cancel`,
      PersistentWorldLobbySnapshotSchema,
      { method: "POST", body: {}, authenticated: true },
    );
  }

  /** Temporary development control; only the dev server exposes this route. */
  devEndWorld(worldId: string): Promise<void> {
    return this.requestWithoutResponse(
      `/${encodeURIComponent(worldId)}/dev-end`,
      { method: "POST", body: {}, authenticated: true },
    );
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions,
  ): Promise<T> {
    const response = await this.fetch(path, options);
    const value = await this.readJson(response);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      console.error(
        "Persistent-world response failed validation",
        parsed.error,
      );
      throw new PersistentWorldApiError(
        502,
        "INVALID_RESPONSE",
        "The world service returned an unexpected response",
      );
    }
    return parsed.data;
  }

  private async requestWithoutResponse(
    path: string,
    options: RequestOptions,
  ): Promise<void> {
    await this.fetch(path, options);
  }

  private async fetch(
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const token = this.sessionToken();
    if (options.authenticated && !token) {
      throw new PersistentWorldApiError(
        401,
        "SESSION_REQUIRED",
        "Choose a commander name to continue",
      );
    }

    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (token && (options.authenticated || options.optionalAuthentication)) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    if (options.invitationSecret) {
      headers.set("x-world-invite", options.invitationSecret);
    }

    const response = await fetch(this.basePath + path, {
      method: options.method ?? "GET",
      headers,
      credentials: "same-origin",
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw await this.toApiError(response);
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new PersistentWorldApiError(
        502,
        "INVALID_RESPONSE",
        "The world service returned an unreadable response",
      );
    }
  }

  private async toApiError(
    response: Response,
  ): Promise<PersistentWorldApiError> {
    let code = "WORLD_REQUEST_FAILED";
    let message = `World request failed (${response.status})`;
    try {
      const body = (await response.json()) as {
        code?: unknown;
        message?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      const payload = body.error ?? body;
      if (typeof payload.code === "string") code = payload.code;
      if (typeof payload.message === "string") message = payload.message;
    } catch {
      // The status remains useful even when an intermediary returned HTML.
    }
    return new PersistentWorldApiError(response.status, code, message);
  }

  private randomId(): string {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  authenticated: boolean;
  optionalAuthentication?: boolean;
  invitationSecret?: string | null;
}

export const persistentWorldApi = new PersistentWorldApi();

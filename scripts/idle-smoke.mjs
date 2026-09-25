#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 8_000;
const ADMIN_TOKEN = process.env.IDLE_ADMIN_TOKEN;

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.IDLE_BASE_URL ?? DEFAULT_BASE_URL,
    mode: "all",
    artifact: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-url") {
      options.baseUrl = argv[(index += 1)];
    } else if (value === "--seed") {
      options.mode = "seed";
      options.artifact = argv[(index += 1)];
    } else if (value === "--verify") {
      options.mode = "verify";
      options.artifact = argv[(index += 1)];
    } else if (value === "--help" || value === "-h") {
      console.log(`Usage:
  node scripts/idle-smoke.mjs [--base-url URL]
  node scripts/idle-smoke.mjs [--base-url URL] --seed ARTIFACT
  node scripts/idle-smoke.mjs [--base-url URL] --verify ARTIFACT

--seed runs the complete API smoke test and stores recovery data.
Restart the authority against the same database, then use --verify.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${String(value)}`);
    }
  }

  if (!options.baseUrl) throw new Error("--base-url requires a value");
  if (options.mode !== "all" && !options.artifact) {
    throw new Error(`--${options.mode} requires an artifact path`);
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, "");
  return options;
}

async function request(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} returned ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} did not return JSON (${contentType})`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} returned invalid JSON`,
    );
  }
}

async function waitForHealth(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await request(baseUrl, "/api/idle/health");
      assert.equal(
        typeof health,
        "object",
        "idle health response must be an object",
      );
      return health;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`idle authority did not become ready: ${String(lastError)}`);
}

async function checkAppShell(baseUrl) {
  const response = await fetch(`${baseUrl}/idle/index.html`, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(response.status, 200, "idle app shell must return HTTP 200");
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/html/i,
    "idle app shell must be HTML",
  );
  const html = await response.text();
  assert.ok(
    html.length > 500,
    "idle app shell must not be an empty/placeholder page",
  );

  const styleTag = html.match(
    /<link\b[^>]*\bhref=["']([^"']*style\.css(?:\?[^"']*)?)["'][^>]*>/i,
  );
  assert.ok(styleTag, "idle app shell must link style.css");
  const scriptTag = html.match(
    /<script\b[^>]*\bsrc=["']([^"']*app\.js(?:\?[^"']*)?)["'][^>]*>/i,
  );
  assert.ok(scriptTag, "idle app shell must load app.js");
  assert.ok(
    !/\btype=["']module["']/i.test(scriptTag[0]),
    "idle app.js must remain a classic script for the compatibility build",
  );

  const assets = [
    {
      url: new URL(styleTag[1], `${baseUrl}/idle/index.html`),
      contentType: /text\/css/i,
    },
    {
      url: new URL(scriptTag[1], `${baseUrl}/idle/index.html`),
      contentType: /(?:javascript|ecmascript)/i,
    },
  ];
  for (const asset of assets) {
    const assetResponse = await fetch(asset.url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.equal(
      assetResponse.status,
      200,
      `idle asset ${asset.url.pathname} must load`,
    );
    assert.match(
      assetResponse.headers.get("content-type") ?? "",
      asset.contentType,
      `idle asset ${asset.url.pathname} must have the expected content type`,
    );
    assert.ok(
      (await assetResponse.arrayBuffer()).byteLength > 100,
      `idle asset ${asset.url.pathname} must not be empty`,
    );
  }
}

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function firstString(value, paths) {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function normalizeSession(payload) {
  const playerId = firstString(payload, [
    "playerId",
    "player.id",
    "session.playerId",
    "session.player.id",
  ]);
  const sessionId = firstString(payload, ["sessionId", "session.id"]);
  const recoveryCode = firstString(payload, [
    "recoveryCode",
    "player.recoveryCode",
    "session.recoveryCode",
  ]);
  assert.ok(playerId, "session response must include playerId");
  assert.ok(sessionId, "session response must include sessionId");
  return { playerId, sessionId, recoveryCode };
}

function statePath(playerId) {
  const query = new URLSearchParams({ playerId });
  return `/api/idle/state?${query.toString()}`;
}

function getState(baseUrl, session) {
  return request(baseUrl, statePath(session.playerId), {
    headers: { authorization: `Bearer ${session.sessionId}` },
  });
}

function territoryObjects(state) {
  const collections = [
    state?.territories,
    state?.world?.territories,
    state?.state?.territories,
    state?.state?.world?.territories,
  ];
  for (const collection of collections) {
    if (Array.isArray(collection)) return collection;
    if (collection && typeof collection === "object") {
      return Object.entries(collection).map(([id, territory]) => ({
        id,
        ...territory,
      }));
    }
  }
  return [];
}

function chooseTargetTerritory(state, playerId) {
  const territories = territoryObjects(state);
  assert.ok(
    territories.length > 0,
    "state must contain at least one territory",
  );
  const ownerOf = (territory) =>
    territory.ownerPlayerId ??
    territory.ownerId ??
    territory.playerId ??
    territory.owner?.id;
  const target =
    territories.find((territory) => {
      const owner = ownerOf(territory);
      return typeof owner === "string" && owner !== playerId;
    }) ?? territories[0];
  const targetId = target.id ?? target.territoryId;
  assert.equal(
    typeof targetId,
    "string",
    "target territory must have a string id",
  );
  return targetId;
}

function collectTapProjection(value, path = "", result = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectTapProjection(item, `${path}[${index}]`, result),
    );
    return result;
  }
  if (!value || typeof value !== "object") return result;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (
      (typeof child === "number" || typeof child === "string") &&
      /(?:revision|influence|pressure|tap(?:s|count)|acceptedTaps)$/i.test(
        key,
      ) &&
      !/(?:timestamp|updatedAt|expiresAt|serverTime)/i.test(key)
    ) {
      result[childPath] = child;
    }
    collectTapProjection(child, childPath, result);
  }
  return result;
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]);
}

function assertTapAccepted(payload) {
  const explicitRejection =
    payload?.accepted === false ||
    payload?.outcome?.accepted === false ||
    payload?.ok === false ||
    ["rejected", "invalid", "error"].includes(payload?.status);
  assert.equal(explicitRejection, false, "first pressure tap must be accepted");
  if (payload?.outcome && typeof payload.outcome === "object") {
    assert.equal(
      payload.outcome.accepted,
      true,
      "tap outcome must be accepted",
    );
  }
}

function assertDuplicate(payload) {
  const duplicate =
    payload?.duplicate === true ||
    payload?.idempotent === true ||
    payload?.replayed === true ||
    ["duplicate", "idempotent", "replayed"].includes(payload?.status);
  assert.equal(
    duplicate,
    true,
    "duplicate tap response must identify the replay",
  );
}

function assertAdminSummary(payload) {
  assert.ok(
    payload && typeof payload === "object",
    "admin summary must be an object",
  );
  const projection = collectTapProjection(payload);
  const observedTapMetric =
    Number(payload?.volume?.total) >= 1 ||
    Object.entries(projection).some(
      ([key, value]) => /tap|pressure/i.test(key) && Number(value) >= 1,
    );
  assert.ok(
    observedTapMetric,
    "admin summary must report at least one tap metric",
  );
}

async function createSession(baseUrl, recovery) {
  const payload = await request(baseUrl, "/api/idle/session", {
    method: "POST",
    body: JSON.stringify(recovery ?? {}),
  });
  return normalizeSession(payload);
}

async function runSeed(baseUrl) {
  const session = await createSession(baseUrl);
  const initialState = await getState(baseUrl, session);
  const targetTerritoryId = chooseTargetTerritory(
    initialState,
    session.playerId,
  );
  const clientSeq = 1;
  const tapBody = {
    v: 1,
    playerId: session.playerId,
    sessionId: session.sessionId,
    clientSeq,
    targetTerritoryId,
    clientMonoMs: Math.round(performance.now()),
    pointerType: "touch",
    visibility: "visible",
    xNormQ: 500,
    yNormQ: 500,
  };

  const firstTap = await request(baseUrl, "/api/idle/tap", {
    method: "POST",
    body: JSON.stringify(tapBody),
  });
  assertTapAccepted(firstTap);
  const afterFirst = await getState(baseUrl, session);
  const beforeProjection = collectTapProjection(initialState);
  const firstProjection = collectTapProjection(afterFirst);
  assert.ok(
    changedKeys(beforeProjection, firstProjection).length > 0,
    "accepted tap must change authoritative influence, pressure, tap count, or revision",
  );

  const duplicateTap = await request(baseUrl, "/api/idle/tap", {
    method: "POST",
    body: JSON.stringify(tapBody),
  });
  assertDuplicate(duplicateTap);
  const afterDuplicate = await getState(baseUrl, session);
  const duplicateProjection = collectTapProjection(afterDuplicate);
  assert.deepEqual(
    duplicateProjection,
    firstProjection,
    "duplicate clientSeq must not change authoritative tap state",
  );

  assert.ok(
    ADMIN_TOKEN,
    "IDLE_ADMIN_TOKEN is required for the admin smoke assertion",
  );
  const adminSummary = await request(baseUrl, "/api/idle/admin/summary", {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assertAdminSummary(adminSummary);
  assert.ok(
    session.recoveryCode,
    "new session must return a recoveryCode for restart/cross-device recovery",
  );

  return {
    version: 1,
    playerId: session.playerId,
    recoveryCode: session.recoveryCode,
    targetTerritoryId,
    clientSeq,
    projection: firstProjection,
  };
}

async function runRestartVerification(baseUrl, artifact) {
  assert.equal(artifact?.version, 1, "unsupported smoke artifact version");
  assert.equal(
    typeof artifact.playerId,
    "string",
    "artifact is missing playerId",
  );
  assert.equal(
    typeof artifact.recoveryCode,
    "string",
    "artifact is missing recoveryCode",
  );
  const recovered = await createSession(baseUrl, {
    playerId: artifact.playerId,
    recoveryCode: artifact.recoveryCode,
  });
  assert.equal(
    recovered.playerId,
    artifact.playerId,
    "recovery changed player identity",
  );
  const state = await getState(baseUrl, recovered);
  const projection = collectTapProjection(state);

  for (const [key, expected] of Object.entries(artifact.projection)) {
    if (!/(?:influence|tap(?:s|count)|acceptedTaps|revision)$/i.test(key))
      continue;
    if (/revision$/i.test(key)) {
      assert.ok(
        Number(projection[key]) >= Number(expected),
        `durable state ${key} moved backwards across authority restart`,
      );
      continue;
    }
    assert.equal(
      projection[key],
      expected,
      `durable state ${key} changed across authority restart`,
    );
  }
  assert.ok(
    Object.keys(projection).length > 0,
    "recovered state must expose authoritative tap counters",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Idle smoke against ${options.baseUrl} (${options.mode})`);
  await waitForHealth(options.baseUrl);
  await checkAppShell(options.baseUrl);

  if (options.mode === "verify") {
    const artifact = JSON.parse(await readFile(options.artifact, "utf8"));
    await runRestartVerification(options.baseUrl, artifact);
  } else {
    const artifact = await runSeed(options.baseUrl);
    if (options.mode === "seed") {
      await writeFile(options.artifact, `${JSON.stringify(artifact)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        await chmod(options.artifact, 0o600);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
    }
  }

  console.log("Idle smoke passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

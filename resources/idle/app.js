(function () {
  "use strict";

  var API = {
    session: "/api/idle/session",
    state: "/api/idle/state",
    tap: "/api/idle/tap",
  };
  var STORAGE = {
    playerId: "pressureAtlas.playerId",
    recoveryCode: "pressureAtlas.recoveryCode",
    sessionId: "pressureAtlas.sessionId",
    clientSeq: "pressureAtlas.clientSeq",
    tapQueue: "pressureAtlas.tapQueue",
    cachedState: "pressureAtlas.cachedState",
  };
  var POLL_MS = 5000;
  var TAP_DELIVERY_INTERVAL_MS = 135;
  var MAX_QUEUED_TAPS = 5000;
  var MAX_ACTIVITY = 5;

  var model = {
    credentials: {
      playerId: safeRead(STORAGE.playerId),
      recoveryCode: safeRead(STORAGE.recoveryCode),
      sessionId: safeRead(STORAGE.sessionId),
    },
    state: null,
    supplyBase: 0,
    supplyBaseAt: Date.now(),
    influence: 0,
    online: false,
    canCommand: true,
    syncing: false,
    creatingSession: false,
    flushingTaps: false,
    tapRetryTimer: null,
    tapDrainTimer: null,
    tapQueue: readJSON(STORAGE.tapQueue, []),
    clientSeq: parseInteger(safeRead(STORAGE.clientSeq), 0),
    combo: 1,
    lastTapAt: 0,
    lastSyncAt: 0,
    toastTimer: null,
    stateFailures: 0,
    sessionPromise: null,
  };

  var elements = {};

  boot();

  function boot() {
    cacheElements();
    markJavaScriptReady();
    installGlobalDiagnostics();
    bindEvents();

    var cached = readJSON(STORAGE.cachedState, null);
    if (cached && cached.player && cached.world) {
      applyState(cached, false);
      setDiagnostic(
        "Cached world restored while the live connection starts.",
        false,
      );
    }

    trimTapQueue();
    persistTapQueue();
    startConnection();
    window.setInterval(updatePassiveDisplay, 1000);
    window.setInterval(updateSeasonClock, 1000);
    window.setInterval(syncState, POLL_MS);
  }

  function cacheElements() {
    var ids = [
      "connectionPill",
      "connectionLabel",
      "playerGreeting",
      "worldLine",
      "seasonTimer",
      "supplyValue",
      "supplyRate",
      "influenceValue",
      "comboValue",
      "comboReadout",
      "mapTitle",
      "territoryMap",
      "mapStage",
      "tapCoach",
      "mapToast",
      "reconnectButton",
      "activityCount",
      "activityList",
      "diagnostics",
      "diagnosticDot",
      "jsCheck",
      "apiCheck",
      "diagnosticMessage",
      "diagPlayer",
      "diagSession",
      "diagSync",
      "diagWatchdog",
      "claimCommandButton",
    ];
    for (var i = 0; i < ids.length; i += 1) {
      elements[ids[i]] = document.getElementById(ids[i]);
    }
  }

  function markJavaScriptReady() {
    setStatusText(elements.jsCheck, "Loaded", "ok");
    if (elements.diagnosticMessage) {
      elements.diagnosticMessage.textContent =
        "Client loaded. Verifying the live API…";
    }
  }

  function installGlobalDiagnostics() {
    window.addEventListener("error", function (event) {
      var message =
        event && event.message ? event.message : "Unknown JavaScript error";
      setStatusText(elements.jsCheck, "Error", "error");
      setDiagnostic("JavaScript error: " + message, true);
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event && event.reason;
      var message =
        reason && reason.message
          ? reason.message
          : String(reason ?? "Unknown promise error");
      setDiagnostic("Client request error: " + message, true);
    });
  }

  function bindEvents() {
    elements.territoryMap.addEventListener("click", handleMapClick);
    elements.territoryMap.addEventListener("keydown", handleMapKeydown);
    elements.reconnectButton.addEventListener("click", function () {
      if (!model.canCommand) {
        claimCommandLease();
      } else {
        setDiagnostic("Manual reconnect requested…", false);
        startConnection(true);
      }
    });
    elements.claimCommandButton.addEventListener("click", claimCommandLease);

    window.addEventListener("online", function () {
      setConnection("connecting", "Reconnecting");
      startConnection(true);
    });
    window.addEventListener("offline", function () {
      setConnection("offline", "Device offline");
      setDiagnostic(
        "This device is offline. Taps will wait safely on this device and send after reconnecting.",
        true,
      );
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        startConnection(true);
      }
    });
  }

  function startConnection(force) {
    if (model.syncing && !force) {
      return;
    }
    setConnection("connecting", "Connecting");
    if (model.credentials.playerId && model.credentials.sessionId) {
      syncState(true);
    } else {
      ensureSession();
    }
  }

  function ensureSession() {
    if (model.sessionPromise) {
      return model.sessionPromise;
    }
    model.creatingSession = true;
    setStatusText(elements.apiCheck, "Starting session", "");

    var body = {};
    if (model.credentials.playerId && model.credentials.recoveryCode) {
      body.playerId = model.credentials.playerId;
      body.recoveryCode = model.credentials.recoveryCode;
    }

    model.sessionPromise = requestJSON("POST", API.session, body, 10000)
      .then(function (data) {
        if (!data || !data.playerId || !data.sessionId || !data.recoveryCode) {
          throw new Error("Session API returned incomplete credentials");
        }
        saveCredentials(data);
        if (data.state) {
          applyState(data.state, true);
        }
        model.stateFailures = 0;
        setConnection("online", model.canCommand ? "Live" : "Read only");
        setStatusText(elements.apiCheck, "Connected", "ok");
        setDiagnostic(
          "Live session established. Reconnect credentials are stored on this device.",
          false,
        );
        flushTapQueue();
        return data;
      })
      .catch(function (error) {
        markApiFailure(error, "Could not start a live session");
        return null;
      })
      .then(function (result) {
        model.creatingSession = false;
        model.sessionPromise = null;
        return result;
      });
    return model.sessionPromise;
  }

  function syncState(isInitial) {
    if (
      model.syncing ||
      !model.credentials.playerId ||
      !model.credentials.sessionId
    ) {
      return Promise.resolve(false);
    }
    if (!navigator.onLine) {
      setConnection("offline", "Device offline");
      return Promise.resolve(false);
    }

    model.syncing = true;
    var query = "?playerId=" + encodeURIComponent(model.credentials.playerId);

    return requestJSON("GET", API.state + query, null, 8000, {
      Authorization: "Bearer " + model.credentials.sessionId,
    })
      .then(function (data) {
        applyState(data, true);
        model.stateFailures = 0;
        model.lastSyncAt = Date.now();
        setConnection("online", model.canCommand ? "Live" : "Read only");
        setStatusText(elements.apiCheck, "Connected", "ok");
        updateDiagnosticIdentity();
        flushTapQueue();
        return true;
      })
      .catch(function (error) {
        model.stateFailures += 1;
        if (
          error.status === 401 ||
          error.status === 403 ||
          error.status === 404
        ) {
          if (!isInitial) {
            setDiagnostic(
              "The saved session expired. Recovering this player…",
              false,
            );
          }
          model.credentials.sessionId = null;
          safeRemove(STORAGE.sessionId);
          ensureSession();
        } else {
          markApiFailure(error, "Live state is temporarily unavailable");
        }
        return false;
      })
      .then(function (result) {
        model.syncing = false;
        return result;
      });
  }

  function applyState(state, saveCache) {
    if (
      !state ||
      !state.player ||
      !state.world ||
      !Array.isArray(state.territories)
    ) {
      setDiagnostic(
        "The API responded, but its state shape was incomplete. The map shell is still usable.",
        true,
      );
      return;
    }

    model.state = state;
    model.supplyBase = toFiniteNumber(state.player.supply, model.supplyBase);
    model.supplyBaseAt = Date.now();
    model.influence = toFiniteNumber(state.player.influence, model.influence);
    model.canCommand = state.player.canCommand !== false;
    updateCommandUi();

    elements.playerGreeting.textContent =
      "Welcome, " + (state.player.name ?? "Pathfinder");
    elements.mapTitle.textContent = state.world.name ?? "The Shattered Reach";
    elements.worldLine.textContent =
      "Persistent world · Supply banks for up to " +
      toFiniteNumber(state.world.supplyCapHours, 24) +
      " hours away.";
    elements.supplyRate.textContent =
      "+" +
      formatNumber(toFiniteNumber(state.player.supplyPerHour, 0), 0) +
      " / hr";
    elements.influenceValue.textContent = formatNumber(model.influence, 0);

    renderTerritories(state.territories, state.pressure ?? [], state.player);
    renderActivity(state.recentActivity ?? [], state.player, state.territories);
    updatePassiveDisplay();
    updateSeasonClock();
    updateDiagnosticIdentity();

    if (saveCache) {
      safeWrite(STORAGE.cachedState, JSON.stringify(state));
    }
  }

  function renderTerritories(territories, pressure, player) {
    var groups = elements.territoryMap.querySelectorAll(".territory");
    var territoryById = indexBy(territories, "id");
    var pressureById = indexBy(pressure, "targetTerritoryId");

    for (var i = 0; i < groups.length; i += 1) {
      var group = groups[i];
      var regionId = group.getAttribute("data-region-id");
      var territory = territoryById[regionId] ?? territories[i] ?? null;
      if (!territory) {
        continue;
      }

      if (
        territory.id &&
        territory.id !== regionId &&
        !territoryById[regionId]
      ) {
        group.setAttribute("data-region-id", territory.id);
        regionId = territory.id;
      }
      group.classList.remove("owner-you", "owner-rival", "owner-neutral");
      var isYou = territory.ownerId && territory.ownerId === player.id;
      var isNeutral = !territory.ownerId;
      group.classList.add(
        isYou ? "owner-you" : isNeutral ? "owner-neutral" : "owner-rival",
      );

      if (isSafeAccent(territory.accent)) {
        group.style.setProperty("--territory", territory.accent);
      } else {
        group.style.removeProperty("--territory");
      }

      var ownerName = isYou
        ? "your protected territory"
        : isNeutral
          ? "unclaimed territory"
          : (territory.ownerName ?? "rival") + " territory, tap to pressure";
      group.setAttribute(
        "aria-label",
        (territory.name ?? regionId) + ", " + ownerName,
      );

      var pressureEntry = pressureById[regionId];
      var label = group.querySelector(".pressure-label, .region-label");
      if (label) {
        label.classList.remove("pressure-label", "region-label");
        label.classList.add(isYou ? "region-label" : "pressure-label");
        var value = pressureEntry
          ? toFiniteNumber(pressureEntry.lastMinute, pressureEntry.total ?? 0)
          : 0;
        label.textContent = isYou ? "YOU" : compactNumber(value);
      }
    }
  }

  function renderActivity(activity, player, territories) {
    var ownId = player.territoryId;
    var relevant = [];
    var i;
    for (i = 0; i < activity.length; i += 1) {
      if (!ownId || activity[i].targetTerritoryId === ownId) {
        relevant.push(activity[i]);
      }
    }
    if (!relevant.length) {
      relevant = activity.slice(0, MAX_ACTIVITY);
    }
    relevant = relevant.slice(0, MAX_ACTIVITY);

    while (elements.activityList.firstChild) {
      elements.activityList.removeChild(elements.activityList.firstChild);
    }

    elements.activityCount.textContent =
      relevant.length + (relevant.length === 1 ? " event" : " events");
    if (!relevant.length) {
      var empty = createActivityRow(
        "All quiet on your border",
        "No pressure has been recorded yet.",
        "···",
        "Now",
      );
      empty.className = "activity-empty";
      elements.activityList.appendChild(empty);
      return;
    }

    var territoryById = indexBy(territories, "id");
    for (i = 0; i < relevant.length; i += 1) {
      var event = relevant[i];
      var target = territoryById[event.targetTerritoryId];
      var actor = event.actorName ?? "A rival";
      var heading = actor + " applied pressure";
      var detail = activityDetail(event, target, ownId);
      elements.activityList.appendChild(
        createActivityRow(heading, detail, "+", relativeTime(event.at)),
      );
    }
  }

  function activityDetail(event, target, ownId) {
    if (typeof event.detail === "string" && event.detail) {
      return event.detail;
    }
    var targetName = target && target.name ? target.name : "the border";
    if (event.targetTerritoryId === ownId) {
      return "Tapped " + targetName + ". Your territory remains safe.";
    }
    return "Pressure noted at " + targetName + ". No territory was lost.";
  }

  function createActivityRow(title, detail, glyph, time) {
    var li = document.createElement("li");
    var icon = document.createElement("span");
    var copy = document.createElement("div");
    var strong = document.createElement("strong");
    var paragraph = document.createElement("p");
    var timeElement = document.createElement("time");
    icon.className = "activity-glyph";
    icon.textContent = glyph;
    strong.textContent = title;
    paragraph.textContent = detail;
    timeElement.textContent = time;
    copy.appendChild(strong);
    copy.appendChild(paragraph);
    li.appendChild(icon);
    li.appendChild(copy);
    li.appendChild(timeElement);
    return li;
  }

  function handleMapKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    var region = findRegion(event.target);
    if (!region) {
      return;
    }
    event.preventDefault();
    var box = region.getBoundingClientRect();
    handleTerritoryTap(region, {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      pointerType: "keyboard",
    });
  }

  function handleMapClick(event) {
    var region = findRegion(event.target);
    if (!region) {
      return;
    }
    handleTerritoryTap(region, event);
  }

  function handleTerritoryTap(region, event) {
    if (region.classList.contains("owner-you")) {
      showToast("Your territory is protected. Choose a glowing rival.");
      return;
    }
    if (region.classList.contains("owner-neutral")) {
      showToast("Unclaimed land cannot be pressured yet.");
      return;
    }
    if (!model.canCommand) {
      showToast("Read-only device · tap ↻ to take command");
      setDiagnostic(
        "Another device currently holds this player's command lease. Use the reconnect button to take command here.",
        true,
      );
      return;
    }
    if (!model.credentials.playerId || !model.credentials.sessionId) {
      showToast("Connecting this device before the tap is queued");
      ensureSession();
      return;
    }

    var targetTerritoryId = region.getAttribute("data-region-id");
    var point = normalizedPoint(event, region);
    var now = monotonicNow();
    var interval = model.lastTapAt ? now - model.lastTapAt : 99999;
    model.combo = interval < 1400 ? Math.min(model.combo + 1, 99) : 1;
    model.lastTapAt = now;
    model.clientSeq += 1;
    safeWrite(STORAGE.clientSeq, String(model.clientSeq));

    var tap = {
      v: 1,
      playerId: model.credentials.playerId,
      sessionId: model.credentials.sessionId,
      clientSeq: model.clientSeq,
      targetTerritoryId: targetTerritoryId,
      clientMonoMs: Math.max(0, Math.round(now)),
      pointerType: safePointerType(event.pointerType),
      visibility: safeVisibility(),
      xNormQ: point.xNormQ,
      yNormQ: point.yNormQ,
    };

    model.tapQueue.push(tap);
    trimTapQueue();
    persistTapQueue();
    applyOptimisticTap(region, event);
    flushTapQueue();
  }

  function applyOptimisticTap(region, event) {
    elements.tapCoach.classList.add("is-hidden");
    elements.comboValue.textContent = "×" + model.combo;
    elements.comboReadout.classList.add("is-active");
    model.influence += 1;
    elements.influenceValue.textContent = formatNumber(model.influence, 0);

    var label = region.querySelector(".pressure-label");
    if (label) {
      label.textContent = compactNumber(parseInteger(label.textContent, 0) + 1);
    }
    region.classList.remove("is-hot");
    window.requestAnimationFrame(function () {
      region.classList.add("is-hot");
      window.setTimeout(function () {
        region.classList.remove("is-hot");
      }, 180);
    });

    addTapEffect(event, region, model.combo);
    if (navigator.vibrate) {
      navigator.vibrate(12);
    }
    showToast("Pressure recorded · AFK shield prevents territory loss");
  }

  function addTapEffect(event, region, combo) {
    var stageBox = elements.mapStage.getBoundingClientRect();
    var regionBox = region.getBoundingClientRect();
    var clientX =
      typeof event.clientX === "number" && event.clientX
        ? event.clientX
        : regionBox.left + regionBox.width / 2;
    var clientY =
      typeof event.clientY === "number" && event.clientY
        ? event.clientY
        : regionBox.top + regionBox.height / 2;
    var x = clamp(clientX - stageBox.left, 10, stageBox.width - 10);
    var y = clamp(clientY - stageBox.top, 10, stageBox.height - 10);
    var color =
      window.getComputedStyle(region).getPropertyValue("--territory") ||
      "#ff7a6e";

    var ripple = document.createElement("span");
    ripple.className = "tap-ripple";
    ripple.style.left = x + "px";
    ripple.style.top = y + "px";
    ripple.style.setProperty("--ripple-color", color.trim());

    var floating = document.createElement("span");
    floating.className = "tap-float";
    floating.style.left = x + "px";
    floating.style.top = y + "px";
    floating.textContent = combo > 2 ? "+1  ×" + combo : "+1";
    elements.mapStage.appendChild(ripple);
    elements.mapStage.appendChild(floating);
    window.setTimeout(function () {
      removeNode(ripple);
      removeNode(floating);
    }, 900);
  }

  function flushTapQueue() {
    if (
      model.flushingTaps ||
      !model.tapQueue.length ||
      !model.credentials.playerId ||
      !model.credentials.sessionId
    ) {
      return;
    }
    if (!navigator.onLine) {
      return;
    }
    var tap = model.tapQueue[0];
    if (tap.playerId !== model.credentials.playerId) {
      model.tapQueue.shift();
      persistTapQueue();
      scheduleTapDrain();
      return;
    }
    model.flushingTaps = true;
    var payload = {
      v: tap.v ?? 1,
      // A queued command stays bound to the lease that created it. Moving it
      // to a recovered session would change the server idempotency key and can
      // reward a response-lost tap twice.
      playerId: tap.playerId,
      sessionId: tap.sessionId,
      clientSeq: tap.clientSeq,
      targetTerritoryId: tap.targetTerritoryId,
      clientMonoMs: tap.clientMonoMs,
      pointerType: tap.pointerType,
      visibility: tap.visibility,
      xNormQ: tap.xNormQ,
      yNormQ: tap.yNormQ,
    };

    requestJSON("POST", API.tap, payload, 8000)
      .then(function (data) {
        if (isQueuedTapAtHead(tap)) {
          model.tapQueue.shift();
          persistTapQueue();
        }
        if (
          data &&
          data.stateDelta &&
          data.stateDelta.player &&
          typeof data.stateDelta.player.influence === "number"
        ) {
          model.influence = data.stateDelta.player.influence;
          elements.influenceValue.textContent = formatNumber(
            model.influence,
            0,
          );
        }
        if (data && data.stateDelta && model.state) {
          if (Array.isArray(data.stateDelta.pressure)) {
            model.state.pressure = data.stateDelta.pressure;
          } else if (
            data.stateDelta.pressure &&
            typeof data.stateDelta.pressure === "object"
          ) {
            mergePressureEntry(data.stateDelta.pressure);
          }
          if (Array.isArray(data.stateDelta.recentActivity)) {
            model.state.recentActivity = data.stateDelta.recentActivity;
          }
        }
        if (data && data.outcome && data.outcome.accepted === false) {
          showToast("Tap observed · target was not eligible");
        } else if (
          data &&
          data.outcome &&
          data.outcome.accepted === true &&
          data.outcome.rewarded === false
        ) {
          showToast("Pressure observed · Influence is cooling down");
        }
        setConnection("online", model.canCommand ? "Live" : "Read only");
        model.flushingTaps = false;
        scheduleTapDrain();
      })
      .catch(function (error) {
        model.flushingTaps = false;
        if (error.status === 409) {
          if (isQueuedTapAtHead(tap)) {
            model.tapQueue.shift();
            persistTapQueue();
          }
          if (tap.sessionId === model.credentials.sessionId) {
            model.canCommand = false;
            updateCommandUi();
            setConnection("online", "Read only");
            showToast("Another device has command · tap ↻ to take over");
            setDiagnostic(
              "This tap was not accepted because another device holds the command lease. Use the reconnect button to take command here.",
              true,
            );
          } else {
            showToast("Older queued tap reconciled with the live state");
          }
          // A read-only lease still authenticates well enough for the server
          // to durably record the rejected attempt. Keep draining the queue at
          // the normal pace instead of stranding the remaining observations.
          scheduleTapDrain();
        } else if (error.status === 400 || error.status === 422) {
          if (isQueuedTapAtHead(tap)) {
            model.tapQueue.shift();
            persistTapQueue();
          }
          showToast("Tap rejected by the server · queue continued");
          setDiagnostic(
            "A malformed tap was dropped so it cannot block later telemetry: " +
              error.message,
            true,
          );
          scheduleTapDrain();
        } else if (
          error.status === 401 ||
          error.status === 403 ||
          error.status === 404
        ) {
          if (isQueuedTapAtHead(tap)) {
            model.tapQueue.shift();
            persistTapQueue();
          }
          if (tap.sessionId === model.credentials.sessionId) {
            model.credentials.sessionId = null;
            safeRemove(STORAGE.sessionId);
            ensureSession();
          } else {
            scheduleTapDrain();
          }
        } else {
          markApiFailure(error, "Tap saved locally; delivery will retry");
          window.clearTimeout(model.tapRetryTimer);
          model.tapRetryTimer = window.setTimeout(flushTapQueue, 3000);
        }
      });
  }

  function scheduleTapDrain() {
    window.clearTimeout(model.tapDrainTimer);
    model.tapDrainTimer = window.setTimeout(
      flushTapQueue,
      TAP_DELIVERY_INTERVAL_MS,
    );
  }

  function claimCommandLease() {
    if (!model.credentials.playerId || !model.credentials.recoveryCode) {
      ensureSession();
      return;
    }
    model.credentials.sessionId = null;
    safeRemove(STORAGE.sessionId);
    setConnection("connecting", "Taking command");
    setDiagnostic(
      "Requesting a fresh command lease for this device. Other connected devices will become read-only.",
      false,
    );
    ensureSession();
  }

  function updateCommandUi() {
    elements.reconnectButton.title = model.canCommand
      ? "Reconnect"
      : "Take command on this device";
    elements.reconnectButton.setAttribute(
      "aria-label",
      model.canCommand
        ? "Reconnect to live state"
        : "Take command on this device",
    );
  }

  function saveCredentials(data) {
    model.credentials.playerId = String(data.playerId);
    model.credentials.recoveryCode = String(data.recoveryCode);
    model.credentials.sessionId = String(data.sessionId);
    safeWrite(STORAGE.playerId, model.credentials.playerId);
    safeWrite(STORAGE.recoveryCode, model.credentials.recoveryCode);
    safeWrite(STORAGE.sessionId, model.credentials.sessionId);
    updateDiagnosticIdentity();
  }

  function updatePassiveDisplay() {
    var rate =
      model.state && model.state.player
        ? toFiniteNumber(model.state.player.supplyPerHour, 0)
        : 0;
    var elapsed = Math.max(0, Date.now() - model.supplyBaseAt) / 3600000;
    var capHours =
      model.state && model.state.world
        ? toFiniteNumber(model.state.world.supplyCapHours, 24)
        : 24;
    var supply = model.supplyBase + rate * Math.min(elapsed, capHours);
    elements.supplyValue.textContent = formatNumber(
      supply,
      supply < 100 ? 1 : 0,
    );
  }

  function updateSeasonClock() {
    var end =
      model.state && model.state.world
        ? toEpochMillis(model.state.world.seasonEndsAt)
        : NaN;
    if (!isFinite(end)) {
      return;
    }
    var remaining = Math.max(0, end - Date.now());
    var days = Math.floor(remaining / 86400000);
    var hours = Math.floor((remaining % 86400000) / 3600000);
    var minutes = Math.floor((remaining % 3600000) / 60000);
    elements.seasonTimer.textContent =
      days > 0
        ? pad2(days) + "d " + pad2(hours) + "h"
        : pad2(hours) + "h " + pad2(minutes) + "m";
  }

  function setConnection(mode, label) {
    model.online = mode === "online";
    elements.connectionPill.classList.remove(
      "is-online",
      "is-offline",
      "is-connecting",
    );
    elements.connectionPill.classList.add(
      mode === "online"
        ? "is-online"
        : mode === "offline"
          ? "is-offline"
          : "is-connecting",
    );
    elements.connectionLabel.textContent = label;
    elements.diagnosticDot.className =
      mode === "online" ? "ok" : mode === "offline" ? "error" : "";
  }

  function markApiFailure(error, prefix) {
    var message =
      error && error.message ? error.message : "Unknown network error";
    var status = error && error.status ? " (HTTP " + error.status + ")" : "";
    setConnection(
      "offline",
      navigator.onLine ? "API offline" : "Device offline",
    );
    setStatusText(elements.apiCheck, "Unavailable", "error");
    setDiagnostic(
      prefix +
        status +
        ": " +
        message +
        ". The interface remains available and queued taps are retained.",
      true,
    );
  }

  function setDiagnostic(message, shouldOpen) {
    elements.diagnosticMessage.textContent = message;
    if (shouldOpen) {
      elements.diagnostics.open = true;
    }
    updateDiagnosticIdentity();
  }

  function updateDiagnosticIdentity() {
    elements.diagPlayer.textContent =
      shortId(model.credentials.playerId) || "Not assigned";
    elements.diagSession.textContent =
      shortId(model.credentials.sessionId) || "Not assigned";
    elements.diagSync.textContent = model.lastSyncAt
      ? new Date(model.lastSyncAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "Never";
    elements.diagWatchdog.textContent = "Server-side";
  }

  function showToast(message) {
    elements.mapToast.textContent = message;
    elements.mapToast.classList.add("is-visible");
    window.clearTimeout(model.toastTimer);
    model.toastTimer = window.setTimeout(function () {
      elements.mapToast.classList.remove("is-visible");
    }, 1800);
  }

  function requestJSON(method, url, body, timeoutMs, extraHeaders) {
    if (!window.fetch) {
      return xhrJSON(method, url, body, timeoutMs, extraHeaders);
    }
    var controller = window.AbortController ? new AbortController() : null;
    var timeout = controller
      ? window.setTimeout(function () {
          controller.abort();
        }, timeoutMs)
      : null;
    var options = {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: Object.assign(
        { Accept: "application/json" },
        extraHeaders ?? {},
      ),
    };
    if (body !== null && body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    if (controller) {
      options.signal = controller.signal;
    }
    return window
      .fetch(url, options)
      .then(function (response) {
        if (timeout) {
          window.clearTimeout(timeout);
        }
        return response.text().then(function (text) {
          var data = text ? parseJSON(text) : null;
          if (!response.ok) {
            throw httpError(response.status, data, response.statusText);
          }
          if (text && data === null) {
            throw new Error("API returned invalid JSON");
          }
          return data;
        });
      })
      .catch(function (error) {
        if (timeout) {
          window.clearTimeout(timeout);
        }
        if (error && error.name === "AbortError") {
          throw new Error("Request timed out");
        }
        throw error;
      });
  }

  function xhrJSON(method, url, body, timeoutMs, extraHeaders) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.timeout = timeoutMs;
      xhr.setRequestHeader("Accept", "application/json");
      var headerNames = Object.keys(extraHeaders ?? {});
      for (
        var headerIndex = 0;
        headerIndex < headerNames.length;
        headerIndex += 1
      ) {
        var headerName = headerNames[headerIndex];
        xhr.setRequestHeader(headerName, extraHeaders[headerName]);
      }
      if (body !== null && body !== undefined) {
        xhr.setRequestHeader("Content-Type", "application/json");
      }
      xhr.onload = function () {
        var data = xhr.responseText ? parseJSON(xhr.responseText) : null;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(httpError(xhr.status, data, xhr.statusText));
        }
      };
      xhr.onerror = function () {
        reject(new Error("Network request failed"));
      };
      xhr.ontimeout = function () {
        reject(new Error("Request timed out"));
      };
      xhr.send(
        body !== null && body !== undefined ? JSON.stringify(body) : null,
      );
    });
  }

  function httpError(status, data, fallback) {
    var apiError = data && data.error;
    var message =
      data && data.message
        ? String(data.message)
        : typeof apiError === "string"
          ? apiError
          : apiError && apiError.message
            ? String(apiError.message)
            : (fallback ?? "Request failed");
    var error = new Error(message);
    error.status = status;
    error.body = data;
    return error;
  }

  function normalizedPoint(event, region) {
    var box = elements.mapStage.getBoundingClientRect();
    var regionBox = region.getBoundingClientRect();
    var x =
      typeof event.clientX === "number" && event.clientX
        ? event.clientX
        : regionBox.left + regionBox.width / 2;
    var y =
      typeof event.clientY === "number" && event.clientY
        ? event.clientY
        : regionBox.top + regionBox.height / 2;
    return {
      xNormQ: Math.round(
        clamp((x - box.left) / Math.max(1, box.width), 0, 1) * 10000,
      ),
      yNormQ: Math.round(
        clamp((y - box.top) / Math.max(1, box.height), 0, 1) * 10000,
      ),
    };
  }

  function findRegion(target) {
    var current = target;
    while (current && current !== elements.territoryMap) {
      if (current.classList && current.classList.contains("territory")) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  function trimTapQueue() {
    if (!Array.isArray(model.tapQueue)) {
      model.tapQueue = [];
    }
    // Legacy entries did not retain their origin lease. Rebinding one after a
    // recovery can double-apply a command whose response was lost, so those
    // entries are discarded and the next state poll reconciles the display.
    model.tapQueue = model.tapQueue.filter(function (tap) {
      return Boolean(
        tap &&
        typeof tap.playerId === "string" &&
        tap.playerId &&
        typeof tap.sessionId === "string" &&
        tap.sessionId &&
        Number.isSafeInteger(tap.clientSeq),
      );
    });
    if (model.tapQueue.length > MAX_QUEUED_TAPS) {
      model.tapQueue = model.tapQueue.slice(
        model.tapQueue.length - MAX_QUEUED_TAPS,
      );
    }
  }

  function persistTapQueue() {
    safeWrite(STORAGE.tapQueue, JSON.stringify(model.tapQueue));
  }

  function isQueuedTapAtHead(tap) {
    var head = model.tapQueue[0];
    return Boolean(
      head &&
      head.playerId === tap.playerId &&
      head.sessionId === tap.sessionId &&
      head.clientSeq === tap.clientSeq,
    );
  }

  function safeRead(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeWrite(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      if (elements.diagnosticMessage) {
        setDiagnostic(
          "Private storage is unavailable; this session may not reconnect across restarts.",
          true,
        );
      }
      return false;
    }
  }

  function safeRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      return;
    }
  }

  function readJSON(key, fallback) {
    var raw = safeRead(key);
    if (!raw) {
      return fallback;
    }
    var parsed = parseJSON(raw);
    return parsed === null ? fallback : parsed;
  }

  function parseJSON(raw) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  function parseInteger(value, fallback) {
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : fallback;
  }

  function toFiniteNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function formatNumber(value, decimals) {
    var number = toFiniteNumber(value, 0);
    try {
      return number.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    } catch (error) {
      return number.toFixed(decimals);
    }
  }

  function compactNumber(value) {
    var number = toFiniteNumber(value, 0);
    if (number >= 1000000) {
      return (number / 1000000).toFixed(1).replace(".0", "") + "m";
    }
    if (number >= 1000) {
      return (number / 1000).toFixed(1).replace(".0", "") + "k";
    }
    return String(Math.round(number));
  }

  function indexBy(items, key) {
    var index = {};
    for (var i = 0; i < items.length; i += 1) {
      if (items[i] && items[i][key] !== undefined) {
        index[items[i][key]] = items[i];
      }
    }
    return index;
  }

  function mergePressureEntry(entry) {
    if (!model.state) {
      return;
    }
    if (!Array.isArray(model.state.pressure)) {
      model.state.pressure = [];
    }
    var targetId = entry.targetTerritoryId;
    var replaced = false;
    for (var i = 0; i < model.state.pressure.length; i += 1) {
      if (model.state.pressure[i].targetTerritoryId === targetId) {
        model.state.pressure[i] = entry;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      model.state.pressure.push(entry);
    }
  }

  function toEpochMillis(value) {
    if (typeof value === "number" && isFinite(value)) {
      return value > 0 && value < 100000000000 ? value * 1000 : value;
    }
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
      var numeric = Number(value);
      return numeric > 0 && numeric < 100000000000 ? numeric * 1000 : numeric;
    }
    var parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : NaN;
  }

  function relativeTime(value) {
    var time = toEpochMillis(value);
    if (!isFinite(time)) {
      return "Recent";
    }
    var seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) {
      return "Now";
    }
    if (seconds < 3600) {
      return Math.floor(seconds / 60) + "m";
    }
    if (seconds < 86400) {
      return Math.floor(seconds / 3600) + "h";
    }
    return Math.floor(seconds / 86400) + "d";
  }

  function setStatusText(element, text, className) {
    if (!element) {
      return;
    }
    element.textContent = text;
    element.className = className ?? "";
  }

  function safePointerType(pointerType) {
    if (
      pointerType === "mouse" ||
      pointerType === "pen" ||
      pointerType === "touch" ||
      pointerType === "keyboard"
    ) {
      return pointerType;
    }
    return navigator.maxTouchPoints > 0 ? "touch" : "mouse";
  }

  function safeVisibility() {
    var value = document.visibilityState;
    return value === "hidden" || value === "visible" ? value : "visible";
  }

  function monotonicNow() {
    return window.performance && typeof window.performance.now === "function"
      ? window.performance.now()
      : Date.now();
  }

  function shortId(value) {
    if (!value) {
      return "";
    }
    var string = String(value);
    return string.length > 14
      ? string.slice(0, 6) + "…" + string.slice(-5)
      : string;
  }

  function isSafeAccent(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function removeNode(node) {
    if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }
  }
})();

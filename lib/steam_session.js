const SteamUser = require("steam-user");
const runtime = require("./local_runtime");

function createSteamUser(app) {
  const user = new SteamUser({
    autoRelogin: true,
    renewRefreshTokens: true
  });

  user.on("refreshToken", (refreshToken) => {
    app.currentRefreshToken = refreshToken;
    if (app.ownSteamId) {
      runtime.saveStoredAuth(app.steamUsername, refreshToken, app.ownSteamId);
    }
    console.log("Stored refreshed Steam login token.");
  });

  user.on("webSession", (sessionId, cookies) => {
    app.communitySession = {
      sessionId,
      cookies: [...cookies],
      cookieHeader: cookies.join("; ")
    };
  });

  user.on("error", (error) => {
    if (app.loginReject) {
      const reject = app.loginReject;
      app.loginReject = null;
      reject(error);
      return;
    }
    console.error(`Steam client error: ${error.message}`);
  });

  user.on("disconnected", (eresult, message) => {
    app.communitySession = null;
    console.warn(`Steam client disconnected: ${message || eresult}`);
  });

  return user;
}

async function login(app) {
  const storedAuth = runtime.loadStoredAuth();
  if (
    storedAuth &&
    storedAuth.steam_username === app.steamUsername &&
    storedAuth.refresh_token
  ) {
    try {
      console.log("Logging in to Steam using the saved refresh token...");
      await loginWithDetails(app, {
        refreshToken: storedAuth.refresh_token,
        steamID: storedAuth.steam_id,
        machineName: "steam-stalker"
      });
      return;
    } catch (error) {
      console.warn(`Saved refresh token failed: ${error.message}`);
      if (shouldClearStoredAuth(error)) {
        runtime.clearStoredAuth();
      }
      app.close();
    }
  }

  const password = String(app.config.steam_password ?? "").trim() || runtime.promptHidden("Steam password");
  console.log(`Logging in to Steam as ${app.steamUsername}...`);
  await loginWithDetails(app, {
    accountName: app.steamUsername,
    password,
    machineName: "steam-stalker"
  });
}

async function loginWithDetails(app, details) {
  app.close();
  app.user = createSteamUser(app);
  app.currentRefreshToken = "";
  app.communitySession = null;

  await waitForLoggedOn(app, () => {
    app.user.logOn(details);
  });

  app.ownSteamId = getOwnSteamId(app);
  if (details.steamID && String(details.steamID) !== app.ownSteamId) {
    throw new Error("Stored refresh token SteamID mismatch.");
  }
  if (app.currentRefreshToken) {
    runtime.saveStoredAuth(app.steamUsername, app.currentRefreshToken, app.ownSteamId);
  }
  await refreshWebSession(app);
}

function getOwnSteamId(app) {
  if (!app.user || !app.user.steamID) {
    throw new Error("Steam login succeeded, but no SteamID was available.");
  }

  if (typeof app.user.steamID.getSteamID64 === "function") {
    return app.user.steamID.getSteamID64();
  }
  return String(app.user.steamID);
}

function waitForLoggedOn(app, startLogin) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Steam login timed out."));
    }, runtime.LOGIN_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      app.loginReject = null;
      app.user.removeListener("loggedOn", onLoggedOn);
    };

    const onLoggedOn = () => {
      cleanup();
      resolve();
    };

    app.loginReject = (error) => {
      cleanup();
      reject(error);
    };
    app.user.once("loggedOn", onLoggedOn);
    startLogin();
  });
}

function waitForNextWebSession(app, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a Steam Community web session."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      app.user.removeListener("webSession", onWebSession);
    };

    const onWebSession = (sessionId, cookies) => {
      cleanup();
      resolve({
        sessionId,
        cookies: [...cookies],
        cookieHeader: cookies.join("; ")
      });
    };

    app.user.once("webSession", onWebSession);
  });
}

async function refreshWebSession(app) {
  if (!app.user) {
    throw new Error("Steam client is not connected.");
  }

  const nextSession = waitForNextWebSession(app, runtime.WEB_SESSION_TIMEOUT_MS);
  app.user.webLogOn();
  app.communitySession = await nextSession;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = runtime.REQUEST_TIMEOUT_MS) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function shouldClearStoredAuth(error) {
  const authFailureCodes = new Set([
    SteamUser.EResult?.InvalidPassword,
    SteamUser.EResult?.AccessDenied,
    SteamUser.EResult?.InvalidLoginAuthCode,
    SteamUser.EResult?.ExpiredLoginAuthCode,
    SteamUser.EResult?.AccountLoginDeniedNeedTwoFactor,
    SteamUser.EResult?.TwoFactorCodeMismatch
  ].filter((value) => typeof value === "number"));
  const errorCode = Number(error?.eresult);
  if (authFailureCodes.has(errorCode)) {
    return true;
  }

  const message = String(error?.message ?? error ?? "").toLowerCase();
  const authFailurePatterns = [
    "refresh token",
    "invalid password",
    "access denied",
    "invalid login auth code",
    "expired login auth code",
    "twofactorcodemismatch",
    "two-factor",
    "steamid mismatch",
    "steamids don't match"
  ];
  return authFailurePatterns.some((pattern) => message.includes(pattern));
}

function buildCommunityFetchOptions(options = {}) {
  const { bodyFactory, ...fetchOptions } = options;
  if (typeof bodyFactory === "function") {
    fetchOptions.body = bodyFactory();
  }
  return fetchOptions;
}

function isLikelyCommunityLoginHtml(response, bodyText = "") {
  const responseUrl = String(response?.url ?? "").toLowerCase();
  const contentType = String(response?.headers?.get("content-type") ?? "").toLowerCase();
  const normalizedBody = String(bodyText ?? "").toLowerCase();
  const isHtml =
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml") ||
    responseUrl.includes("/login");

  if (!isHtml) {
    return false;
  }

  return (
    responseUrl.includes("/login") ||
    normalizedBody.includes("steamcommunity.com/login") ||
    normalizedBody.includes("id=\"login_form\"") ||
    normalizedBody.includes("name=\"password\"") ||
    normalizedBody.includes("global_header_login") ||
    normalizedBody.includes("join steam") ||
    normalizedBody.includes("<title>sign in")
  );
}

function isPotentialHtmlResponse(response) {
  const responseUrl = String(response?.url ?? "").toLowerCase();
  const contentType = String(response?.headers?.get("content-type") ?? "").toLowerCase();
  return (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml") ||
    responseUrl.includes("/login")
  );
}

async function shouldRefreshCommunitySession(app, response) {
  if (response.status === 401 || response.status === 403) {
    return true;
  }

  if (!isPotentialHtmlResponse(response)) {
    return false;
  }

  try {
    const bodyText = await response.clone().text();
    return isLikelyCommunityLoginHtml(response, bodyText);
  } catch {
    return false;
  }
}

async function communityFetch(app, url, options = {}, allowRetry = true) {
  if (!app.communitySession) {
    await refreshWebSession(app);
  }

  const fetchOptions = buildCommunityFetchOptions(options);
  const headers = new Headers(fetchOptions.headers || {});
  for (const [key, value] of Object.entries(runtime.DEFAULT_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  headers.set("Cookie", app.communitySession.cookieHeader);

  const response = await fetchWithTimeout(url, {
    ...fetchOptions,
    headers
  });

  if (allowRetry && await shouldRefreshCommunitySession(app, response)) {
    await refreshWebSession(app);
    return communityFetch(app, url, options, false);
  }

  return response;
}

module.exports = {
  communityFetch,
  createSteamUser,
  fetchWithTimeout,
  isLikelyCommunityLoginHtml,
  login,
  refreshWebSession,
  shouldClearStoredAuth
};

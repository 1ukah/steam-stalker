const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const SteamUser = require("steam-user");

const CONFIG_FILE = path.join(__dirname, "config.json");
const STATE_FILE = path.join(__dirname, "state.json");
const HISTORY_FILE = path.join(__dirname, "history.jsonl");
const AVATAR_DIR = path.join(__dirname, "downloaded_avatars");
const SECRET_DIR = path.join(__dirname, ".steam_secrets");
const AUTH_FILE = path.join(SECRET_DIR, "auth.json.dpapi");
const XML_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 60000;
const LOGIN_TIMEOUT_MS = 120000;
const WEB_SESSION_TIMEOUT_MS = 30000;
const DEFAULT_HEADERS = {
  "User-Agent": (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/135.0.0.0 Safari/537.36"
  )
};
const PERSONA_STATES = {
  offline: SteamUser.EPersonaState.Offline,
  online: SteamUser.EPersonaState.Online,
  busy: SteamUser.EPersonaState.Busy,
  away: SteamUser.EPersonaState.Away,
  snooze: SteamUser.EPersonaState.Snooze,
  looking_to_trade: SteamUser.EPersonaState.LookingToTrade,
  looking_to_play: SteamUser.EPersonaState.LookingToPlay,
  invisible: SteamUser.EPersonaState.Invisible
};

class SteamMirror {
  constructor() {
    this.config = this.loadJson(CONFIG_FILE);
    this.state = this.loadJson(STATE_FILE);
    this.user = null;
    this.communitySession = null;
    this.ownSteamId = "";
    this.currentRefreshToken = "";
    this.loginReject = null;

    if (Object.keys(this.config).length === 0) {
      this.firstBootSetup();
    }

    this.steamUsername = this.requireConfigString("steam_username");
    this.targetProfileUrl = this.resolveTargetProfileUrl();
    this.syncOnStart = Boolean(this.config.sync_on_start ?? true);
    this.downloadImages = Boolean(this.config.download_images ?? true);
    this.pollInterval = this.parsePollInterval(this.config.poll_interval);
    this.personaState = this.parsePersonaState(this.config.persona_state);

    process.on("SIGINT", () => {
      this.close();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      this.close();
      process.exit(143);
    });
  }

  loadJson(filePath) {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  saveJson(filePath, data, pretty = false) {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(data, null, pretty ? 4 : 0)}\n`,
      "utf8"
    );
  }

  logHistory(event) {
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(event)}\n`, "utf8");
  }

  firstBootSetup() {
    console.log("--- Steam Profile Mirror: First Boot Setup ---");
    const targetProfile = this.promptInline("Enter target Steam profile URL, vanity ID, or SteamID64");
    const steamUsername = this.promptInline("Enter your Steam account username");
    const syncOnStart = this.promptInline("Sync profile immediately? (y/n)").toLowerCase() === "y";
    const downloadImages = this.promptInline("Download avatar images locally? (y/n)").toLowerCase() === "y";

    this.config = {
      target_profile: targetProfile,
      steam_username: steamUsername,
      sync_on_start: syncOnStart,
      download_images: downloadImages,
      poll_interval: 300,
      persona_state: "invisible"
    };
    this.saveJson(CONFIG_FILE, this.config, true);
  }

  promptInline(question) {
    const script = "Read-Host -Prompt $env:STEAM_STALKER_PROMPT";
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "inherit"],
        env: { ...process.env, STEAM_STALKER_PROMPT: question }
      }
    ).trim();
  }

  promptHidden(question) {
    const script = [
      "$prompt = $env:STEAM_STALKER_PROMPT",
      "$secure = Read-Host -AsSecureString $prompt",
      "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
      "try {",
      "  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)",
      "} finally {",
      "  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)",
      "}"
    ].join("; ");

    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "inherit"],
        env: { ...process.env, STEAM_STALKER_PROMPT: question }
      }
    ).trim();
  }

  requireConfigString(key) {
    const value = String(this.config[key] ?? "").trim();
    if (!value) {
      throw new Error(`Missing \`${key}\` in config.json.`);
    }
    return value;
  }

  parsePollInterval(value) {
    const parsed = Number.parseInt(value ?? 300, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error("`poll_interval` must be an integer number of seconds.");
    }
    return parsed;
  }

  parsePersonaState(value) {
    const normalized = String(value ?? "invisible").trim().toLowerCase();
    if (!Object.hasOwn(PERSONA_STATES, normalized)) {
      throw new Error(
        "`persona_state` must be one of: " + Object.keys(PERSONA_STATES).join(", ")
      );
    }
    return PERSONA_STATES[normalized];
  }

  resolveTargetProfileUrl() {
    const target = String(
      this.config.target_profile ??
      this.config.target_steamid ??
      this.config.target ??
      ""
    ).trim();

    if (!target) {
      throw new Error("Missing target profile. Update config.json and try again.");
    }

    if (/^765\d{14}$/.test(target)) {
      return `https://steamcommunity.com/profiles/${target}/`;
    }

    if (target.toLowerCase().includes("steamcommunity.com")) {
      const parsed = new URL(target);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[0].toLowerCase() === "profiles" && /^765\d{14}$/.test(parts[1])) {
        return `https://steamcommunity.com/profiles/${parts[1]}/`;
      }
      if (parts.length >= 2 && parts[0].toLowerCase() === "id") {
        return `https://steamcommunity.com/id/${parts[1]}/`;
      }
      throw new Error(
        "Unsupported Steam profile URL. Use `/id/<name>/`, `/profiles/<steamid64>/`, a vanity ID, or a SteamID64."
      );
    }

    return `https://steamcommunity.com/id/${target}/`;
  }

  ensureSecretDir() {
    fs.mkdirSync(SECRET_DIR, { recursive: true });
  }

  protectForCurrentUser(plaintext) {
    const script = `
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($env:STEAM_STALKER_SECRET)
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Convert]::ToBase64String($protected)
`.trim();

    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, STEAM_STALKER_SECRET: plaintext }
      }
    ).trim();
  }

  unprotectForCurrentUser(ciphertext) {
    const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($env:STEAM_STALKER_SECRET_B64)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $bytes,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Text.Encoding]::UTF8.GetString($plain)
`.trim();

    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, STEAM_STALKER_SECRET_B64: ciphertext }
      }
    ).trim();
  }

  loadStoredAuth() {
    if (!fs.existsSync(AUTH_FILE)) {
      return null;
    }

    try {
      const protectedBlob = fs.readFileSync(AUTH_FILE, "utf8").trim();
      if (!protectedBlob) {
        return null;
      }
      return JSON.parse(this.unprotectForCurrentUser(protectedBlob));
    } catch (error) {
      console.warn(`Stored refresh token could not be read: ${error.message}`);
      return null;
    }
  }

  saveStoredAuth(refreshToken, steamId) {
    if (!refreshToken) {
      return;
    }

    this.ensureSecretDir();
    const payload = {
      steam_username: this.steamUsername,
      refresh_token: refreshToken,
      steam_id: steamId
    };
    const protectedBlob = this.protectForCurrentUser(JSON.stringify(payload));
    fs.writeFileSync(AUTH_FILE, `${protectedBlob}\n`, "utf8");
  }

  clearStoredAuth() {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
  }

  createSteamUser() {
    const user = new SteamUser({
      autoRelogin: true,
      renewRefreshTokens: true
    });

    user.on("refreshToken", (refreshToken) => {
      this.currentRefreshToken = refreshToken;
      if (this.ownSteamId) {
        this.saveStoredAuth(refreshToken, this.ownSteamId);
      }
      console.log("Stored refreshed Steam login token.");
    });

    user.on("webSession", (sessionId, cookies) => {
      this.communitySession = {
        sessionId,
        cookies: [...cookies],
        cookieHeader: cookies.join("; ")
      };
    });

    user.on("error", (error) => {
      if (this.loginReject) {
        const reject = this.loginReject;
        this.loginReject = null;
        reject(error);
        return;
      }
      console.error(`Steam client error: ${error.message}`);
    });

    user.on("disconnected", (eresult, message) => {
      this.communitySession = null;
      console.warn(`Steam client disconnected: ${message || eresult}`);
    });

    return user;
  }

  async login() {
    const storedAuth = this.loadStoredAuth();
    if (
      storedAuth &&
      storedAuth.steam_username === this.steamUsername &&
      storedAuth.refresh_token
    ) {
      try {
        console.log("Logging in to Steam using the saved refresh token...");
        await this.loginWithDetails({
          refreshToken: storedAuth.refresh_token,
          steamID: storedAuth.steam_id,
          machineName: "steam-stalker"
        });
        return;
      } catch (error) {
        console.warn(`Saved refresh token failed: ${error.message}`);
        if (this.shouldClearStoredAuth(error)) {
          this.clearStoredAuth();
        }
        this.close();
      }
    }

    const password = String(this.config.steam_password ?? "").trim() || this.promptHidden("Steam password");
    console.log(`Logging in to Steam as ${this.steamUsername}...`);
    await this.loginWithDetails({
      accountName: this.steamUsername,
      password,
      machineName: "steam-stalker"
    });
  }

  async loginWithDetails(details) {
    this.close();
    this.user = this.createSteamUser();
    this.currentRefreshToken = "";
    this.communitySession = null;

    await this.waitForLoggedOn(() => {
      this.user.logOn(details);
    });

    this.ownSteamId = this.getOwnSteamId();
    if (details.steamID && String(details.steamID) !== this.ownSteamId) {
      throw new Error("Stored refresh token SteamID mismatch.");
    }
    if (this.currentRefreshToken) {
      this.saveStoredAuth(this.currentRefreshToken, this.ownSteamId);
    }
    await this.refreshWebSession();
  }

  getOwnSteamId() {
    if (!this.user || !this.user.steamID) {
      throw new Error("Steam login succeeded, but no SteamID was available.");
    }

    if (typeof this.user.steamID.getSteamID64 === "function") {
      return this.user.steamID.getSteamID64();
    }
    return String(this.user.steamID);
  }

  waitForLoggedOn(startLogin) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Steam login timed out."));
      }, LOGIN_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        this.loginReject = null;
        this.user.removeListener("loggedOn", onLoggedOn);
      };

      const onLoggedOn = () => {
        cleanup();
        resolve();
      };

      this.loginReject = (error) => {
        cleanup();
        reject(error);
      };
      this.user.once("loggedOn", onLoggedOn);
      startLogin();
    });
  }

  waitForNextWebSession(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for a Steam Community web session."));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.user.removeListener("webSession", onWebSession);
      };

      const onWebSession = (sessionId, cookies) => {
        cleanup();
        resolve({
          sessionId,
          cookies: [...cookies],
          cookieHeader: cookies.join("; ")
        });
      };

      this.user.once("webSession", onWebSession);
    });
  }

  async refreshWebSession() {
    if (!this.user) {
      throw new Error("Steam client is not connected.");
    }

    const nextSession = this.waitForNextWebSession(WEB_SESSION_TIMEOUT_MS);
    this.user.webLogOn();
    this.communitySession = await nextSession;
  }

  shouldClearStoredAuth(error) {
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

  async fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  buildCommunityFetchOptions(options = {}) {
    const { bodyFactory, ...fetchOptions } = options;
    if (typeof bodyFactory === "function") {
      fetchOptions.body = bodyFactory();
    }
    return fetchOptions;
  }

  isLikelyCommunityLoginHtml(response, bodyText = "") {
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

  isPotentialHtmlResponse(response) {
    const responseUrl = String(response?.url ?? "").toLowerCase();
    const contentType = String(response?.headers?.get("content-type") ?? "").toLowerCase();
    return (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml") ||
      responseUrl.includes("/login")
    );
  }

  async shouldRefreshCommunitySession(response) {
    if (response.status === 401 || response.status === 403) {
      return true;
    }

    if (!this.isPotentialHtmlResponse(response)) {
      return false;
    }

    try {
      const bodyText = await response.clone().text();
      return this.isLikelyCommunityLoginHtml(response, bodyText);
    } catch {
      return false;
    }
  }

  async communityFetch(url, options = {}, allowRetry = true) {
    if (!this.communitySession) {
      await this.refreshWebSession();
    }

    const fetchOptions = this.buildCommunityFetchOptions(options);
    const headers = new Headers(fetchOptions.headers || {});
    for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }
    headers.set("Cookie", this.communitySession.cookieHeader);

    const response = await this.fetchWithTimeout(url, {
      ...fetchOptions,
      headers
    });

    if (allowRetry && await this.shouldRefreshCommunitySession(response)) {
      await this.refreshWebSession();
      return this.communityFetch(url, options, false);
    }

    return response;
  }

  extractXmlField(xml, tagName) {
    const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
    const match = xml.match(pattern);
    if (!match) {
      return "";
    }

    return this.normalizeXmlText(match[1]);
  }

  normalizeXmlText(value) {
    const trimmed = String(value ?? "").trim();
    const decoded = this.decodeXml(trimmed);
    return this.stripCdata(decoded).trim();
  }

  stripCdata(value) {
    const match = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return match ? match[1] : value;
  }

  decodeXml(value) {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'");
  }

  async getProfileXml(baseUrl) {
    const response = await this.fetchWithTimeout(
      `${baseUrl.replace(/\/+$/, "")}/?xml=1`,
      { headers: DEFAULT_HEADERS },
      XML_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`Steam returned HTTP ${response.status} for ${baseUrl}`);
    }

    const xml = await response.text();
    const error = this.extractXmlField(xml, "error");
    if (error) {
      throw new Error(`Steam profile lookup failed for ${baseUrl}: ${error}`);
    }
    return xml;
  }

  async getTargetInfo() {
    const xml = await this.getProfileXml(this.targetProfileUrl);
    const avatarUrl =
      this.extractXmlField(xml, "avatarFull") ||
      this.extractXmlField(xml, "avatarMedium") ||
      this.extractXmlField(xml, "avatarIcon");
    const name = this.extractXmlField(xml, "steamID");

    if (!name || !avatarUrl) {
      throw new Error("Missing profile name or avatar in target XML.");
    }

    return { name, avatarUrl };
  }

  waitForAccountName(name) {
    if (!this.user) {
      throw new Error("Steam client is not connected.");
    }
    const user = this.user;
    if (this.user.accountInfo?.name === name) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Steam did not confirm the display-name update within 15 seconds."));
      }, 15000);

      const cleanup = () => {
        clearTimeout(timeout);
        user.removeListener("accountInfo", onAccountInfo);
      };

      const onAccountInfo = (accountName) => {
        if (accountName === name) {
          cleanup();
          resolve();
        }
      };

      user.on("accountInfo", onAccountInfo);
      if (user.accountInfo?.name === name) {
        cleanup();
        resolve();
      }
    });
  }

  async updateDisplayName(name) {
    console.log(`Updating display name to: ${name}`);
    this.user.setPersona(this.personaState, name);
    await this.waitForAccountName(name);
  }

  buildAvatarUploadForm(imageBuffer, contentType) {
    if (!this.communitySession?.sessionId) {
      throw new Error("Steam Community session is not ready.");
    }

    const form = new FormData();
    form.set("type", "player_avatar_image");
    form.set("sId", this.ownSteamId);
    form.set("doSub", "1");
    form.set("json", "1");
    form.set("MAX_FILE_SIZE", String(imageBuffer.length));
    form.set("sessionid", this.communitySession.sessionId);
    form.set("avatar", new Blob([imageBuffer], { type: contentType }), "avatar.jpg");
    return form;
  }

  isAvatarUploadSuccess(result) {
    return result?.success === 1 ||
      result?.success === true ||
      result?.success === "1" ||
      result?.success === "true" ||
      result?.success === "True";
  }

  async assertAvatarUploadSucceeded(response) {
    if (!response.ok) {
      throw new Error(`Avatar upload failed with HTTP ${response.status}.`);
    }

    const bodyText = await response.text();
    if (this.isLikelyCommunityLoginHtml(response, bodyText)) {
      throw new Error("Avatar upload failed because the Steam Community session is not authenticated.");
    }

    let result;
    try {
      result = JSON.parse(bodyText);
    } catch {
      throw new Error("Steam returned invalid JSON for the avatar upload.");
    }

    if (!this.isAvatarUploadSuccess(result)) {
      throw new Error(`Steam rejected the avatar update: ${JSON.stringify(result)}`);
    }
  }

  async updateAvatar(name, avatarUrl) {
    console.log("Updating avatar.");
    const imageResponse = await this.fetchWithTimeout(
      avatarUrl,
      { headers: DEFAULT_HEADERS },
      REQUEST_TIMEOUT_MS
    );
    if (!imageResponse.ok) {
      throw new Error(`Avatar download failed with HTTP ${imageResponse.status}.`);
    }

    const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    if (this.downloadImages) {
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_\.]+|[_\.]+$/g, "") || "avatar";
      fs.writeFileSync(
        path.join(AVATAR_DIR, `${Date.now()}_${safeName}.jpg`),
        imageBuffer
      );
    }

    const response = await this.communityFetch(
      `https://steamcommunity.com/actions/FileUploader?type=player_avatar_image&sId=${this.ownSteamId}`,
      {
        method: "POST",
        headers: {
          Referer: "https://steamcommunity.com/my/edit/avatar"
        },
        bodyFactory: () => this.buildAvatarUploadForm(imageBuffer, contentType)
      }
    );

    await this.assertAvatarUploadSucceeded(response);
  }

  async syncProfile(target, { syncName, syncAvatar }) {
    if (syncName) {
      await this.updateDisplayName(target.name);
    }
    if (syncAvatar) {
      await this.updateAvatar(target.name, target.avatarUrl);
    }
    console.log("Profile successfully mirrored.");
  }

  async run() {
    await this.login();

    let firstRun = true;
    for (;;) {
      try {
        const target = await this.getTargetInfo();
        const nameChanged = target.name !== this.state.name;
        const previousAvatarUrl = this.state.avatarUrl ?? this.state.avatar_url;
        const avatarChanged = target.avatarUrl !== previousAvatarUrl;
        const forceSync = firstRun && this.syncOnStart;

        if (nameChanged) {
          console.log(`Name change detected: ${target.name}`);
          this.logHistory({
            ts: Date.now() / 1000,
            type: "name",
            old: this.state.name ?? null,
            new: target.name
          });
        }

        if (avatarChanged) {
          console.log("Avatar change detected.");
          this.logHistory({
            ts: Date.now() / 1000,
            type: "avatar",
            new: target.avatarUrl
          });
        }

        if (nameChanged || avatarChanged || forceSync) {
          await this.syncProfile(
            target,
            {
              syncName: forceSync || nameChanged,
              syncAvatar: forceSync || avatarChanged
            }
          );
          this.state = target;
          this.saveJson(STATE_FILE, this.state);
        }
      } catch (error) {
        console.error(`Mirror cycle failed: ${error.message}`);
      }

      firstRun = false;
      console.log(`Waiting ${this.pollInterval} seconds...`);
      await this.sleep(this.pollInterval * 1000);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  close() {
    if (this.user) {
      try {
        this.user.logOff();
      } catch {
      }
      this.user.removeAllListeners();
    }
    this.user = null;
    this.communitySession = null;
    this.currentRefreshToken = "";
    this.loginReject = null;
  }
}

async function main() {
  const watcher = new SteamMirror();
  await watcher.run();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { SteamMirror };

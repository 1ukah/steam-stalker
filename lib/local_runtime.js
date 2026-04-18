const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const SteamUser = require("steam-user");

const CONFIG_FILE = path.join(__dirname, "..", "config.json");
const STATE_FILE = path.join(__dirname, "..", "state.json");
const HISTORY_FILE = path.join(__dirname, "..", "history.jsonl");
const AVATAR_DIR = path.join(__dirname, "..", "downloaded_avatars");
const SECRET_DIR = path.join(__dirname, "..", ".steam_secrets");
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

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, data, pretty = false) {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(data, null, pretty ? 4 : 0)}\n`,
    "utf8"
  );
}

function logHistory(event) {
  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(event)}\n`, "utf8");
}

function promptInline(question) {
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

function promptHidden(question) {
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

function firstBootSetup() {
  console.log("--- Steam Profile Mirror: First Boot Setup ---");
  const targetProfile = promptInline("Enter target Steam profile URL, vanity ID, or SteamID64");
  const steamUsername = promptInline("Enter your Steam account username");
  const syncOnStart = promptInline("Sync profile immediately? (y/n)").toLowerCase() === "y";
  const downloadImages = promptInline("Download avatar images locally? (y/n)").toLowerCase() === "y";

  const config = {
    target_profile: targetProfile,
    steam_username: steamUsername,
    sync_on_start: syncOnStart,
    download_images: downloadImages,
    poll_interval: 300,
    persona_state: "invisible"
  };
  saveJson(CONFIG_FILE, config, true);
  return config;
}

function requireConfigString(config, key) {
  const value = String(config[key] ?? "").trim();
  if (!value) {
    throw new Error(`Missing \`${key}\` in config.json.`);
  }
  return value;
}

function parsePollInterval(value) {
  const parsed = Number.parseInt(value ?? 300, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("`poll_interval` must be an integer number of seconds.");
  }
  return parsed;
}

function parsePersonaState(value) {
  const normalized = String(value ?? "invisible").trim().toLowerCase();
  if (!Object.hasOwn(PERSONA_STATES, normalized)) {
    throw new Error(
      "`persona_state` must be one of: " + Object.keys(PERSONA_STATES).join(", ")
    );
  }
  return PERSONA_STATES[normalized];
}

function resolveTargetProfileUrl(config) {
  const target = String(
    config.target_profile ??
    config.target_steamid ??
    config.target ??
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

function ensureSecretDir() {
  fs.mkdirSync(SECRET_DIR, { recursive: true });
}

function protectForCurrentUser(plaintext) {
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

function unprotectForCurrentUser(ciphertext) {
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

function loadStoredAuth() {
  if (!fs.existsSync(AUTH_FILE)) {
    return null;
  }

  try {
    const protectedBlob = fs.readFileSync(AUTH_FILE, "utf8").trim();
    if (!protectedBlob) {
      return null;
    }
    return JSON.parse(unprotectForCurrentUser(protectedBlob));
  } catch (error) {
    console.warn(`Stored refresh token could not be read: ${error.message}`);
    return null;
  }
}

function saveStoredAuth(steamUsername, refreshToken, steamId) {
  if (!refreshToken) {
    return;
  }

  ensureSecretDir();
  const payload = {
    steam_username: steamUsername,
    refresh_token: refreshToken,
    steam_id: steamId
  };
  const protectedBlob = protectForCurrentUser(JSON.stringify(payload));
  fs.writeFileSync(AUTH_FILE, `${protectedBlob}\n`, "utf8");
}

function clearStoredAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    fs.unlinkSync(AUTH_FILE);
  }
}

module.exports = {
  AUTH_FILE,
  AVATAR_DIR,
  CONFIG_FILE,
  DEFAULT_HEADERS,
  HISTORY_FILE,
  LOGIN_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SECRET_DIR,
  STATE_FILE,
  WEB_SESSION_TIMEOUT_MS,
  XML_TIMEOUT_MS,
  clearStoredAuth,
  firstBootSetup,
  loadJson,
  loadStoredAuth,
  logHistory,
  parsePersonaState,
  parsePollInterval,
  promptHidden,
  promptInline,
  requireConfigString,
  resolveTargetProfileUrl,
  saveJson,
  saveStoredAuth
};

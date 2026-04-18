const fs = require("node:fs");
const path = require("node:path");
const runtime = require("./local_runtime");
const punMode = require("./pun_mode");
const steamSession = require("./steam_session");

function extractXmlField(xml, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const match = xml.match(pattern);
  if (!match) {
    return "";
  }

  return normalizeXmlText(match[1]);
}

function normalizeXmlText(value) {
  const trimmed = String(value ?? "").trim();
  const decoded = decodeXml(trimmed);
  return stripCdata(decoded).trim();
}

function stripCdata(value) {
  const match = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return match ? match[1] : value;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

async function getProfileXml(app, baseUrl) {
  const response = await steamSession.fetchWithTimeout(
    `${baseUrl.replace(/\/+$/, "")}/?xml=1`,
    { headers: runtime.DEFAULT_HEADERS },
    runtime.XML_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`Steam returned HTTP ${response.status} for ${baseUrl}`);
  }

  const xml = await response.text();
  const error = extractXmlField(xml, "error");
  if (error) {
    throw new Error(`Steam profile lookup failed for ${baseUrl}: ${error}`);
  }
  return xml;
}

async function getTargetInfo(app) {
  const xml = await getProfileXml(app, app.targetProfileUrl);
  const avatarUrl =
    extractXmlField(xml, "avatarFull") ||
    extractXmlField(xml, "avatarMedium") ||
    extractXmlField(xml, "avatarIcon");
  const name = extractXmlField(xml, "steamID");

  if (!name || !avatarUrl) {
    throw new Error("Missing profile name or avatar in target XML.");
  }

  return { name, avatarUrl };
}

function waitForAccountName(app, name) {
  if (!app.user) {
    throw new Error("Steam client is not connected.");
  }
  const user = app.user;
  if (user.accountInfo?.name === name) {
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

async function updateDisplayName(app, name) {
  console.log(`Updating display name to: ${name}`);
  app.user.setPersona(app.personaState, name);
  await waitForAccountName(app, name);
}

function buildAvatarUploadForm(app, imageBuffer, contentType) {
  if (!app.communitySession?.sessionId) {
    throw new Error("Steam Community session is not ready.");
  }

  const form = new FormData();
  form.set("type", "player_avatar_image");
  form.set("sId", app.ownSteamId);
  form.set("doSub", "1");
  form.set("json", "1");
  form.set("MAX_FILE_SIZE", String(imageBuffer.length));
  form.set("sessionid", app.communitySession.sessionId);
  form.set("avatar", new Blob([imageBuffer], { type: contentType }), "avatar.jpg");
  return form;
}

function isAvatarUploadSuccess(result) {
  return result?.success === 1 ||
    result?.success === true ||
    result?.success === "1" ||
    result?.success === "true" ||
    result?.success === "True";
}

async function assertAvatarUploadSucceeded(response) {
  if (!response.ok) {
    throw new Error(`Avatar upload failed with HTTP ${response.status}.`);
  }

  const bodyText = await response.text();
  if (steamSession.isLikelyCommunityLoginHtml(response, bodyText)) {
    throw new Error("Avatar upload failed because the Steam Community session is not authenticated.");
  }

  let result;
  try {
    result = JSON.parse(bodyText);
  } catch {
    throw new Error("Steam returned invalid JSON for the avatar upload.");
  }

  if (!isAvatarUploadSuccess(result)) {
    throw new Error(`Steam rejected the avatar update: ${JSON.stringify(result)}`);
  }
}

async function updateAvatar(app, name, avatarUrl) {
  console.log("Updating avatar.");
  const imageResponse = await steamSession.fetchWithTimeout(
    avatarUrl,
    { headers: runtime.DEFAULT_HEADERS },
    runtime.REQUEST_TIMEOUT_MS
  );
  if (!imageResponse.ok) {
    throw new Error(`Avatar download failed with HTTP ${imageResponse.status}.`);
  }

  const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

  if (app.downloadImages) {
    fs.mkdirSync(runtime.AVATAR_DIR, { recursive: true });
    const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_\.]+|[_\.]+$/g, "") || "avatar";
    fs.writeFileSync(
      path.join(runtime.AVATAR_DIR, `${Date.now()}_${safeName}.jpg`),
      imageBuffer
    );
  }

  const response = await steamSession.communityFetch(
    app,
    `https://steamcommunity.com/actions/FileUploader?type=player_avatar_image&sId=${app.ownSteamId}`,
    {
      method: "POST",
      headers: {
        Referer: "https://steamcommunity.com/my/edit/avatar"
      },
      bodyFactory: () => buildAvatarUploadForm(app, imageBuffer, contentType)
    }
  );

  await assertAvatarUploadSucceeded(response);
}

async function syncProfile(app, target, { desiredName, syncName, syncAvatar }) {
  if (syncName) {
    await updateDisplayName(app, String(desiredName ?? target.name));
  }
  if (syncAvatar) {
    await updateAvatar(app, target.name, target.avatarUrl);
  }
  console.log("Profile successfully mirrored.");
}

module.exports = {
  getTargetInfo,
  blendNameWithPunEntries: punMode.blendNameWithPunEntries,
  getDesiredDisplayName: punMode.getDesiredDisplayName,
  loadPunEntries: punMode.loadPunEntries,
  syncProfile
};

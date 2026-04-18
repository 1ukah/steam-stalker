const runtime = require("./local_runtime");
const steamSession = require("./steam_session");
const profileSync = require("./profile_sync");

class SteamMirrorApp {
  constructor() {
    this.config = runtime.loadJson(runtime.CONFIG_FILE);
    this.state = runtime.loadJson(runtime.STATE_FILE);
    this.user = null;
    this.communitySession = null;
    this.ownSteamId = "";
    this.currentRefreshToken = "";
    this.loginReject = null;

    if (Object.keys(this.config).length === 0) {
      this.config = runtime.firstBootSetup();
    }

    this.steamUsername = runtime.requireConfigString(this.config, "steam_username");
    this.targetProfileUrl = runtime.resolveTargetProfileUrl(this.config);
    this.syncOnStart = Boolean(this.config.sync_on_start ?? true);
    this.downloadImages = Boolean(this.config.download_images ?? true);
    this.pollInterval = runtime.parsePollInterval(this.config.poll_interval);
    this.personaState = runtime.parsePersonaState(this.config.persona_state);

    process.on("SIGINT", () => {
      this.close();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      this.close();
      process.exit(143);
    });
  }

  async run() {
    await steamSession.login(this);

    let firstRun = true;
    for (;;) {
      try {
        await this.runMirrorCycle(firstRun);
      } catch (error) {
        console.error(`Mirror cycle failed: ${error.message}`);
      }

      firstRun = false;
      console.log(`Waiting ${this.pollInterval} seconds...`);
      await this.sleep(this.pollInterval * 1000);
    }
  }

  async runMirrorCycle(firstRun) {
    const target = await profileSync.getTargetInfo(this);
    const nameChanged = target.name !== this.state.name;
    const previousAvatarUrl = this.state.avatarUrl ?? this.state.avatar_url;
    const avatarChanged = target.avatarUrl !== previousAvatarUrl;
    const forceSync = firstRun && this.syncOnStart;

    if (nameChanged) {
      console.log(`Name change detected: ${target.name}`);
      runtime.logHistory({
        ts: Date.now() / 1000,
        type: "name",
        old: this.state.name ?? null,
        new: target.name
      });
    }

    if (avatarChanged) {
      console.log("Avatar change detected.");
      runtime.logHistory({
        ts: Date.now() / 1000,
        type: "avatar",
        new: target.avatarUrl
      });
    }

    if (nameChanged || avatarChanged || forceSync) {
      await profileSync.syncProfile(this, target, {
        syncName: forceSync || nameChanged,
        syncAvatar: forceSync || avatarChanged
      });
      this.state = target;
      runtime.saveJson(runtime.STATE_FILE, this.state);
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

module.exports = { SteamMirrorApp };

# Steam Stalker

Steam Stalker mirrors the display name and avatar from a public Steam profile onto your own Steam account. It is a small Windows-oriented Node.js utility built around `steam-user`, and it depends on Steam behavior that can change without notice.

## Requirements

- Windows
- [Node.js 20 or newer](https://nodejs.org/en/download)
- A public target Steam profile
- A Steam account you can log into normally through the official client

## Quick Start

1. Install dependencies:

```powershell
npm.cmd install
```

2. Copy the example config:

```powershell
Copy-Item config.example.json config.json
```

3. Edit `config.json`.
4. Run the watcher:

```powershell
node .
```

On the first successful login, Steam may prompt for your password and Steam Guard code. After that, the script stores a refresh token encrypted with Windows DPAPI under `.steam_secrets/` so later launches can usually reuse the saved login.

## Configuration

Example:

```json
{
    "target_profile": "https://steamcommunity.com/id/example/",
    "steam_username": "your_steam_account_name",
    "sync_on_start": true,
    "download_images": true,
    "poll_interval": 300,
    "persona_state": "invisible"
}
```

- `target_profile`: The Steam profile to mirror. You can use a full Steam Community URL, a vanity name, or a SteamID64.
- `steam_username`: Your Steam account login name.
- `steam_password`: Optional fallback password. If omitted, the script prompts only when the saved refresh token is missing or rejected.
- `sync_on_start`: If `true`, force a sync as soon as the script starts.
- `download_images`: If `true`, save mirrored avatars to `downloaded_avatars/`.
- `poll_interval`: Delay between checks, in seconds.
- `persona_state`: Persona state applied when updating the name through the client protocol. Supported values are `offline`, `online`, `busy`, `away`, `snooze`, `looking_to_trade`, `looking_to_play`, and `invisible`.

## Notes

- Name sync uses the Steam client protocol through `setPersona(...)`. It does not use the general Steam Community profile edit form.
- Avatar sync uses the dedicated Steam Community avatar uploader endpoint and does not submit unrelated profile fields such as vanity URL, summary, or location.
- Steam Community XML is used only to read the target public profile. Valve has deprecated and rate-limited parts of that surface, so target lookups can fail if Steam changes or throttles it.
- This is unofficial Steam automation. It may stop working if Steam changes login, XML, or avatar upload behavior.

## Troubleshooting

### It still asks for password or Steam Guard

- Make sure `.steam_secrets/auth.json.dpapi` was created after a successful login.
- If the saved token exists but Steam keeps rejecting it, delete `.steam_secrets/` and log in again.
- Confirm you are still running under the same Windows user account that created the DPAPI-protected token.

### Name updates fail

- Verify `steam_username` is correct.
- Confirm the account can log in normally through the Steam client.
- If you do not store `steam_password`, make sure you complete the terminal prompt when the script starts.

### Avatar updates fail

- Confirm the target profile exposes a valid avatar URL.
- Re-run the script so it can request a fresh Steam Community web session.

## Security

- Do not store `steam_password` in `config.json` unless you accept that risk.
- Treat `.steam_secrets/` as sensitive local auth material.
- The saved refresh token is encrypted with Windows DPAPI for the current local user and is not stored in plaintext.

## License

Licensed under the [MIT License](./LICENSE).

# Security notes

This tool stores OpenCode/OpenAI session credentials in plaintext JSON because OpenCode itself expects a readable `auth.json` file and the rotator needs refresh tokens to switch accounts.

## Credential files

- `auth.json` is the active OpenCode credential file.
- `accounts.json` is the rotator account pool and contains copied `openai` credentials, including refresh/access tokens.
- By default, new `accounts.json` writes go outside the repository:
  - Windows: `%APPDATA%\opencode-chatgpt-account-rotator\accounts.json`
  - macOS: `~/Library/Application Support/opencode-chatgpt-account-rotator/accounts.json`
  - Linux: `${XDG_CONFIG_HOME:-~/.config}/opencode-chatgpt-account-rotator/accounts.json`
- A legacy repo-local `accounts.json` is only read as a fallback when the new config file does not exist. New writes use the config path unless `ROTATOR_ACCOUNTS_FILE` is set.
- Override paths with `ROTATOR_CONFIG_DIR`, `ROTATOR_ACCOUNTS_FILE`, `ROTATOR_AUTH_FILE`, or `OPENCODE_AUTH_FILE`.

Do not commit, paste, or share these files. File permissions are created as restrictive where the OS honors POSIX-style modes.

## Local API token

The GUI server listens on `127.0.0.1`, but localhost is not an authentication boundary. Every POST requires a per-server token in `x-rotator-token`; the old `x-rotator-client: opencode-tui` bypass is not accepted for mutations.

The browser dashboard receives the token from the local server. The server writes the current local plugin token to the user config `api-token` file for local plugin clients. To override that discovery, copy the server output into `OPENCODE_ROTATOR_TOKEN`. To preconfigure a shared token for both server and plugin, start the server with `ROTATOR_API_TOKEN` and use the same value in the plugin environment.

## Stable account targeting

Dashboard row actions send both the visible index and a server-generated `accountKey`. The server rejects the action with `409` if the account list changed and the index no longer matches the same account.

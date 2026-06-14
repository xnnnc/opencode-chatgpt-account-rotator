# opencode-chatgpt-account-rotator

Local ChatGPT account rotation for OpenCode. This project keeps a private pool of OpenCode ChatGPT auth entries, switches the active OpenCode `auth.json` between saved accounts, checks Codex usage, and provides a small local GUI for daily account management.

Repository: <https://github.com/xnnnc/opencode-chatgpt-account-rotator>

## Who this is for

Use this if you run OpenCode with ChatGPT login and need a local way to manage more than one signed-in account on the same machine. It is designed for one trusted user on one trusted computer. It is not a hosted service, team dashboard, credential broker, or cloud sync tool.

The companion OpenCode plugin is published separately at <https://github.com/xnnnc/opencode-rotator-plugin>. The plugin is not part of this root repository.

## Features

- Save the currently active OpenCode ChatGPT auth entry as a named account.
- List accounts and show which account is active.
- Switch to the next preferred healthy account, or switch to a specific account index.
- Enable, disable, delete, and probe accounts.
- Check Codex usage for all accounts, the active account, or a single account.
- Run a watch process that refreshes expiring auth and rotates when usage crosses the configured threshold.
- Use a browser GUI served locally on `127.0.0.1:4317` by default.
- Keep account IDs masked in the GUI and CLI output where possible.

## How it works

OpenCode stores ChatGPT auth in a local `auth.json` file. This rotator copies the `openai` auth entry into a local account pool, then writes a selected saved entry back to OpenCode's active auth file when you switch accounts.

The project has three main runtime pieces:

- `rotator.mjs` contains the CLI, account pool handling, auth switching, usage checks, and watch loop.
- `server.mjs` starts the local GUI server and exposes local `/api/*` routes that wrap `rotator.mjs` commands.
- `index.html` is the browser dashboard served by `server.mjs`.

The GUI and CLI use the same underlying account pool. The GUI listens on `127.0.0.1:4317` unless you set another port.

## Safety warning

This project handles sensitive local auth state. Treat every runtime auth file as secret.

- `auth.json` is the active OpenCode credential file.
- `accounts.json` is the rotator account pool and contains copied OpenCode/OpenAI credentials.
- These files can contain access tokens, refresh tokens, account IDs, and other private data in plaintext JSON.
- Never commit, paste, upload, screenshot, or share `accounts.json`, `auth.json`, `.env` files, copied auth exports, cookies, tokens, or account IDs.
- The GUI is bound to localhost, but localhost is not a security boundary. Keep it on a trusted machine.
- Mutating GUI API requests require a local per-server token. See [SECURITY.md](SECURITY.md) for the local API token model and exact config paths.

Read [SECURITY.md](SECURITY.md) before publishing, sharing logs, or changing where files are stored.

## Requirements

- Node.js 18 or newer.
- npm.
- OpenCode installed locally.
- At least one OpenCode ChatGPT login created with `opencode auth login`.
- A trusted local machine. Do not expose the GUI server to a network.

## Installation

```sh
git clone https://github.com/xnnnc/opencode-chatgpt-account-rotator.git
cd opencode-chatgpt-account-rotator
npm install
```

The package is marked private because it is intended to be cloned and run locally, not published to npm.

## First account setup

Sign in to OpenCode with ChatGPT:

```sh
opencode auth login
```

Save the active OpenCode auth entry into the rotator account pool:

```sh
npm run add -- "main"
```

To add another account:

1. Switch the active OpenCode login by running `opencode auth login` again and completing the ChatGPT flow for the other account.
2. Save it with a different label:

   ```sh
   npm run add -- "backup"
   ```

3. Check the pool:

   ```sh
   npm run status
   ```

Use labels that help you recognize accounts locally. Do not put secrets, tokens, email addresses, or account IDs in labels if you plan to share terminal output or screenshots.

## GUI usage

Start the local GUI server:

```sh
npm run gui
```

Open this URL in your browser:

```text
http://127.0.0.1:4317
```

On Windows, you can also run `open-gui.bat`. It starts `npm run gui` in a new command window and opens the local URL.

The GUI can:

- Refresh account state.
- Add the current OpenCode auth entry as a saved account.
- Switch to an account from the account table.
- Enable, disable, delete, and probe accounts.
- Fetch usage for one account or all accounts.
- Start and stop the watch process.
- Set the watch usage threshold before starting watch.

The GUI calls `server.mjs`, and `server.mjs` calls the same local rotator commands used by the CLI. It does not publish the app to a public host.

## CLI usage

The npm scripts are thin wrappers around `rotator.mjs`:

```sh
npm run add -- "label"       # save current OpenCode auth as a new account
npm run status                # list accounts and show the active account
npm run switch                # switch to the next preferred healthy account
npm run switch -- 1           # switch to account index 1
npm run enable -- 1           # re-enable a disabled account
npm run disable -- 1          # disable an account
npm run probe -- 1            # try restoring a cooldown account
npm run usage                 # fetch usage for all accounts
npm run watch                 # monitor token expiry and usage threshold
npm run gui                   # start the local browser GUI
```

Useful direct CLI forms:

```sh
node rotator.mjs delete 1
node rotator.mjs usage 1 --json
node rotator.mjs usage --all --json
node rotator.mjs watch --interval 30000
```

`npm run usage` maps to `node rotator.mjs usage --all`.

`watch` uses a default usage threshold of 95 percent. Override it with `CODEX_USAGE_THRESHOLD_PERCENT`, or set a threshold in the GUI before starting watch.

## Environment variables and config paths

### Common environment variables

| Variable | Purpose |
| --- | --- |
| `ROTATOR_GUI_PORT` | Changes the GUI port. Default: `4317`. |
| `ROTATOR_CONFIG_DIR` | Changes the config directory used by the rotator. |
| `ROTATOR_ACCOUNTS_FILE` | Uses a specific account pool file instead of the default `accounts.json` path. |
| `ROTATOR_AUTH_FILE` | Uses a specific OpenCode auth file. |
| `OPENCODE_AUTH_FILE` | Alternate override for the OpenCode auth file. |
| `CODEX_USAGE_THRESHOLD_PERCENT` | Changes the watch usage threshold. Default: `95`. |
| `ROTATOR_API_TOKEN` | Preconfigures the local GUI API mutation token. |
| `OPENCODE_ROTATOR_TOKEN` | Token used by external local clients, such as the separate plugin, when talking to the GUI server. |

### Account pool path

The rotator resolves the account pool path in this order:

1. `ROTATOR_ACCOUNTS_FILE`, when set.
2. Repo-local `accounts.json`, when it exists.
3. User config `accounts.json` outside the repository.

That means a local `accounts.json` in the repository is preferred over the user config copy, matching the original working project behavior.

- Windows: `%APPDATA%\opencode-chatgpt-account-rotator\accounts.json`
- macOS: `~/Library/Application Support/opencode-chatgpt-account-rotator/accounts.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/opencode-chatgpt-account-rotator/accounts.json`

New writes follow the same resolved path unless `ROTATOR_ACCOUNTS_FILE` is set.

### Changing the GUI port

macOS or Linux:

```sh
ROTATOR_GUI_PORT=4320 npm run gui
```

PowerShell:

```powershell
$env:ROTATOR_GUI_PORT = "4320"; npm run gui
```

Then open `http://127.0.0.1:4320`.

## Project layout

```text
.
|-- README.md           # Project documentation
|-- SECURITY.md         # Plaintext auth, local API token, and path notes
|-- index.html          # Browser UI served by server.mjs
|-- server.mjs          # Local HTTP server and GUI API wrapper
|-- rotator.mjs         # Core CLI, account pool, usage, and rotation logic
|-- open-gui.bat        # Windows helper that starts the GUI and opens the URL
|-- package.json        # npm scripts and repository metadata
|-- package-lock.json   # npm lockfile
|-- LICENSE             # MIT license
`-- opencode-rotator-plugin/  # Separate plugin project, excluded from this repo
```

Runtime files such as `accounts.json`, `auth.json`, and `.env` files are local only and must stay out of git.

## Separate plugin repository

The OpenCode plugin lives at <https://github.com/xnnnc/opencode-rotator-plugin>.

The root `.gitignore` excludes `opencode-rotator-plugin/` because that plugin is published separately. Do not mix plugin source, plugin build output, or plugin dependencies into this root app repository.

## Troubleshooting

### `No openai entry found in auth.json`

Run `opencode auth login`, finish the ChatGPT login flow, then run:

```sh
npm run add -- "label"
```

### `npm run add` saved the wrong account

The rotator saves whatever ChatGPT auth entry is currently active in OpenCode's auth file. Run `opencode auth login` for the intended account, then run `npm run add -- "label"` again.

### GUI says auth is missing

The GUI reads OpenCode auth from the platform-aware OpenCode auth path, or from `ROTATOR_AUTH_FILE` / `OPENCODE_AUTH_FILE` when set. Make sure OpenCode is installed for the same OS user and that `opencode auth login` has completed.

### Port 4317 is already in use

Stop the other process or start the GUI with another port:

```sh
ROTATOR_GUI_PORT=4320 npm run gui
```

PowerShell:

```powershell
$env:ROTATOR_GUI_PORT = "4320"; npm run gui
```

### Usage checks fail

Usage checks call the ChatGPT Codex usage endpoint with saved account auth. Confirm the account is still valid, run `npm run status`, and try `npm run probe -- <index>` for cooldown accounts after their cooldown expires.

### Watch does not switch accounts

Check that another account is enabled and healthy. Disabled accounts are skipped. Accounts over the usage threshold may be deprioritized until their usage window resets.

### GUI or plugin mutation requests fail

Mutating local API calls require the current `x-rotator-token`. Restarting the GUI server creates a new token unless `ROTATOR_API_TOKEN` is set. The server also writes the current local plugin token to the user config `api-token` file so the separate TUI plugin can pick it up without copying the console value. See [SECURITY.md](SECURITY.md) for details.

## Publishing and security checklist

Before publishing this repository to <https://github.com/xnnnc/opencode-chatgpt-account-rotator>, check the following:

- `README.md`, `package.json`, and any visible metadata point to `xnnnc`, not placeholder usernames.
- `git status` does not include `accounts.json`, `auth.json`, `.env`, logs, screenshots, copied auth exports, cookies, tokens, or account IDs.
- `opencode-rotator-plugin/` is not included in the root repository. Publish it from <https://github.com/xnnnc/opencode-rotator-plugin> instead.
- `SECURITY.md` is present and reviewed.
- The GUI still binds to `127.0.0.1` by default.
- No example command includes real secrets, tokens, cookies, or account IDs.

Report issues at <https://github.com/xnnnc/opencode-chatgpt-account-rotator/issues>.

## License

MIT. See [LICENSE](LICENSE).

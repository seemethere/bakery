# Local network access

The default install path is local-only; start with the root [`README.md`](../README.md) quickstart or the full [first-run quickstart](quickstart.md) if you have not run Bakery on this machine yet. The [operation guide](operation.md) explains the workspace/session safety model behind these commands.

When you expose Bakery beyond loopback, run the API with an auth token, bind both dev servers to the LAN interface, and keep `PI_WEB_WORKSPACE_ROOT` scoped to the project you want the agent to edit.

## 1. Make the hostname resolve

The simplest LAN URL is this machine's IP address, which `bun run doctor --lan` prints for you.

If you prefer a hostname, point your own DNS name at this machine's LAN IP using your router/DNS, or add a hosts-file entry on each client device:

```text
192.168.1.123 bakery.local
```

Replace `192.168.1.123` with this machine's current LAN IP. On macOS you can usually find it with:

```bash
ipconfig getifaddr en0
```

Note: plain `.local` hostnames are often handled by mDNS/Bonjour. Nested names generally need router DNS or hosts-file configuration unless your network already provides them.

If you use a custom hostname with Vite, allow it explicitly:

```bash
PI_WEB_VITE_ALLOWED_HOSTS=bakery.local bun run dev:web:lan
```

For the single-command LAN script, export the variable first:

```bash
export PI_WEB_VITE_ALLOWED_HOSTS=bakery.local
```

## 2. Check the LAN setup

Choose a token and keep it out of shell history if needed:

```bash
export PI_WEB_AUTH_TOKEN="change-me"
PI_WEB_WORKSPACE_ROOT="$PWD" bun run doctor --lan
```

The doctor prints detected LAN URLs and fails if LAN mode would be exposed without a token.

## 3. Start the LAN dev servers

The single-command LAN path restarts the managed backend with `PI_WEB_HOST=0.0.0.0`, then starts Vite on the LAN interface:

```bash
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:lan
```

Without `PI_WEB_AUTH_TOKEN`, non-localhost API requests are intentionally rejected.

If you need separate terminals, run `PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:server:lan` for the API and `bun run dev:web:lan` for Vite.

## 4. Open the app

Open one of the LAN URLs printed by the doctor, for example:

```text
http://192.168.1.123:5173
```

In the app settings, enter the same API token. On first load from a LAN host, the browser defaults the API URL to the same host on port `3141`, for example:

```text
http://192.168.1.123:3141
```

If you previously saved a different API URL in settings, update it manually.

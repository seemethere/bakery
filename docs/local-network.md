# Local network access: bakery.lot.local

The app is local-first. When you expose it beyond loopback, run the API with an auth token and bind both dev servers to the LAN interface.

## 1. Make the hostname resolve

Point `bakery.lot.local` at this machine's LAN IP using your router/DNS, or add a hosts-file entry on each client device:

```text
192.168.1.123 bakery.lot.local
```

Replace `192.168.1.123` with this machine's current LAN IP. On macOS you can usually find it with:

```bash
ipconfig getifaddr en0
```

Note: plain `.local` hostnames are often handled by mDNS/Bonjour. A nested name like `bakery.lot.local` generally needs router DNS or hosts-file configuration unless your network already provides it.

## 2. Start the API for LAN access

Choose a token and keep it out of shell history if needed:

```bash
export PI_WEB_AUTH_TOKEN="change-me"
PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:server:lan
```

`dev:server:lan` binds the Fastify API to `0.0.0.0:3141`. Without `PI_WEB_AUTH_TOKEN`, non-localhost requests are intentionally rejected.

## 3. Start the web dev server for bakery.lot.local

In a second terminal:

```bash
bun run dev:web:lan
```

`dev:web:lan` binds Vite to `0.0.0.0:5173` and allows the `bakery.lot.local` host header.

## 4. Open the app

Open:

```text
http://bakery.lot.local:5173
```

In the app settings, enter the same API token. On first load from `bakery.lot.local`, the browser defaults the API URL to:

```text
http://bakery.lot.local:3141
```

If you previously saved a different API URL in settings, update it manually.

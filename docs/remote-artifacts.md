# Remote screenshot artifact uploads

Bakery can preview screenshots created on a remote agent machine when the remote side uploads the image bytes to the Bakery backend and then mentions the same remote path in the transcript.

## Prerequisites

Run the Bakery API somewhere the remote machine can reach it. For LAN development, see `docs/local-network.md`.

If the API is token-protected, export the token on the remote machine:

```bash
export PI_WEB_AUTH_TOKEN=...
```

## Upload a screenshot

From this repository checkout on the remote machine, run:

```bash
bun run artifact:upload -- \
  --api http://192.168.1.123:3141 \
  --session <bakery-session-id> \
  --path /remote/agent/workspace/screenshots/final.png \
  /remote/agent/workspace/screenshots/final.png
```

You can also use environment variables:

```bash
export PI_WEB_API_BASE=http://192.168.1.123:3141
export PI_WEB_SESSION_ID=<bakery-session-id>
bun run artifact:upload -- --path /remote/agent/workspace/screenshots/final.png /remote/agent/workspace/screenshots/final.png
```

The command prints the stored artifact metadata and preview URL as JSON.

## Render it in the transcript

After upload, mention the exact same `--path` value in the agent response or tool output:

```text
Screenshot: /remote/agent/workspace/screenshots/final.png
```

Markdown image links also work:

```markdown
![final screenshot](file:///remote/agent/workspace/screenshots/final.png)
```

Bakery rewrites that path to `/api/sessions/:id/artifacts/raw?path=...` and renders the stored image preview.

## Limits and security

- Supported image types: PNG, JPEG, GIF, WebP, SVG.
- Max upload size: 20 MiB.
- Artifacts are scoped to one Bakery session.
- Artifact files are stored under `PI_WEB_ARTIFACT_DIR` or `$PI_WEB_DATA_DIR/artifacts`.
- Uploading an artifact does not grant access to arbitrary remote files; only uploaded image bytes are served.

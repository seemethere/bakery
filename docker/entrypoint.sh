#!/usr/bin/env bash
set -euo pipefail

sanitize_container_path() {
  local home_dir="$1"
  local agent_bin="${home_dir}/.pi/agent/bin"
  local npm_bin="${NPM_CONFIG_PREFIX:-}/bin"
  local existing_path="${PATH:-}"
  local rebuilt_path=""
  local entry=""

  IFS=":" read -r -a path_entries <<< "$existing_path"
  for entry in "${path_entries[@]}"; do
    if [[ -z "$entry" || "$entry" == "$agent_bin" || "$entry" == "$npm_bin" ]]; then
      continue
    fi
    case ":$rebuilt_path:" in
      *":$entry:"*) continue ;;
    esac
    rebuilt_path="${rebuilt_path:+$rebuilt_path:}$entry"
  done

  export PATH="$BUN_INSTALL/bin${npm_bin:+:$npm_bin}:/usr/local/bin:/usr/bin:/bin${rebuilt_path:+:$rebuilt_path}"
}

prepare_pi_agent_overlay() {
  local source_agent_dir="$1/.pi/agent"
  local overlay_agent_dir="${PI_WEB_CONTAINER_AGENT_DIR:-/workspace/.bakery-data/pi-agent}"
  local entry=""

  mkdir -p "$source_agent_dir" "$overlay_agent_dir/bin"

  for entry in auth.json models.json prompts themes sessions skills extensions; do
    if [[ -e "$source_agent_dir/$entry" && ! -e "$overlay_agent_dir/$entry" ]]; then
      ln -s "$source_agent_dir/$entry" "$overlay_agent_dir/$entry"
    fi
  done

  prepare_container_settings "$source_agent_dir/settings.json" "$overlay_agent_dir/settings.json"
  link_pi_runtime_module_roots "$source_agent_dir" "$overlay_agent_dir"

  mkdir -p "$source_agent_dir/sessions"
  if [[ ! -e "$overlay_agent_dir/sessions" ]]; then
    ln -s "$source_agent_dir/sessions" "$overlay_agent_dir/sessions"
  fi

  ln -sf /usr/local/bin/fd "$overlay_agent_dir/bin/fd"
  ln -sf /usr/bin/rg "$overlay_agent_dir/bin/rg"
  export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$overlay_agent_dir}"
}

prepare_container_settings() {
  local source_settings="$1"
  local target_settings="$2"
  local excluded_packages="${PI_WEB_CONTAINER_EXCLUDED_PACKAGES:-npm:@howaboua/pi-codex-conversion,@howaboua/pi-codex-conversion}"

  if [[ ! -e "$source_settings" ]]; then
    return
  fi

  # Container Bakery runs the pi SDK in Bun. Some host-global pi npm packages
  # install Node native modules that currently crash Bun when imported. Keep the
  # host settings file untouched, but filter known-incompatible packages out of
  # the container overlay by default. Set PI_WEB_CONTAINER_EXCLUDED_PACKAGES=""
  # to opt back into exact host package settings.
  if [[ -z "$excluded_packages" ]]; then
    if [[ ! -e "$target_settings" ]]; then
      ln -s "$source_settings" "$target_settings"
    fi
    return
  fi

  rm -f "$target_settings"
  SOURCE_SETTINGS="$source_settings" TARGET_SETTINGS="$target_settings" EXCLUDED_PACKAGES="$excluded_packages" python3 - <<'PY'
import json
import os

source = os.environ["SOURCE_SETTINGS"]
target = os.environ["TARGET_SETTINGS"]
excluded = {item.strip() for item in os.environ.get("EXCLUDED_PACKAGES", "").split(",") if item.strip()}

with open(source, "r", encoding="utf-8") as f:
    data = json.load(f)

packages = data.get("packages")
if isinstance(packages, list):
    normalized = []
    seen_sources = set()
    package_replacements = {
        "github.com/nicobailon/pi-subagents": "npm:pi-subagents",
        "github.com/nicobailon/pi-intercom": "npm:pi-intercom",
    }

    def source_of(pkg):
        if isinstance(pkg, str):
            return pkg
        if isinstance(pkg, dict) and isinstance(pkg.get("source"), str):
            return pkg["source"]
        return None

    def normalize_source(source):
        for needle, replacement in package_replacements.items():
            if needle in source:
                return replacement
        return source

    for pkg in packages:
        source = source_of(pkg)
        if isinstance(source, str) and source in excluded:
            continue
        if isinstance(source, str):
            normalized_source = normalize_source(source)
            if normalized_source in excluded or normalized_source in seen_sources:
                continue
            seen_sources.add(normalized_source)
            if isinstance(pkg, str):
                normalized.append(normalized_source)
            elif normalized_source != source:
                replacement = dict(pkg)
                replacement["source"] = normalized_source
                normalized.append(replacement)
            else:
                normalized.append(pkg)
        else:
            normalized.append(pkg)

    data["packages"] = normalized

with open(target, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

ensure_symlink() {
  local source_path="$1"
  local target_path="$2"

  if [[ -L "$target_path" || ! -e "$target_path" ]]; then
    ln -sfn "$source_path" "$target_path"
    return
  fi

  if [[ -d "$target_path" && -z "$(find "$target_path" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    rmdir "$target_path"
    ln -s "$source_path" "$target_path"
    return
  fi

  echo "Warning: refusing to replace non-empty path with symlink: $target_path" >&2
}

link_pi_runtime_module_roots() {
  local source_agent_dir="${1:-$HOME/.pi/agent}"
  local overlay_agent_dir="${2:-${PI_CODING_AGENT_DIR:-${PI_WEB_CONTAINER_AGENT_DIR:-/workspace/.bakery-data/pi-agent}}}"
  local workspace_node_modules="${PI_WEB_CONTAINER_NODE_MODULES:-/workspace/bakery/node_modules}"
  local global_node_modules="${NPM_CONFIG_PREFIX:-/workspace/.bakery-data/npm-global}/lib/node_modules"
  local pkg=""
  local source_pkg=""
  local target_pkg=""

  # Pi packages intentionally declare Pi runtime imports as peer dependencies.
  # In the container, globally installed packages and the overlayed ~/.pi/agent
  # directory sit outside the workspace, so Node's normal parent-directory lookup
  # cannot see /workspace/bakery/node_modules. Link the host runtime modules into
  # those module roots so child `pi` processes and auto-loaded extensions resolve
  # the same Pi SDK/TUI packages as Bakery itself. The package-level symlinks are
  # created even before `bun install` populates a fresh node_modules volume; their
  # targets become valid once install completes later in the container command.
  mkdir -p "$source_agent_dir" "$overlay_agent_dir" "$global_node_modules/@earendil-works"
  ensure_symlink "$workspace_node_modules" "$source_agent_dir/node_modules"
  ensure_symlink "$workspace_node_modules" "$overlay_agent_dir/node_modules"

  for pkg in pi-agent-core pi-ai pi-coding-agent pi-tui; do
    source_pkg="$workspace_node_modules/@earendil-works/$pkg"
    target_pkg="$global_node_modules/@earendil-works/$pkg"
    ensure_symlink "$source_pkg" "$target_pkg"
  done
}

user_name="${PI_WEB_CONTAINER_USER:-bakery}"
home_dir="${PI_WEB_CONTAINER_HOME:-/home/${user_name}}"
uid_value="${PI_WEB_CONTAINER_UID:-1000}"
gid_value="${PI_WEB_CONTAINER_GID:-1000}"

if [[ "$(id -u)" != "0" ]]; then
  export HOME="${HOME:-$home_dir}"
  export BUN_INSTALL="${BUN_INSTALL:-$home_dir/.bun}"
  export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/workspace/.bakery-data/npm-global}"
  link_pi_runtime_module_roots "$HOME/.pi/agent" "${PI_CODING_AGENT_DIR:-${PI_WEB_CONTAINER_AGENT_DIR:-/workspace/.bakery-data/pi-agent}}"
  sanitize_container_path "$home_dir"
  exec "$@"
fi

if ! [[ "$uid_value" =~ ^[0-9]+$ ]] || ! [[ "$gid_value" =~ ^[0-9]+$ ]]; then
  echo "PI_WEB_CONTAINER_UID and PI_WEB_CONTAINER_GID must be numeric." >&2
  exit 64
fi

# Reuse or create a group matching the host GID so bind-mounted files keep
# sensible ownership on Linux hosts. macOS/OrbStack also tolerates this path.
group_name="$(getent group "$gid_value" | cut -d: -f1 || true)"
if [[ -z "$group_name" ]]; then
  group_name="$user_name"
  if getent group "$group_name" >/dev/null; then
    groupmod -g "$gid_value" "$group_name"
  else
    groupadd -g "$gid_value" "$group_name"
  fi
fi

if id "$user_name" >/dev/null 2>&1; then
  usermod -u "$uid_value" -g "$gid_value" -d "$home_dir" -s /bin/bash "$user_name"
else
  useradd -m -u "$uid_value" -g "$gid_value" -d "$home_dir" -s /bin/bash "$user_name"
fi

mkdir -p "$home_dir" /workspace/bakery /workspace/bakery/node_modules /workspace/.bakery-data /workspace/.cache/bun
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/workspace/.bakery-data/npm-global}"
mkdir -p "$NPM_CONFIG_PREFIX"
# Do not recursively chown HOME: it may contain host mounts like ~/.pi.
chown "$uid_value:$gid_value" "$home_dir" 2>/dev/null || true
chown -R "$uid_value:$gid_value" /workspace/.cache /workspace/.bakery-data /workspace/bakery/node_modules "$NPM_CONFIG_PREFIX"

add_socket_group_for_user() {
  local socket_path="$1"
  local fallback_group_name="$2"
  local socket_gid=""
  local socket_group=""

  if [[ -S "$socket_path" ]]; then
    socket_gid="$(stat -c '%g' "$socket_path" 2>/dev/null || true)"
    if [[ "$socket_gid" =~ ^[0-9]+$ ]]; then
      socket_group="$(getent group "$socket_gid" | cut -d: -f1 || true)"
      if [[ -z "$socket_group" ]]; then
        socket_group="$fallback_group_name"
        groupadd -g "$socket_gid" "$socket_group" 2>/dev/null || true
      fi
      usermod -aG "$socket_gid" "$user_name" 2>/dev/null || true
    fi
  fi
}

# Keep privileged host sockets opt-in at compose level, but make them usable by
# the mapped user when mounted. Failure here should not block other workflows.
add_socket_group_for_user /var/run/docker.sock docker-host
if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
  add_socket_group_for_user "$SSH_AUTH_SOCK" ssh-agent-host
fi

export HOME="$home_dir"
export BUN_INSTALL="${BUN_INSTALL:-$home_dir/.bun}"
prepare_pi_agent_overlay "$home_dir"
case "$PI_CODING_AGENT_DIR" in
  /workspace/.bakery-data/*) chown -R "$uid_value:$gid_value" "$PI_CODING_AGENT_DIR" 2>/dev/null || true ;;
esac
sanitize_container_path "$home_dir"

exec gosu "$user_name" "$@"

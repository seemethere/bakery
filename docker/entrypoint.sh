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

  for entry in auth.json settings.json models.json prompts themes sessions skills extensions; do
    if [[ -e "$source_agent_dir/$entry" && ! -e "$overlay_agent_dir/$entry" ]]; then
      ln -s "$source_agent_dir/$entry" "$overlay_agent_dir/$entry"
    fi
  done

  mkdir -p "$source_agent_dir/sessions"
  if [[ ! -e "$overlay_agent_dir/sessions" ]]; then
    ln -s "$source_agent_dir/sessions" "$overlay_agent_dir/sessions"
  fi

  ln -sf /usr/local/bin/fd "$overlay_agent_dir/bin/fd"
  ln -sf /usr/bin/rg "$overlay_agent_dir/bin/rg"
  export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$overlay_agent_dir}"
}

user_name="${PI_WEB_CONTAINER_USER:-bakery}"
home_dir="${PI_WEB_CONTAINER_HOME:-/home/${user_name}}"
uid_value="${PI_WEB_CONTAINER_UID:-1000}"
gid_value="${PI_WEB_CONTAINER_GID:-1000}"

if [[ "$(id -u)" != "0" ]]; then
  export HOME="${HOME:-$home_dir}"
  export BUN_INSTALL="${BUN_INSTALL:-$home_dir/.bun}"
  export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/workspace/.bakery-data/npm-global}"
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

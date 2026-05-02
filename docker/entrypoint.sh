#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  exec "$@"
fi

user_name="${PI_WEB_CONTAINER_USER:-bakery}"
home_dir="${PI_WEB_CONTAINER_HOME:-/home/${user_name}}"
uid_value="${PI_WEB_CONTAINER_UID:-1000}"
gid_value="${PI_WEB_CONTAINER_GID:-1000}"

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
# Do not recursively chown HOME: it may contain host mounts like ~/.pi.
chown "$uid_value:$gid_value" "$home_dir" 2>/dev/null || true
chown -R "$uid_value:$gid_value" /workspace/.cache /workspace/.bakery-data /workspace/bakery/node_modules

# Keep the Docker socket opt-in at compose level, but make it usable by the
# mapped user when mounted. Failure here should not block non-Docker workflows.
if [[ -S /var/run/docker.sock ]]; then
  socket_gid="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
  if [[ "$socket_gid" =~ ^[0-9]+$ ]]; then
    socket_group="$(getent group "$socket_gid" | cut -d: -f1 || true)"
    if [[ -z "$socket_group" ]]; then
      socket_group="docker-host"
      groupadd -g "$socket_gid" "$socket_group" 2>/dev/null || true
    fi
    usermod -aG "$socket_gid" "$user_name" 2>/dev/null || true
  fi
fi

export HOME="$home_dir"
export BUN_INSTALL="${BUN_INSTALL:-$home_dir/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

exec gosu "$user_name" "$@"

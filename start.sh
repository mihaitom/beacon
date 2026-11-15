#!/bin/sh

# Defaults
export CONNECT_URL="${CONNECT_URL:-/api}"
# WEB_PORT is nginx's own listen port (the Beacon web UI); PORT is the
# Python backend's. Only need changing if the defaults are already taken on
# the host — e.g. running a second instance at the same time.
export WEB_PORT="${WEB_PORT:-7070}"
export PORT="${PORT:-7071}"

# The Connect API's token, fresh each start. Nothing outside this container
# needs it: nginx adds it to every request it proxies to the backend (see
# ng.conf.template), and own apps use a device key instead.
CONNECT_INTERNAL_TOKEN="$(/app/.venv/bin/python -c 'import secrets; print(secrets.token_hex(32))')"
export CONNECT_INTERNAL_TOKEN

if [ -z "$SERVER_INTERNAL_URL" ] && [ -z "$NAVIDROME_INTERNAL_URL" ]; then
    echo "WARNING: SERVER_INTERNAL_URL is not set — the proxy (connect/routes/proxy.py)" >&2
    echo "has no Navidrome address to forward /rest, /auth and library requests to." >&2
fi

# Persistent backend files (currently just paired AirPlay 2 credentials) land
# here by default — mount a volume at /data to keep them across container
# recreations/updates. No compose changes needed beyond that volume mount.
export CONNECT_DATA_DIR="${CONNECT_DATA_DIR:-/data}"

# Pairing with another Beacon is for desktop apps (connect/core/server_link.py).
export BEACON_HOSTED=1

# nginx access logging is off by default and only enabled with DEBUG=true,
# matching the Python backend's DEBUG-gated verbose logging.
case "$(printf '%s' "$DEBUG" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) export NGINX_ACCESS_LOG="access_log /dev/stdout connect;" ;;
    *) export NGINX_ACCESS_LOG="access_log off;" ;;
esac

# Alpine nginx reads from /etc/nginx/http.d/, not conf.d/.
# Limit substitution to named vars only so nginx variables like $uri survive.
mkdir -p /etc/nginx/http.d
envsubst '${CONNECT_INTERNAL_TOKEN} ${NGINX_ACCESS_LOG} ${WEB_PORT} ${PORT}' \
    < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/http.d/default.conf

# settings.js is served via alias /etc/nginx/conf.d/settings.js (see ng.conf.template).
mkdir -p /etc/nginx/conf.d
envsubst \
    < /etc/nginx/templates/settings.js.template \
    > /etc/nginx/conf.d/settings.js

# Python backend
(cd /app && .venv/bin/python main.py) &
API_PID=$!

# nginx (keep in background so we can monitor both processes)
nginx -g "daemon off;" &
NGINX_PID=$!

# Whichever of the two processes exits first, stop the other and exit the
# container with that process's exit code, so `restart: unless-stopped`
# actually restarts on a crash of either one.
while true; do
    if ! kill -0 "$API_PID" 2>/dev/null; then
        wait "$API_PID"
        EXIT_CODE=$?
        echo "Backend process exited with code ${EXIT_CODE}. Stopping nginx..."
        kill "$NGINX_PID" 2>/dev/null || true
        wait "$NGINX_PID" 2>/dev/null || true
        exit "$EXIT_CODE"
    fi
    if ! kill -0 "$NGINX_PID" 2>/dev/null; then
        wait "$NGINX_PID"
        EXIT_CODE=$?
        echo "nginx exited with code ${EXIT_CODE}. Stopping backend..."
        kill "$API_PID" 2>/dev/null || true
        wait "$API_PID" 2>/dev/null || true
        exit "$EXIT_CODE"
    fi
    sleep 1
done

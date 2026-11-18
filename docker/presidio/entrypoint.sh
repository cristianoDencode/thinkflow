#!/bin/sh
exec gunicorn --no-control-socket -w "${WORKERS:-1}" -b "0.0.0.0:${PORT:-3000}" --timeout 60 "wsgi:app"

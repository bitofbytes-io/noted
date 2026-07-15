#!/bin/sh
set -eu

cd web
exec npm run e2e

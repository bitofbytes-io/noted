#!/bin/sh
set -eu

cd web
exec npx playwright test --headed

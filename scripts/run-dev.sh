#!/usr/bin/env bash
export MOLF_CLIENT_DIR="${MOLF_CLIENT_DIR:-data/clients}"
exec tsx --env-file-if-exists=.env "$@"

#!/usr/bin/env bash
export MOLF_CREDENTIALS_DIR="${MOLF_CREDENTIALS_DIR:-data/clients}"
exec tsx --env-file-if-exists=.env "$@"

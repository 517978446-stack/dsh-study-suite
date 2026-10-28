#!/bin/bash
# 手动启动本地服务（调试用）。正常情况由登录项自动启动。
BASE="${STUDY_SUITE_HOME:-$HOME/.dsh-study-suite}"
export STUDY_SUITE_WORKSPACE="$BASE"
export STUDY_SUITE_TOOLS="$BASE"
export STUDY_SUITE_SECRETS="$BASE/secrets"
export STUDY_SUITE_NOTES="$BASE/notes"
export STUDY_SUITE_MODELS="$BASE/models"
export PYTHONPATH="$BASE/pylibs"
export CN_INTERPRETER_PORT="${CN_INTERPRETER_PORT:-8791}"
exec python3 "$BASE/serve_translate.py"

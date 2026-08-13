#!/bin/bash
# TokenPool 前端配置注入：从 .env 生成 public/index.html（真实配置版，不进 git）
# 用法：bash scripts/apply-config.sh
set -e
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then echo "缺少 .env，请先 cp .env.example .env 并填写"; exit 1; fi
set -a; source .env; set +a
: "${SUPABASE_URL:?需要在 .env 配置 SUPABASE_URL}"
: "${SUPABASE_PUBLISHABLE_KEY:?需要在 .env 配置 SUPABASE_PUBLISHABLE_KEY}"
: "${TURNSTILE_SITEKEY:?需要在 .env 配置 TURNSTILE_SITEKEY}"
sed -e "s|__SUPABASE_URL__|${SUPABASE_URL}|g" \
    -e "s|__SUPABASE_PUBLISHABLE_KEY__|${SUPABASE_PUBLISHABLE_KEY}|g" \
    -e "s|__TURNSTILE_SITEKEY__|${TURNSTILE_SITEKEY}|g" \
    public/index.example.html > public/index.html
echo "已生成 public/index.html（真实配置版，已 gitignore）"

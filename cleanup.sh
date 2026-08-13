#!/bin/bash
# TokenPool 数据清理 - 每日凌晨 00:10 执行
# 清理 health_checks（保留7天）和 usage_events（保留90天）
# points_ledger 永久保留（账本）
cd /root/project/llm-key-manager
source .env 2>/dev/null || true
# health_checks: 删除7天前
curl -s -X DELETE "${SUPABASE_URL}/rest/v1/health_checks?created_at=lt.$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}"
echo "$(date) cleaned health_checks older than 7 days"
# usage_events: 删除90天前
curl -s -X DELETE "${SUPABASE_URL}/rest/v1/usage_events?created_at=lt.$(date -u -d '90 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}"
echo "$(date) cleaned usage_events older than 90 days"

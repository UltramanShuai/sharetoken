#!/bin/sh
# TokenPool Supabase 直连旁路 v2 - 绕过 v2rayA 透明代理
# 原理: v2rayA tp_rule 有 `meta mark & 0x80 == 0x80 return`(mark 128 跳过代理)
# 本脚本在 mangle output(priority -150, 早于 v2raya 的 nat -105) 给 Supabase IP 的包打 mark 0x80
# → v2raya 的 tp_rule 看到 mark 直接 return → 流量直连
# mark 是包属性跨 table 生效, 不依赖 accept 语义
# 由 systemd timer 每 5 分钟刷新 IP 集合(Cloudflare IP 会变)
set -e
NFT=/usr/sbin/nft
DOMAINS="YOUR-PROJECT.supabase.co api.supabase.com"
TABLE=tpool-bypass

ip4s=""; ip6s=""
for d in $DOMAINS; do
  for ip in $(getent ahostsv4 "$d" | awk '{print $1}' | sort -u); do
    ip4s="$ip4s $ip"
  done
  for ip in $(getent ahostsv6 "$d" | awk '{print $1}' | sort -u); do
    ip6s="$ip6s $ip"
  done
done

RULES=/tmp/tpool-bypass.nft
{
  echo "table inet $TABLE {"
  echo "  set supabase4 { type ipv4_addr; flags interval; elements = {"
  for ip in $ip4s; do echo "    $ip,"; done
  echo "  } }"
  echo "  set supabase6 { type ipv6_addr; flags interval; elements = {"
  for ip in $ip6s; do echo "    $ip,"; done
  echo "  } }"
  echo "  chain mark_out { type filter hook output priority mangle;"
  echo "    ip daddr @supabase4 meta mark set meta mark | 0x80"
  echo "    ip6 daddr @supabase6 meta mark set meta mark | 0x80"
  echo "  }"
  echo "  chain mark_pre { type filter hook prerouting priority mangle;"
  echo "    ip daddr @supabase4 meta mark set meta mark | 0x80"
  echo "    ip6 daddr @supabase6 meta mark set meta mark | 0x80"
  echo "  }"
  echo "}"
} > "$RULES"

$NFT delete table inet $TABLE 2>/dev/null || true
$NFT -f "$RULES"
echo "$(date +%FT%T) bypass loaded: $(echo $ip4s | wc -w) ipv4, $(echo $ip6s | wc -w) ipv6"

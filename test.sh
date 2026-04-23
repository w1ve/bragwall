#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-https://hfsignals.live}"
FROM_REGION="${FROM_REGION:-ENA}"
TO_REGION="${TO_REGION:-AF}"
BANDS="${BANDS:-30m}"
SOLAR="${SOLAR:-0}"
LANGS="${LANGS:-hy hi ar he tr ru ja fr}"
OUT_DIR="${OUT_DIR:-/tmp/hfsignals-audio-test-$(date +%Y%m%d-%H%M%S)}"
CLEAR_LOGS="${CLEAR_LOGS:-1}"
CLEAR_CACHE="${CLEAR_CACHE:-0}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  ./test.sh

Environment overrides:
  BASE="https://hfsignals.live"
  FROM_REGION="ENA"
  TO_REGION="AF"
  BANDS="30m"
  SOLAR="0"
  LANGS="hy hi ar he tr ru ja fr"
  OUT_DIR="/tmp/hfsignals-audio-test"
  CLEAR_LOGS="1"     # 1 clears proxy logs before tests
  CLEAR_CACHE="0"    # 1 clears dynamic audio cache before tests

Examples:
  LANGS="fr de es ja" ./test.sh
  BASE="https://your-domain" CLEAR_CACHE=1 ./test.sh
EOF
  exit 0
fi

mkdir -p "$OUT_DIR"
echo "Output directory: $OUT_DIR"
echo "BASE=$BASE  FROM=$FROM_REGION  TO=$TO_REGION  BANDS=$BANDS  SOLAR=$SOLAR"
echo "LANGS=$LANGS"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if [[ "$CLEAR_LOGS" == "1" ]]; then
    echo "[setup] clearing proxy logs..."
    docker compose exec rbn-smeter sh -lc ': > /var/log/supervisor/proxy.log; : > /var/log/supervisor/proxy-err.log' || true
  fi
  if [[ "$CLEAR_CACHE" == "1" ]]; then
    echo "[setup] clearing dynamic audio cache..."
    docker compose exec rbn-smeter sh -lc '
for f in /tmp/hfsignals-audio-cache/*.mp3; do
  b=$(basename "$f")
  [ "$b" = "waiting-message.mp3" ] && continue
  [ "$b" = "outro-static.mp3" ] && continue
  rm -f "$f"
done
' || true
  fi
fi

pass_count=0
fail_count=0

printf "\n%-7s %-6s %-10s %-6s %-10s %s\n" "LANG" "HTTP" "X-AUDIO" "X-LANG" "SIZE" "FILE"
printf "%-7s %-6s %-10s %-6s %-10s %s\n" "-------" "------" "----------" "------" "----------" "------------------------------"

for lang in $LANGS; do
  headers="$OUT_DIR/h-$lang.txt"
  audio="$OUT_DIR/r-$lang.mp3"
  url="$BASE/audio/propreport?mode=region&from=$FROM_REGION&to=$TO_REGION&bands=$BANDS&lang=$lang&solar=$SOLAR"

  http_code="$(curl -sS -w "%{http_code}" -D "$headers" -o "$audio" "$url" || echo "000")"
  audio_mode="$(awk -F': ' 'tolower($1)=="x-hfsignals-audio"{gsub("\r","",$2);print tolower($2)}' "$headers" | tail -n 1)"
  resp_lang="$(awk -F': ' 'tolower($1)=="x-hfsignals-language"{gsub("\r","",$2);print tolower($2)}' "$headers" | tail -n 1)"
  bytes="$(wc -c < "$audio" | tr -d '[:space:]')"
  size="${bytes}B"

  [[ -n "$audio_mode" ]] || audio_mode="-"
  [[ -n "$resp_lang" ]] || resp_lang="-"

  printf "%-7s %-6s %-10s %-6s %-10s %s\n" "$lang" "$http_code" "$audio_mode" "$resp_lang" "$size" "$audio"

  if [[ "$http_code" == "200" && "${bytes:-0}" -gt 0 ]]; then
    pass_count=$((pass_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi
done

echo
echo "Result: $pass_count passed, $fail_count failed"
echo
echo "Header files: $OUT_DIR/h-*.txt"
echo "Audio files : $OUT_DIR/r-*.mp3"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo
  echo "Relevant proxy log lines:"
  docker compose exec rbn-smeter sh -lc \
    'grep -Ei "translated to |translated-script TTS failed; retrying English fallback|detectedLang=" /var/log/supervisor/proxy.log /var/log/supervisor/proxy-err.log | tail -n 200' || true
fi

if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

ARRL_URL="https://contests.arrl.org"
CQWW_URL="https://cqww.com"
CQWPX_URL="https://cqwpx.com"
USER_AGENT="ham-cert-png-fetcher/1.0"

START_DATE=""
START_YEAR=""
OUT_DIR="./contest-certificate-pngs"
CALLS_RAW=()
CALLS_FILE=""

USE_ARRL=1
USE_CQWW=1
USE_CQWPX=1
DRY_RUN=0
ENABLE_PROMPT=1

REQUEST_DELAY_SECONDS="${REQUEST_DELAY_SECONDS:-0.8}"
MAX_HTTP_ATTEMPTS="${MAX_HTTP_ATTEMPTS:-6}"
SOURCES_SPECIFIED=0
OUTDIR_SPECIFIED=0
DRYRUN_SPECIFIED=0
ARRL_FORMAT_SPECIFIED=0
ARRL_FORMAT="${ARRL_FORMAT:-auto}"
ARRL_EFFECTIVE_FORMAT=""

DOWNLOADED=0
SKIPPED=0
FAILED=0
REQUEST_COUNT=0
RATE_LIMIT_RETRIES=0

declare -A SEEN_CERT_KEYS=()

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME [options]

Required:
  --start-date DATE        Earliest date to include (year-based filtering).
                           If omitted in interactive mode, script will prompt.

Callsign input (use one or both):
  --calls LIST             Comma/space separated callsigns (example: "W1VE,K1IR")
  --calls-file FILE        File with one callsign per line (# comments allowed)

Optional:
  --out-dir DIR            Output directory (default: $OUT_DIR)
  --sources LIST           Comma-separated subset: arrl,cqww,cqwpx
  --arrl-format MODE       ARRL output: auto|png|jpeg (default: auto)
  --dry-run                Print planned downloads without writing files
  --no-prompt              Disable interactive callsign prompts
  -h, --help               Show this help

Notes:
  - ARRL exposes JPEG/PDF links; this script downloads JPEG and converts to PNG.
    If converter is unavailable and format is auto, it saves ARRL as JPEG.
  - CQWW/CQWPX downloads are pulled from printCert.php in PNG mode.
  - Filtering is by contest year extracted from each result row.
  - Rate-limit guard: request pacing + retries with exponential backoff.
  - Override pacing with REQUEST_DELAY_SECONDS env var (default: 0.8).
EOF
}

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

warn() {
  printf '[%s] WARNING: %s\n' "$SCRIPT_NAME" "$*" >&2
}

die() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

wait_for_request_slot() {
  if (( REQUEST_COUNT > 0 )); then
    sleep "$REQUEST_DELAY_SECONDS"
  fi
  ((REQUEST_COUNT+=1))
}

backoff_seconds() {
  local attempt="$1"
  local sec=$((2 ** (attempt - 1)))
  if (( sec > 30 )); then
    sec=30
  fi
  printf '%s' "$sec"
}

sanitize_name() {
  local raw="$1"
  local cleaned
  cleaned="$(printf '%s' "$raw" | tr '[:lower:]' '[:upper:]' | tr -cs 'A-Z0-9._-' '_')"
  cleaned="${cleaned##_}"
  cleaned="${cleaned%%_}"
  if [[ -z "$cleaned" ]]; then
    cleaned="UNKNOWN"
  fi
  printf '%s' "$cleaned"
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

detect_converter() {
  if command -v ffmpeg >/dev/null 2>&1; then
    printf 'ffmpeg'
    return 0
  fi
  if command -v magick >/dev/null 2>&1; then
    printf 'magick'
    return 0
  fi
  if command -v convert >/dev/null 2>&1; then
    printf 'convert'
    return 0
  fi
  printf 'none'
}

convert_to_png() {
  local input="$1"
  local output="$2"
  case "$CONVERTER" in
    ffmpeg)
      ffmpeg -loglevel error -y -i "$input" "$output" >/dev/null 2>&1
      ;;
    magick)
      magick "$input" "$output"
      ;;
    convert)
      convert "$input" "$output"
      ;;
    *)
      return 1
      ;;
  esac
}

is_png() {
  local path="$1"
  python3 -c 'import sys; s=open(sys.argv[1],"rb").read(8); sys.exit(0 if s==b"\x89PNG\r\n\x1a\n" else 1)' "$path"
}

is_jpeg() {
  local path="$1"
  python3 -c 'import sys; s=open(sys.argv[1],"rb").read(2); sys.exit(0 if s==b"\xff\xd8" else 1)' "$path"
}

download_to_file() {
  local url="$1"
  local output="$2"
  local referer=""
  if [[ $# -ge 3 ]]; then
    referer="${3:-}"
    shift 3
  else
    shift 2
  fi
  local -a extra_args=("$@")

  local attempt
  for (( attempt=1; attempt<=MAX_HTTP_ATTEMPTS; attempt++ )); do
    wait_for_request_slot

    local headers_file="${TMP_DIR}/headers_${RANDOM}_${attempt}.txt"

    local curl_args=(
      -sSL
      --connect-timeout 20
      --max-time 120
      -A "$USER_AGENT"
      -D "$headers_file"
      -o "$output"
    )
    if [[ -n "$referer" ]]; then
      curl_args+=(-e "$referer")
    fi
    curl_args+=("${extra_args[@]}")

    local http_code="000"
    local curl_exit=0
    set +e
    curl "${curl_args[@]}" "$url" >/dev/null 2>&1
    curl_exit=$?
    set -e

    if [[ -f "$headers_file" ]]; then
      http_code="$(python3 -c 'import re, sys; d=open(sys.argv[1],"r",encoding="latin1",errors="ignore").read(); m=re.findall(r"^HTTP/[0-9.]+\s+([0-9]{3})", d, flags=re.M); print(m[-1] if m else "000")' "$headers_file")"
      rm -f "$headers_file"
    fi

    if [[ $curl_exit -eq 0 && "$http_code" =~ ^2[0-9][0-9]$ ]]; then
      return 0
    fi

    local should_retry=0
    if [[ $curl_exit -ne 0 ]]; then
      should_retry=1
    fi
    case "$http_code" in
      429|500|502|503|504) should_retry=1 ;;
    esac

    if (( should_retry == 1 )) && (( attempt < MAX_HTTP_ATTEMPTS )); then
      local sleep_sec
      sleep_sec="$(backoff_seconds "$attempt")"
      ((RATE_LIMIT_RETRIES+=1))
      warn "Retrying request (attempt ${attempt}/${MAX_HTTP_ATTEMPTS}, http=${http_code:-curl-error}) after ${sleep_sec}s: ${url}"
      sleep "$sleep_sec"
      continue
    fi

    rm -f "$output"
    return 1
  done

  rm -f "$output"
  return 1
}

mark_cert_seen() {
  local key="$1"
  if [[ -n "${SEEN_CERT_KEYS[$key]:-}" ]]; then
    return 1
  fi
  SEEN_CERT_KEYS["$key"]=1
  return 0
}

parse_sources() {
  local sources="$1"
  USE_ARRL=0
  USE_CQWW=0
  USE_CQWPX=0

  IFS=',' read -r -a parts <<<"$sources"
  for part in "${parts[@]}"; do
    local s
    s="$(trim "$part")"
    s="${s,,}"
    case "$s" in
      arrl) USE_ARRL=1 ;;
      cqww) USE_CQWW=1 ;;
      cqwpx) USE_CQWPX=1 ;;
      "") ;;
      *) die "Unknown source '$s' (valid: arrl,cqww,cqwpx)" ;;
    esac
  done

  if [[ $USE_ARRL -eq 0 && $USE_CQWW -eq 0 && $USE_CQWPX -eq 0 ]]; then
    die "No valid sources selected"
  fi
}

current_sources_csv() {
  local parts=()
  [[ $USE_ARRL -eq 1 ]] && parts+=("arrl")
  [[ $USE_CQWW -eq 1 ]] && parts+=("cqww")
  [[ $USE_CQWPX -eq 1 ]] && parts+=("cqwpx")
  local joined=""
  local p
  for p in "${parts[@]}"; do
    if [[ -z "$joined" ]]; then
      joined="$p"
    else
      joined="${joined},${p}"
    fi
  done
  printf '%s' "$joined"
}

prompt_for_missing_inputs() {
  [[ $ENABLE_PROMPT -eq 1 && -t 0 ]] || return 0

  if [[ -z "$START_DATE" ]]; then
    local d=""
    while true; do
      read -r -p "Start date (YYYY-MM-DD): " d
      d="$(trim "$d")"
      if [[ -z "$d" ]]; then
        echo "Please enter a date."
        continue
      fi
      if date -d "$d" +%Y >/dev/null 2>&1; then
        START_DATE="$d"
        break
      fi
      echo "Invalid date format. Example: 2020-01-01"
    done
  fi

  if [[ $SOURCES_SPECIFIED -eq 0 ]]; then
    local default_sources
    default_sources="$(current_sources_csv)"
    local source_input=""
    read -r -p "Sources [${default_sources}] (arrl,cqww,cqwpx): " source_input || true
    source_input="$(trim "$source_input")"
    if [[ -n "$source_input" ]]; then
      parse_sources "$source_input"
    fi
  fi

  if [[ $OUTDIR_SPECIFIED -eq 0 ]]; then
    local out_input=""
    read -r -p "Output directory [${OUT_DIR}]: " out_input || true
    out_input="$(trim "$out_input")"
    if [[ -n "$out_input" ]]; then
      OUT_DIR="$out_input"
    fi
  fi

  if [[ $DRYRUN_SPECIFIED -eq 0 ]]; then
    local dry_input=""
    read -r -p "Dry run only? [y/N]: " dry_input || true
    dry_input="$(trim "$dry_input")"
    dry_input="${dry_input,,}"
    if [[ "$dry_input" == "y" || "$dry_input" == "yes" ]]; then
      DRY_RUN=1
    fi
  fi

  if [[ $USE_ARRL -eq 1 && $ARRL_FORMAT_SPECIFIED -eq 0 ]]; then
    local arrl_fmt=""
    read -r -p "ARRL output format [auto] (auto/png/jpeg): " arrl_fmt || true
    arrl_fmt="$(trim "$arrl_fmt")"
    if [[ -n "$arrl_fmt" ]]; then
      ARRL_FORMAT="$arrl_fmt"
    fi
  fi
}

collect_callsigns() {
  declare -A seen=()
  local merged=()

  if [[ $ENABLE_PROMPT -eq 1 && -t 0 ]]; then
    if [[ ${#CALLS_RAW[@]} -eq 0 && -z "$CALLS_FILE" ]]; then
      echo
      echo "No callsigns were provided on the command line."
      echo "Include your own call plus possible multi-op station callsigns."
      local prompted=""
      read -r -p "Enter callsigns (comma/space separated): " prompted
      prompted="$(trim "$prompted")"
      [[ -n "$prompted" ]] || die "No callsigns entered"
      CALLS_RAW+=("$prompted")
    else
      local extras=""
      echo
      read -r -p "Optional extra possible callsigns (multi-op station calls, comma/space separated): " extras || true
      extras="$(trim "$extras")"
      if [[ -n "$extras" ]]; then
        CALLS_RAW+=("$extras")
      fi
    fi
  fi

  if [[ ${#CALLS_RAW[@]} -gt 0 ]]; then
    for chunk in "${CALLS_RAW[@]}"; do
      local normalized="${chunk//,/ }"
      for token in $normalized; do
        token="$(sanitize_name "$token")"
        [[ -z "$token" ]] && continue
        if [[ -z "${seen[$token]:-}" ]]; then
          seen["$token"]=1
          merged+=("$token")
        fi
      done
    done
  fi

  if [[ -n "$CALLS_FILE" ]]; then
    [[ -f "$CALLS_FILE" ]] || die "Callsign file not found: $CALLS_FILE"
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="$(trim "$line")"
      [[ -z "$line" ]] && continue
      line="${line//,/ }"
      for token in $line; do
        token="$(sanitize_name "$token")"
        [[ -z "$token" ]] && continue
        if [[ -z "${seen[$token]:-}" ]]; then
          seen["$token"]=1
          merged+=("$token")
        fi
      done
    done <"$CALLS_FILE"
  fi

  if [[ ${#merged[@]} -eq 0 ]]; then
    die "No callsigns were provided"
  fi

  CALLSIGNS=("${merged[@]}")
}

save_arrl_pngs() {
  local query_call="$1"
  log "ARRL lookup for ${query_call}"

  local arrl_html_file="${TMP_DIR}/arrl_${query_call}.html"
  if ! download_to_file "${ARRL_URL}/certificates.php" "$arrl_html_file" "" -X POST --data-urlencode "callsign=${query_call}"; then
    warn "ARRL lookup failed for ${query_call}"
    ((FAILED+=1))
    return 0
  fi
  local html
  html="$(<"$arrl_html_file")"

  local rows
  rows="$(printf '%s' "$html" | perl -0777 -ne 'while (/<tr[^>]*>\s*<td[^>]*>\s*([0-9]{4})[^<]*<\/td>.*?href="(certgen\.php\?mode=jpeg[^"]+)"/sg) { print "$1\t$2\n" }')"
  if [[ -z "$rows" ]]; then
    log "ARRL returned no certificate rows for ${query_call}"
    return 0
  fi

  while IFS=$'\t' read -r year rel_jpeg_url; do
    [[ -z "$year" || -z "$rel_jpeg_url" ]] && continue
    if (( year < START_YEAR )); then
      ((SKIPPED+=1))
      continue
    fi

    local id
    id="$(printf '%s' "$rel_jpeg_url" | sed -n 's/.*[?&]id=\([0-9][0-9]*\).*/\1/p')"
    local cert_call
    cert_call="$(printf '%s' "$rel_jpeg_url" | sed -n 's/.*[?&]call=\([^&]*\).*/\1/p')"
    cert_call="${cert_call:-${query_call}}"
    id="${id:-unknown}"

    local cert_key="ARRL:${id}"
    if ! mark_cert_seen "$cert_key"; then
      ((SKIPPED+=1))
      continue
    fi

    local out_ext="png"
    if [[ "$ARRL_EFFECTIVE_FORMAT" == "jpeg" ]]; then
      out_ext="jpg"
    fi
    local out_name="ARRL_${year}_${cert_call}_id${id}.${out_ext}"
    out_name="$(sanitize_name "$out_name")"
    local out_path="${OUT_DIR}/ARRL/${out_name}"

    if [[ -f "$out_path" ]]; then
      ((SKIPPED+=1))
      continue
    fi

    local jpeg_url="${ARRL_URL}/${rel_jpeg_url}"
    if [[ $DRY_RUN -eq 1 ]]; then
      log "[dry-run] ${jpeg_url} -> ${out_path}"
      ((DOWNLOADED+=1))
      continue
    fi

    local tmp_jpeg="${TMP_DIR}/arrl_${query_call}_${id}.jpg"
    if ! download_to_file "$jpeg_url" "$tmp_jpeg" ""; then
      warn "ARRL download failed: ${jpeg_url}"
      ((FAILED+=1))
      continue
    fi

    if [[ "$ARRL_EFFECTIVE_FORMAT" == "jpeg" ]]; then
      if ! is_jpeg "$tmp_jpeg"; then
        warn "ARRL returned non-JPEG content for ${query_call} (${year})."
        ((FAILED+=1))
        continue
      fi
      mv "$tmp_jpeg" "$out_path"
      ((DOWNLOADED+=1))
      continue
    fi

    if ! convert_to_png "$tmp_jpeg" "$out_path"; then
      warn "Could not convert ARRL JPEG to PNG for ${query_call} (${year})."
      ((FAILED+=1))
      continue
    fi

    if ! is_png "$out_path"; then
      warn "Generated ARRL file is not valid PNG: $out_path"
      rm -f "$out_path"
      ((FAILED+=1))
      continue
    fi

    ((DOWNLOADED+=1))
  done <<<"$rows"
}

save_cq_pngs() {
  local source_name="$1"
  local base_url="$2"
  local query_call="$3"

  log "${source_name} lookup for ${query_call}"

  local search_html_file="${TMP_DIR}/${source_name}_${query_call}.html"
  if ! download_to_file "${base_url}/searchbycall.htm" "$search_html_file" "" -X POST \
    --data-urlencode "Form_Callsign=${query_call}" \
    --data "Form_SearchOps=on" \
    --data "submit=submit"; then
    warn "${source_name} lookup failed for ${query_call}"
    ((FAILED+=1))
    return 0
  fi
  local html
  html="$(<"$search_html_file")"

  local rows
  rows="$(printf '%s' "$html" | perl -0777 -ne "while (/<a href='\\/certificate\\/index\\.htm\\?call=([^&']+)&amp;year=([0-9]{4})&amp;mode=(cw|ph)'/sg) { print \"\$1\\t\$2\\t\$3\\n\" }" | sort -u)"
  if [[ -z "$rows" ]]; then
    log "${source_name} returned no certificate rows for ${query_call}"
    return 0
  fi

  while IFS=$'\t' read -r cert_call year mode; do
    [[ -z "$cert_call" || -z "$year" || -z "$mode" ]] && continue
    if (( year < START_YEAR )); then
      ((SKIPPED+=1))
      continue
    fi

    local mode_token
    if [[ "$mode" == "cw" ]]; then
      mode_token="CW"
    else
      mode_token="SSB"
    fi

    local cert_key="${source_name}:$(printf '%s' "$cert_call" | tr '[:lower:]' '[:upper:]'):${year}:${mode_token}"
    if ! mark_cert_seen "$cert_key"; then
      ((SKIPPED+=1))
      continue
    fi

    local out_name="${source_name}_${year}_${cert_call}_${mode_token}.png"
    out_name="$(sanitize_name "$out_name")"
    local out_path="${OUT_DIR}/${source_name}/${out_name}"

    if [[ -f "$out_path" ]]; then
      ((SKIPPED+=1))
      continue
    fi

    local encoded_call
    encoded_call="$(urlencode "$cert_call")"
    local png_url="${base_url}/certificate/printCert.php?call=${encoded_call}&year=${year}&mode=${mode_token}&fmt=PNG"
    local referer="${base_url}/certificate/index.htm?call=${encoded_call}&year=${year}&mode=${mode}"

    if [[ $DRY_RUN -eq 1 ]]; then
      log "[dry-run] ${png_url} -> ${out_path}"
      ((DOWNLOADED+=1))
      continue
    fi

    local tmp_png="${TMP_DIR}/${source_name}_${query_call}_${year}_${mode}.png"
    if ! download_to_file "$png_url" "$tmp_png" "$referer"; then
      warn "${source_name} PNG download failed: ${png_url}"
      ((FAILED+=1))
      continue
    fi

    if ! is_png "$tmp_png"; then
      warn "${source_name} returned non-PNG content (likely blocked or missing cert): ${cert_call} ${year} ${mode_token}"
      ((FAILED+=1))
      continue
    fi

    mv "$tmp_png" "$out_path"
    ((DOWNLOADED+=1))
  done <<<"$rows"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --start-date)
        [[ $# -ge 2 ]] || die "--start-date requires a value"
        START_DATE="$2"
        shift 2
        ;;
      --calls)
        [[ $# -ge 2 ]] || die "--calls requires a value"
        CALLS_RAW+=("$2")
        shift 2
        ;;
      --calls-file)
        [[ $# -ge 2 ]] || die "--calls-file requires a value"
        CALLS_FILE="$2"
        shift 2
        ;;
      --out-dir)
        [[ $# -ge 2 ]] || die "--out-dir requires a value"
        OUT_DIR="$2"
        OUTDIR_SPECIFIED=1
        shift 2
        ;;
      --sources)
        [[ $# -ge 2 ]] || die "--sources requires a value"
        parse_sources "$2"
        SOURCES_SPECIFIED=1
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        DRYRUN_SPECIFIED=1
        shift
        ;;
      --arrl-format)
        [[ $# -ge 2 ]] || die "--arrl-format requires a value"
        ARRL_FORMAT="$2"
        ARRL_FORMAT_SPECIFIED=1
        shift 2
        ;;
      --no-prompt)
        ENABLE_PROMPT=0
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done
}

main() {
  parse_args "$@"

  prompt_for_missing_inputs
  [[ -n "$START_DATE" ]] || die "--start-date is required (or run interactively to be prompted)"
  START_YEAR="$(date -d "$START_DATE" +%Y 2>/dev/null)" || die "Invalid --start-date: $START_DATE"

  collect_callsigns

  CONVERTER="$(detect_converter)"
  ARRL_FORMAT="$(printf '%s' "$ARRL_FORMAT" | tr '[:upper:]' '[:lower:]')"
  case "$ARRL_FORMAT" in
    auto|png|jpeg|jpg) ;;
    *) die "Invalid --arrl-format '$ARRL_FORMAT' (valid: auto,png,jpeg)" ;;
  esac

  if [[ $USE_ARRL -eq 1 ]]; then
    if [[ "$ARRL_FORMAT" == "auto" ]]; then
      if [[ "$CONVERTER" == "none" ]]; then
        ARRL_EFFECTIVE_FORMAT="jpeg"
        warn "No converter found; ARRL will be saved as JPEG."
      else
        ARRL_EFFECTIVE_FORMAT="png"
      fi
    elif [[ "$ARRL_FORMAT" == "png" ]]; then
      [[ "$CONVERTER" != "none" ]] || die "ARRL format png requested but no JPEG->PNG converter found (need ffmpeg, magick, or convert)."
      ARRL_EFFECTIVE_FORMAT="png"
    else
      ARRL_EFFECTIVE_FORMAT="jpeg"
    fi
  fi

  if [[ $DRY_RUN -eq 0 ]]; then
    mkdir -p "$OUT_DIR"
    [[ $USE_ARRL -eq 1 ]] && mkdir -p "${OUT_DIR}/ARRL"
    [[ $USE_CQWW -eq 1 ]] && mkdir -p "${OUT_DIR}/CQWW"
    [[ $USE_CQWPX -eq 1 ]] && mkdir -p "${OUT_DIR}/CQWPX"
  fi

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  log "Start date: ${START_DATE} (year >= ${START_YEAR})"
  log "Callsigns: ${CALLSIGNS[*]}"
  log "Sources: $([[ $USE_ARRL -eq 1 ]] && printf 'ARRL ')$([[ $USE_CQWW -eq 1 ]] && printf 'CQWW ')$([[ $USE_CQWPX -eq 1 ]] && printf 'CQWPX ')"
  if [[ $USE_ARRL -eq 1 ]]; then
    log "ARRL converter: ${CONVERTER}"
    log "ARRL output format: ${ARRL_EFFECTIVE_FORMAT}"
  fi

  local call
  for call in "${CALLSIGNS[@]}"; do
    [[ $USE_ARRL -eq 1 ]] && save_arrl_pngs "$call"
    [[ $USE_CQWW -eq 1 ]] && save_cq_pngs "CQWW" "$CQWW_URL" "$call"
    [[ $USE_CQWPX -eq 1 ]] && save_cq_pngs "CQWPX" "$CQWPX_URL" "$call"
  done

  log "Done. Downloaded: ${DOWNLOADED}, Skipped: ${SKIPPED}, Failed: ${FAILED}, Retry-events: ${RATE_LIMIT_RETRIES}"
  if [[ $FAILED -gt 0 ]]; then
    exit 2
  fi
}

main "$@"

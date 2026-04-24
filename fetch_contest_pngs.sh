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

DOWNLOADED=0
SKIPPED=0
FAILED=0

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME --start-date YYYY-MM-DD [options]

Required:
  --start-date DATE        Earliest date to include (year-based filtering).

Callsign input (use one or both):
  --calls LIST             Comma/space separated callsigns (example: "W1VE,K1IR")
  --calls-file FILE        File with one callsign per line (# comments allowed)

Optional:
  --out-dir DIR            Output directory (default: $OUT_DIR)
  --sources LIST           Comma-separated subset: arrl,cqww,cqwpx
  --dry-run                Print planned downloads without writing files
  -h, --help               Show this help

Notes:
  - ARRL exposes JPEG/PDF links; this script downloads JPEG and converts to PNG.
  - CQWW/CQWPX downloads are pulled from printCert.php in PNG mode.
  - Filtering is by contest year extracted from each result row.
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

download_to_file() {
  local url="$1"
  local output="$2"
  local referer="${3:-}"

  local curl_args=(
    -fsSL
    --retry 3
    --retry-delay 1
    -A "$USER_AGENT"
  )
  if [[ -n "$referer" ]]; then
    curl_args+=(-e "$referer")
  fi

  curl "${curl_args[@]}" "$url" -o "$output"
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

collect_callsigns() {
  declare -A seen=()
  local merged=()

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

  local html
  html="$(curl -fsSL -A "$USER_AGENT" -X POST --data-urlencode "callsign=${query_call}" "${ARRL_URL}/certificates.php")"

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

    local out_name="${query_call}_ARRL_${year}_${cert_call}_id${id}.png"
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
    if ! download_to_file "$jpeg_url" "$tmp_jpeg"; then
      warn "ARRL download failed: ${jpeg_url}"
      ((FAILED+=1))
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

  local html
  html="$(curl -fsSL -A "$USER_AGENT" -X POST \
    --data-urlencode "Form_Callsign=${query_call}" \
    --data "Form_SearchOps=on" \
    --data "submit=submit" \
    "${base_url}/searchbycall.htm")"

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

    local out_name="${query_call}_${source_name}_${year}_${cert_call}_${mode_token}.png"
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
        shift 2
        ;;
      --sources)
        [[ $# -ge 2 ]] || die "--sources requires a value"
        parse_sources "$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
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

  [[ -n "$START_DATE" ]] || die "--start-date is required"
  START_YEAR="$(date -d "$START_DATE" +%Y 2>/dev/null)" || die "Invalid --start-date: $START_DATE"

  collect_callsigns

  CONVERTER="$(detect_converter)"
  if [[ $USE_ARRL -eq 1 && "$CONVERTER" == "none" ]]; then
    die "ARRL selected but no JPEG->PNG converter found (need ffmpeg, magick, or convert)."
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
  fi

  local call
  for call in "${CALLSIGNS[@]}"; do
    [[ $USE_ARRL -eq 1 ]] && save_arrl_pngs "$call"
    [[ $USE_CQWW -eq 1 ]] && save_cq_pngs "CQWW" "$CQWW_URL" "$call"
    [[ $USE_CQWPX -eq 1 ]] && save_cq_pngs "CQWPX" "$CQWPX_URL" "$call"
  done

  log "Done. Downloaded: ${DOWNLOADED}, Skipped: ${SKIPPED}, Failed: ${FAILED}"
  if [[ $FAILED -gt 0 ]]; then
    exit 2
  fi
}

main "$@"

#!/bin/bash
# ============================================================
# Tally Encoder — HDMI/SDI → RTMP relay stream
# Captures from v4l2 (Elgato Cam Link / USB) or Blackmagic
# DeckLink (UltraStudio Recorder 3G) and streams H.264 at a
# configurable bitrate (default 3 Mbps) to the relay server.
#
# Config: /etc/tally-encoder/config.env
# Log:    /var/log/tally-encoder.log
# ============================================================

set -euo pipefail

CONFIG_FILE="${CONFIG_FILE:-/etc/tally-encoder/config.env}"
LOG_FILE="${LOG_FILE:-/var/log/tally-encoder.log}"

# ── Logging ──────────────────────────────────────────────────
log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[$ts] $*" | tee -a "$LOG_FILE"
}

# ── Load config ──────────────────────────────────────────────
if [[ ! -f "$CONFIG_FILE" ]]; then
  log "ERROR: Config file not found: $CONFIG_FILE"
  log "       Copy config.env.example to $CONFIG_FILE and edit it."
  exit 1
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

# ── Validate required vars ────────────────────────────────────
: "${RELAY_URL:?RELAY_URL not set in $CONFIG_FILE}"
: "${CHURCH_TOKEN:?CHURCH_TOKEN not set in $CONFIG_FILE}"

BITRATE="${BITRATE:-3000k}"
INPUT_TYPE="${INPUT_TYPE:-v4l2}"
INPUT_DEVICE="${INPUT_DEVICE:-/dev/video0}"
AUDIO_DEVICE="${AUDIO_DEVICE:-hw:0,0}"
TALLY_API_PORT="${TALLY_API_PORT:-7070}"

STREAM_URL="${RELAY_URL}/${CHURCH_TOKEN}"
SYNC_STATUS_FILE="${SYNC_STATUS_FILE:-/tmp/tally-sync-status.json}"

log "======================================================"
log "Tally Encoder starting"
log "  Input type   : $INPUT_TYPE"
log "  Input device : $INPUT_DEVICE"
log "  Audio device : $AUDIO_DEVICE"
log "  Bitrate      : $BITRATE"
log "  Relay URL    : $STREAM_URL"
log "======================================================"

# ── Device detection ─────────────────────────────────────────
detect_device() {
  case "$INPUT_TYPE" in
    v4l2)
      if [[ ! -e "$INPUT_DEVICE" ]]; then
        log "WARNING: v4l2 device $INPUT_DEVICE not found. Available devices:"
        ls /dev/video* 2>/dev/null | while read -r dev; do log "  $dev"; done || log "  (none found)"
        # Auto-detect first available v4l2 device
        local first_dev
        first_dev="$(ls /dev/video0 2>/dev/null || ls /dev/video* 2>/dev/null | head -1 || true)"
        if [[ -n "$first_dev" ]]; then
          log "Auto-detected device: $first_dev"
          INPUT_DEVICE="$first_dev"
        else
          log "ERROR: No v4l2 capture device found"
          exit 1
        fi
      fi
      log "Using v4l2 device: $INPUT_DEVICE"
      ;;
    decklink)
      if ! ffmpeg -hide_banner -list_devices true -f decklink dummy 2>&1 | grep -q "DeckLink\|UltraStudio"; then
        log "WARNING: No DeckLink/UltraStudio device detected by ffmpeg"
        log "         Ensure Blackmagic drivers are installed and device is connected"
      else
        log "DeckLink device detected"
      fi
      ;;
    *)
      log "ERROR: Unknown INPUT_TYPE '$INPUT_TYPE'. Use 'v4l2' or 'decklink'."
      exit 1
      ;;
  esac
}

# ── Build ffmpeg input arguments ─────────────────────────────
build_ffmpeg_input() {
  case "$INPUT_TYPE" in
    v4l2)
      # Elgato Cam Link 4K or any USB UVC capture device
      VIDEO_INPUT_ARGS=(
        -f v4l2
        -framerate 30
        -video_size 1920x1080
        -input_format mjpeg
        -i "$INPUT_DEVICE"
      )
      AUDIO_INPUT_ARGS=(
        -f alsa
        -i "$AUDIO_DEVICE"
      )
      ;;
    decklink)
      # Blackmagic UltraStudio Recorder 3G
      # INPUT_DEVICE should be the DeckLink device name, e.g. "UltraStudio Recorder 3G"
      VIDEO_INPUT_ARGS=(
        -f decklink
        -i "${INPUT_DEVICE:-UltraStudio Recorder 3G}"
      )
      AUDIO_INPUT_ARGS=()  # DeckLink captures audio embedded in the same input
      ;;
  esac
}

# ── Build ffmpeg output arguments ────────────────────────────
build_ffmpeg_output() {
  FFMPEG_OUTPUT_ARGS=(
    # Video encoding — H.264, fast preset, low latency
    -c:v libx264
    -preset veryfast
    -tune zerolatency
    -b:v "$BITRATE"
    -maxrate "$BITRATE"
    -bufsize "$(echo "$BITRATE" | sed 's/k/000/' | awk '{print int($1*2)}')k"
    -pix_fmt yuv420p
    -g 60                  # keyframe every 2 seconds at 30fps
    -keyint_min 30

    # Audio encoding — AAC stereo at 128kbps
    -c:a aac
    -b:a 128k
    -ar 44100
    -ac 2

    # RTMP output with reconnect logic
    -f flv
    -reconnect 1
    -reconnect_at_eof 1
    -reconnect_streamed 1
    -reconnect_delay_max 10
    "$STREAM_URL"
  )
}

# ── A/V sync stderr parser ────────────────────────────────────
# Called as a process substitution receiving ffmpeg stderr lines.
# Extracts the A-V: float, converts to ms, writes JSON status file
# at most once every 2 seconds.
parse_av_sync() {
  local last_write=0
  while IFS= read -r line; do
    # Mirror every line to the log file
    echo "$line" >> "$LOG_FILE"

    # Match:  "... A-V: -0.043 ..."  or  "... A-V:-0.043 ..."
    if [[ "$line" =~ A-V:[[:space:]]*(-?[0-9]+\.[0-9]+) ]]; then
      local av_float="${BASH_REMATCH[1]}"
      local now
      now=$(date +%s)
      # Rate-limit: write at most once every 2 seconds
      if (( now - last_write >= 2 )); then
        last_write=$now
        # Convert seconds → integer ms using awk
        local av_ms abs_ms status
        av_ms=$(awk "BEGIN{printf \"%d\", (${av_float}) * 1000}")
        abs_ms=$(awk "BEGIN{x=${av_float}; if(x<0)x=-x; printf \"%d\", x*1000}")
        if   (( abs_ms > 100 )); then status="critical"
        elif (( abs_ms > 33  )); then status="warn"
        else                          status="ok"
        fi
        printf '{"avOffsetMs":%d,"timestamp":%d,"status":"%s"}\n' \
          "$av_ms" "$now" "$status" > "$SYNC_STATUS_FILE"
      fi
    fi
  done
}

# ── Main encoder loop ─────────────────────────────────────────
RESTART_DELAY=5
ATTEMPT=0

detect_device
build_ffmpeg_input
build_ffmpeg_output

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  log "Starting ffmpeg (attempt #$ATTEMPT)..."

  # Write PID for API server to track
  echo "$$" > /tmp/tally-encoder-ffmpeg.pid

  # Build the full ffmpeg command
  if [[ "$INPUT_TYPE" == "decklink" ]]; then
    # DeckLink: video+audio in one input
    FFMPEG_CMD=(
      ffmpeg
      -hide_banner
      -loglevel warning
      -stats
      "${VIDEO_INPUT_ARGS[@]}"
      "${FFMPEG_OUTPUT_ARGS[@]}"
    )
  else
    # v4l2: separate video and audio inputs
    FFMPEG_CMD=(
      ffmpeg
      -hide_banner
      -loglevel warning
      -stats
      "${VIDEO_INPUT_ARGS[@]}"
      "${AUDIO_INPUT_ARGS[@]}"
      "${FFMPEG_OUTPUT_ARGS[@]}"
    )
  fi

  log "ffmpeg command: ${FFMPEG_CMD[*]}"

  # Run ffmpeg:
  #   stdout  → log file directly
  #   stderr  → tr converts \r progress lines to \n, then parse_av_sync
  #             mirrors each line to log AND extracts A-V: sync values
  if "${FFMPEG_CMD[@]}" 1>> "$LOG_FILE" \
       2> >(tr '\r' '\n' | parse_av_sync); then
    log "ffmpeg exited cleanly"
  else
    EXIT_CODE=$?
    log "ffmpeg exited with code $EXIT_CODE"
  fi

  rm -f /tmp/tally-encoder-ffmpeg.pid

  log "Restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done

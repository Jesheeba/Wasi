#!/usr/bin/env bash
# Rebuilds the Wasi 90-second launch film end to end.
# VO: ElevenLabs voice J9gbaR3XWZq9razzBxca; key from ELEVENLABS_API_KEY or server/.env (eleven_labs).
# Lines whose audio/<id>.wav already exists are not regenerated (no credits spent).
# Pass --preview to skip the voice and render a music+sfx cut on estimated timing.
set -e
cd "$(dirname "$0")"

if [ "$1" != "--preview" ]; then
  echo "== voice (ElevenLabs) =="; node scripts/generate-vo.js
fi
echo "== timing (90.0s) ==";       node scripts/build-timing.js
echo "== score ==";                node scripts/make-music.js
echo "== sound design ==";         node scripts/make-sfx.js
echo "== mix + loudness ==";       node scripts/assemble-audio.js
echo "== frames (1080p30) ==";     node scripts/capture-frames.js --workers=4
echo "== encode ==";               node scripts/render-video.js
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of default=noprint_wrappers=1 output/*.mp4

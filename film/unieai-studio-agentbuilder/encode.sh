#!/usr/bin/env bash
# Encode captured sub-frames into the film.
#   ./encode.sh preview   -> out/preview.mp4  (960x540, 30 fps,  2 sub-frames)
#   ./encode.sh master    -> out/master.mp4   (1920x1080, 60 fps, 4 sub-frames)
# Each output frame owns SUB consecutive captures spread across a 180-degree
# shutter; averaging them is exactly that shutter, so the blur is optical, not
# a filter. Grain is added at encode time so it sits on every frame.
# If out/score.wav exists, a second file <mode>_scored.mp4 is muxed from it with
# a single linear gain to -18 LUFS, so the score's own dynamics survive.
set -euo pipefail
cd "$(dirname "$0")"

mode=${1:-preview}
case "$mode" in
  preview) W=960;  H=540;  FPS=30; SUB=2; CRF=20; PRESET=medium ;;
  master)  W=1920; H=1080; FPS=60; SUB=4; CRF=17; PRESET=slow ;;
  *) echo "usage: $0 [preview|master]" >&2; exit 1 ;;
esac

dir="out/frames_$mode"
[ -d "$dir" ] || { echo "no frames in $dir" >&2; exit 1; }
n=$(ls "$dir"/f*.png | wc -l)
want=$(( $(python3 -c "print(round(52.0*$FPS))") * SUB ))
echo "$n / $want captures"
[ "$n" -eq "$want" ] || echo "warning: capture count mismatch, encoding what is there"

weights=$(python3 -c "print(' '.join(['$(python3 -c "print(1/$SUB)")']*$SUB))")
echo "shutter: averaging $SUB captures per frame (weights $weights)"

ffmpeg -y -hide_banner -loglevel warning \
  -framerate $(( FPS * SUB )) -pattern_type glob -i "$dir/f*.png" \
  -vf "tmix=frames=$SUB:weights='$weights',fps=$FPS,noise=alls=4:allf=t+u,format=yuv420p" \
  -c:v libx264 -preset "$PRESET" -crf "$CRF" \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -movflags +faststart "out/$mode.mp4"

ffprobe -v error -show_entries format=duration,size:stream=width,height,r_frame_rate,nb_frames \
  -of default=nw=1 "out/$mode.mp4"

if [ -f out/score.wav ]; then
  ref=$(ffmpeg -hide_banner -nostats -i out/score.wav \
        -af loudnorm=print_format=json -f null - 2>&1 |
        python3 -c "import sys,re; print(re.search(r'\"input_i\" : \"([-0-9.]+)\"', sys.stdin.read()).group(1))")
  gain=$(python3 -c "print(round(-18.0 - ($ref), 2))")
  echo "score: $ref LUFS -> gain ${gain} dB (target -18 LUFS)"
  ffmpeg -y -hide_banner -loglevel warning \
    -i "out/$mode.mp4" -i out/score.wav \
    -map 0:v -map 1:a -c:v copy \
    -af "volume=${gain}dB" -c:a aac -b:a 192k -ar 48000 \
    -shortest -movflags +faststart "out/${mode}_scored.mp4"
  ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,channels,sample_rate \
    -of default=nw=1 "out/${mode}_scored.mp4"
fi

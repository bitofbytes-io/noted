#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: run-audiveris-docker.sh INPUT_PDF OUTPUT_DIRECTORY" >&2
  exit 64
fi

input=$1
output=$2
job_dir=$(dirname "$input")
input_name=$(basename "$input")
output_name=$(basename "$output")
image=${NOTED_AUDIVERIS_IMAGE:-noted-audiveris:5.10.2}

if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then
  audiveris=${NOTED_AUDIVERIS_COMMAND:-.local/tools/Audiveris.app/Contents/MacOS/Audiveris}
  if [ ! -x "$audiveris" ]; then
    echo "Audiveris is not installed; run make omr-build" >&2
    exit 69
  fi
  pages=$(osascript -l JavaScript \
    -e 'ObjC.import("PDFKit"); const args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments); const input = args[args.length - 1]; const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(input)); doc ? Number(doc.pageCount) : ""' \
    "$input")
else
  pages=$(docker run --rm --network none --platform linux/amd64 -v "$job_dir:/work" --entrypoint pdfinfo "$image" "/work/$input_name" | awk '/^Pages:/ { print $2 }')
fi

if [ -z "$pages" ] || [ "$pages" -gt 25 ]; then
  echo "PDF conversion supports at most 25 pages" >&2
  exit 65
fi

if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then
  "$audiveris" -batch -transcribe -export -output "$output" -- "$input"
else
  docker run --rm --network none --platform linux/amd64 \
    --memory=4g --cpus=2 \
    -v "$job_dir:/work" \
    "$image" -batch -transcribe -export -output "/work/$output_name" -- "/work/$input_name"
fi

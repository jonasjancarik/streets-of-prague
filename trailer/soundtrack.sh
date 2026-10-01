#!/bin/sh
# Mixes the trailer's sound from the game's own recordings (public/audio, all CC0 here:
# see its SOURCES.md): a morning ambience under the day clips, the night's under the
# rest, a tram's bell on the title cards and its wheels under the tram clip.
set -e
cd "$(dirname "$0")"
A=../public/audio
ffmpeg -y -loglevel error \
  -i $A/amb-morning.m4a -i $A/amb-night.m4a -i $A/bell-1.m4a -i $A/roll.wav -i $A/bell-2.m4a \
  -filter_complex "
    [0]atrim=0:16,afade=t=in:d=1,afade=t=out:st=14:d=2,volume=0.55[day];
    [1]atrim=0:23,afade=t=in:d=2,afade=t=out:st=20:d=3,adelay=14000:all=1,volume=0.75[night];
    [2]adelay=300:all=1,volume=0.5[bell];
    [3]atrim=0:5,afade=t=in:d=0.8,afade=t=out:st=3.5:d=1.5,adelay=10700:all=1,volume=0.45[roll];
    [4]adelay=32300:all=1,volume=0.5[bell2];
    [day][night][bell][roll][bell2]amix=inputs=5:normalize=0,atrim=0:36.7,alimiter=limit=0.9[out]" \
  -map "[out]" -ar 48000 -ac 2 media/soundtrack.wav

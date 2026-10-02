#!/bin/sh
# The last pass over a rendered cut: a little more contrast and colour, darker corners
# and film grain. Usage: street/finish.sh out.mp4 street.mp4
ffmpeg -y -loglevel error -i "$1" -vf "eq=contrast=1.06:saturation=1.07,vignette=angle=PI/5.5,noise=alls=5:allf=t" \
  -c:v libx264 -crf 24 -preset slow -maxrate 14M -bufsize 28M -pix_fmt yuv420p -c:a copy "$2"

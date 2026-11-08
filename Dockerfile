# Files web 1.0: de bestandsbeheerder waaruit File Duo is ontstaan. Alles zit erin, start zonder internet.
FROM node:22-alpine
RUN apk add --no-cache tini ffmpeg vips-tools vips-heif exiftool zip ca-certificates tzdata
WORKDIR /app
COPY app/ /app/
RUN mkdir -p /data /schijven
ENV FM_PORT=8080 FM_DATA=/data FM_SCHIJVEN=/schijven TZ=Europe/Amsterdam
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -q -O /dev/null http://127.0.0.1:8080/icon.svg || exit 1
LABEL org.opencontainers.image.title="Files web" org.opencontainers.image.source="https://github.com/jobberns82/file-web" \
      org.opencontainers.image.vendor="© 2026 jobberns82. Alle rechten voorbehouden."
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/server.js"]

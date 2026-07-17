FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS worker-build

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/omr-worker ./cmd/omr-worker
COPY internal/omrworker ./internal/omrworker
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/noted-omr ./cmd/omr-worker

FROM ubuntu:22.04

ARG AUDIVERIS_VERSION=5.10.2
ARG AUDIVERIS_DEB=Audiveris-5.10.2-ubuntu22.04-x86_64.deb
ARG AUDIVERIS_SHA256=9470d15e79dd4fe45f817b8545ba9f8e57ddaebff3b3a1031f21218647602068
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/bitofbytes-io/noted

LABEL org.opencontainers.image.title="Noted OMR worker" \
      org.opencontainers.image.description="Private bounded HTTP wrapper for Audiveris score recognition" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="MIT AND AGPL-3.0-or-later"

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl poppler-utils xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/audiveris.deb "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/${AUDIVERIS_DEB}" \
    && echo "${AUDIVERIS_SHA256}  /tmp/audiveris.deb" | sha256sum -c - \
    && ln -sf /bin/true /usr/bin/xdg-desktop-menu \
    && ln -sf /bin/true /usr/bin/xdg-mime \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/audiveris.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/audiveris.deb \
    && sed -i 's/^java-options=-Xmx8G$/java-options=-Xmx2560m/' /opt/audiveris/lib/app/Audiveris.cfg \
    && grep -Fx 'java-options=-Xmx2560m' /opt/audiveris/lib/app/Audiveris.cfg \
    && ln -s /opt/audiveris/bin/Audiveris /usr/local/bin/audiveris \
    && groupadd --gid 10001 noted-omr \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin noted-omr \
    && install -d -o noted-omr -g noted-omr -m 0700 /tmp/noted-omr /tmp/noted-omr/home

COPY --from=worker-build /out/noted-omr /usr/local/bin/noted-omr

ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true" \
    HOME="/tmp/noted-omr/home" \
    OMR_LISTEN_ADDR=":8788" \
    OMR_TEMP_ROOT="/tmp/noted-omr" \
    OMR_TOKEN_FILE="/run/secrets/noted_omr_token"

USER 10001:10001
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=40s --start-period=60s --retries=3 CMD ["curl", "-fsS", "http://127.0.0.1:8788/readyz"]
ENTRYPOINT ["/usr/local/bin/noted-omr"]

FROM ubuntu:22.04

ARG AUDIVERIS_VERSION=5.10.2
ARG AUDIVERIS_DEB=Audiveris-5.10.2-ubuntu22.04-x86_64.deb

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl poppler-utils xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/audiveris.deb "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/${AUDIVERIS_DEB}" \
    && ln -sf /bin/true /usr/bin/xdg-desktop-menu \
    && ln -sf /bin/true /usr/bin/xdg-mime \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/audiveris.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/audiveris.deb

ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true"
ENTRYPOINT ["audiveris"]

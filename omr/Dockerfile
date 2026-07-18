FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS worker-build

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/omr-worker ./cmd/omr-worker
COPY internal/omrworker ./internal/omrworker
COPY internal/omrreport ./internal/omrreport
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/noted-omr ./cmd/omr-worker

FROM node:22.22.0-bookworm-slim

ARG AUDIVERIS_VERSION=5.10.2
ARG AUDIVERIS_DEB=Audiveris-5.10.2-ubuntu22.04-x86_64.deb
ARG AUDIVERIS_SHA256=9470d15e79dd4fe45f817b8545ba9f8e57ddaebff3b3a1031f21218647602068
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL=https://github.com/bitofbytes-io/noted

LABEL org.opencontainers.image.title="Noted OMR worker" \
	  org.opencontainers.image.description="Private bounded dual-engine optical music recognition worker" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
	  org.opencontainers.image.licenses="MIT AND BSD-3-Clause AND MPL-2.0 AND AGPL-3.0-or-later"

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl libgl1 libglib2.0-0 poppler-utils python3 python3-pip python3-venv xdg-utils \
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

COPY omr/requirements.txt /opt/noted-omr/requirements.txt
RUN python3 -m venv /opt/noted-omr/venv

# Keep the large binary dependencies in separate immutable layers. Besides making
# updates cacheable, this keeps every registry upload below the private proxy's
# request window instead of producing one monolithic 850+ MiB filesystem layer.
RUN /opt/noted-omr/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
	"numpy>=2.4.2,<3.0.0" \
	"onnxruntime>=1.24.1,<2.0.0"
RUN /opt/noted-omr/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
	"opencv-python-headless>=4.13.0.92,<5.0.0.0" \
	"Pillow>=12.1.1,<13.0.0"
RUN /opt/noted-omr/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
	"rapidocr>=3.7.0,<4.0.0"
RUN /opt/noted-omr/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
	"homr==0.7.0"
RUN /opt/noted-omr/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
	"music21==10.3.0" \
	&& /opt/noted-omr/venv/bin/pip install --no-cache-dir --disable-pip-version-check -r /opt/noted-omr/requirements.txt \
	&& /opt/noted-omr/venv/bin/pip check \
	&& /opt/noted-omr/venv/bin/python -c "import importlib.metadata as m; assert m.version('homr') == '0.7.0'; assert m.version('music21') == '10.3.0'"

RUN /opt/noted-omr/venv/bin/homr --gpu no --init \
	&& find /opt/noted-omr/venv/lib/python3.11/site-packages/homr /opt/noted-omr/venv/lib/python3.11/site-packages/rapidocr -type f -name '*.onnx' -print0 \
		| sort -z | xargs -0 sha256sum > /opt/noted-omr/homr-models.sha256 \
	&& test -s /opt/noted-omr/homr-models.sha256

RUN npm install --prefix /opt/noted-omr --omit=dev --ignore-scripts --no-audit --no-fund @coderline/alphatab@1.8.4 \
	&& test "$(node -p "require('/opt/noted-omr/node_modules/@coderline/alphatab/package.json').version")" = "1.8.4" \
	&& npm cache clean --force

COPY omr/pipeline /opt/noted-omr/pipeline
RUN chmod -R a-w /opt/noted-omr/pipeline \
	&& find /opt/noted-omr/node_modules /opt/noted-omr/venv -xdev -perm /022 -exec chmod go-w {} + \
	&& ! find /opt/noted-omr/pipeline /opt/noted-omr/node_modules /opt/noted-omr/venv ! -user root -print -quit | grep -q .

COPY omr/tests /opt/noted-omr/tests
COPY testdata/fixtures/noted-exercise.musicxml /opt/noted-omr/testdata/fixtures/noted-exercise.musicxml
RUN cd /opt/noted-omr \
	&& /opt/noted-omr/venv/bin/python -m unittest discover -s tests -p 'test_pipeline.py' -v \
	&& node --test tests/alphatab-gate.test.mjs \
	&& rm -rf /opt/noted-omr/tests /opt/noted-omr/testdata

COPY --from=worker-build /out/noted-omr /usr/local/bin/noted-omr

ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true" \
	NODE_PATH="/opt/noted-omr/node_modules" \
	HOME="/tmp/noted-omr/home" \
    OMR_LISTEN_ADDR=":8788" \
	OMR_TEMP_ROOT="/tmp/noted-omr"

USER 10001:10001
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=40s --start-period=60s --retries=3 CMD ["curl", "-fsS", "http://127.0.0.1:8788/readyz"]
ENTRYPOINT ["/usr/local/bin/noted-omr"]

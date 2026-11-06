# syntax=docker/dockerfile:1.7
# The widget is built first and embedded into the Go binary; the image is distroless and runs as
# nonroot with a read-only filesystem except /data (the SQLite file).

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS widget
WORKDIR /src/widget
COPY widget/package.json widget/package-lock.json widget/.npmrc ./
RUN npm ci
COPY widget/ ./
COPY internal/widgetfs/dist/README.md /src/internal/widgetfs/dist/README.md
RUN npm run build

FROM golang:1.26-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696 AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=widget /src/internal/widgetfs/dist ./internal/widgetfs/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/bugspot ./cmd/bugspot \
    && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=server /out/bugspot /usr/local/bin/bugspot
COPY --from=server --chown=nonroot:nonroot /out/data /data
ENV BUGSPOT_ADDR=:8090 \
    BUGSPOT_DATA_DIR=/data
EXPOSE 8090
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["bugspot", "healthcheck"]
USER nonroot:nonroot
ENTRYPOINT ["bugspot"]
CMD ["serve"]

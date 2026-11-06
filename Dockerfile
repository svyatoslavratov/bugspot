# syntax=docker/dockerfile:1.7
# The widget is built first and embedded into the Go binary; the image is distroless and runs as
# nonroot with a read-only filesystem except /data (the SQLite file).

FROM node:22-alpine AS widget
WORKDIR /src/widget
COPY widget/package.json widget/package-lock.json widget/.npmrc ./
RUN npm ci
COPY widget/ ./
COPY internal/widgetfs/dist/README.md /src/internal/widgetfs/dist/README.md
RUN npm run build

FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=widget /src/internal/widgetfs/dist ./internal/widgetfs/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/bugspot ./cmd/bugspot \
    && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
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

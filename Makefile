# pinpath: the Go service embeds the widget, so build the widget first.

NODE_BIN ?=
NPM := $(NODE_BIN)npm
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all widget build test test-go test-widget lint demo run docker clean

all: build

widget: ## build widget.js and assets/ into internal/widgetfs/dist
	cd widget && $(NPM) ci && $(NPM) run build

build: widget ## the pinpath binary with the widget inside
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/pinpath ./cmd/pinpath

test: test-go test-widget

test-go:
	go test -race -count=1 ./...

test-widget:
	cd widget && $(NPM) run typecheck && $(NPM) test && $(NPM) run format:check

lint:
	go vet ./...
	go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run

demo: widget ## the GitHub Pages demo in _site/: the widget plus the API compiled to WebAssembly
	rm -rf _site && mkdir -p _site
	GOOS=js GOARCH=wasm go build -trimpath -ldflags "$(LDFLAGS)" -o _site/pinpath.wasm ./cmd/pinpath-wasm
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" _site/
	cp demo/index.html demo/demo.css demo/demo.js _site/
	cp -R internal/widgetfs/dist/widget.js internal/widgetfs/dist/assets _site/

run: build ## run locally with public access and a local database
	PINPATH_AUTH=anonymous PINPATH_VIEW='*' PINPATH_COMMENT='*' PINPATH_DATA_DIR=data ./bin/pinpath

docker:
	docker build --build-arg VERSION=$(VERSION) -t pinpath:$(VERSION) .

clean:
	rm -rf bin _site data

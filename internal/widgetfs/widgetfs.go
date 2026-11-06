// Package widgetfs embeds the built widget (make widget writes it to dist/), so the binary serves
// the loader and its assets itself.
package widgetfs

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS returns widget.js and assets/ of the build.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}

// Package userscripts embeds the installable userscript without external assets.
package userscripts

import _ "embed"

//go:embed chaoxing-questionbank.user.js
var script []byte

func Source() []byte { return script }

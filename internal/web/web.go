// Package web serves the query interface embedded in the server binary.
package web

import (
	"bytes"
	"embed"
	"net/http"
	"time"

	"onlinecourse/userscripts"
)

//go:embed index.html assets/app.css assets/app.js assets/favicon.svg
var files embed.FS

func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var name, contentType string
		var content []byte
		switch r.URL.Path {
		case "/":
			name, contentType = "index.html", "text/html; charset=utf-8"
		case "/assets/app.css":
			name, contentType = "assets/app.css", "text/css; charset=utf-8"
		case "/assets/app.js":
			name, contentType = "assets/app.js", "text/javascript; charset=utf-8"
		case "/assets/favicon.svg":
			name, contentType = "assets/favicon.svg", "image/svg+xml"
		case "/userscripts/chaoxing-questionbank.user.js":
			name, contentType = "chaoxing-questionbank.user.js", "text/javascript; charset=utf-8"
			content = userscripts.Source()
		default:
			http.NotFound(w, r)
			return
		}
		if content == nil {
			var err error
			content, err = files.ReadFile(name)
			if err != nil {
				http.Error(w, "page unavailable", http.StatusInternalServerError)
				return
			}
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
	})
}

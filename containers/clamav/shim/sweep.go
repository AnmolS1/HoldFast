package main

import (
	"log"
	"os"
	"path/filepath"
)

// sweepDir empties dir and keeps it. A directory below it that cannot be removed (a mount point)
// is emptied and kept. Unlinking a file clamd still has open (a scan whose client went away)
// removes its name at once; its space returns when clamd closes it.
func sweepDir(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Printf("sweep %s: %v", dir, err)
		return
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			sweepDir(path)
			_ = os.Remove(path)
			continue
		}
		if err := os.Remove(path); err != nil {
			log.Printf("sweep %s: %v", path, err)
		}
	}
}

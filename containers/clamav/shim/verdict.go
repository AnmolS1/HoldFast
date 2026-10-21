package main

import "strings"

// Verdict is the /scan answer (T20 task file, "Verdict JSON").
type Verdict struct {
	Status     string   `json:"status"`
	Reason     string   `json:"reason,omitempty"`
	Signatures []string `json:"signatures"`
	PUA        []string `json:"pua"`
	SHA256     string   `json:"sha256"`
	Bytes      int64    `json:"bytes"`
	Engine     string   `json:"engine"`
	DBVersion  string   `json:"dbVersion"`
	DBAgeHours float64  `json:"dbAgeHours"`
	DurationMs int64    `json:"durationMs"`
}

const (
	sigScanTime  = "Heuristics.Limits.Exceeded.MaxScanTime"
	sigLimits    = "Heuristics.Limits.Exceeded."
	sigEncrypted = "Heuristics.Encrypted."
	sigPUA       = "PUA."
)

// Classify maps one INSTREAM reply to status, reason and names. Only exactly "stream: OK" is
// clean; any name it does not recognise is infected. A MaxScanTime cut-off is a slow scan,
// not a property of the file: it is a retryable timeout, never limits_exceeded (spike S2).
func Classify(reply string) (status, reason string, signatures, pua []string) {
	signatures, pua = []string{}, []string{}
	switch {
	case reply == "stream: OK":
		return "clean", "", signatures, pua
	case strings.HasPrefix(reply, "stream: ") && strings.HasSuffix(reply, " FOUND"):
		name := strings.TrimSuffix(strings.TrimPrefix(reply, "stream: "), " FOUND")
		switch {
		case name == "":
			return "error", "engine", signatures, pua
		case strings.HasPrefix(name, sigScanTime):
			return "error", "timeout", signatures, pua
		case strings.HasPrefix(name, sigLimits):
			return "limits_exceeded", "limits", []string{name}, pua
		case strings.HasPrefix(name, sigEncrypted):
			return "encrypted", "encrypted", []string{name}, pua
		case strings.HasPrefix(name, sigPUA):
			// clamd reports ONE name, the last alert: a PUA match can stand in for an encrypted or
			// over-limit member it could not inspect (review B1). DetectPUA is off; a PUA name that
			// still arrives (a private signature) fails closed, and pua stays empty.
			return "error", "engine", signatures, pua
		default:
			return "infected", "", []string{name}, pua
		}
	default:
		// "… ERROR" and anything clamd is not documented to say.
		return "error", "engine", signatures, pua
	}
}

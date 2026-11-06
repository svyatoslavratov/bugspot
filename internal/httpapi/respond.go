package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

type errorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: message, Code: code})
}

// errBadRequest is a client mistake with a message safe to show.
type errBadRequest struct{ msg string }

func (e errBadRequest) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return errBadRequest{msg: fmt.Sprintf(format, args...)}
}

// decode reads a JSON object with known fields only.
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody+1))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var syntax *json.SyntaxError
		var typed *json.UnmarshalTypeError
		switch {
		case errors.Is(err, io.EOF):
			return badRequest("empty body")
		case errors.As(err, &syntax), errors.As(err, &typed), errors.Is(err, io.ErrUnexpectedEOF):
			return badRequest("invalid JSON: %v", err)
		default:
			return badRequest("%v", err)
		}
	}
	if dec.More() {
		return badRequest("one JSON object expected")
	}
	return nil
}

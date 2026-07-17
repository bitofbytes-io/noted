package omrworker

import "fmt"

// Error is a sanitized worker failure that is safe to expose to the API.
type Error struct {
	Code    string
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e.Cause == nil {
		return e.Message
	}
	return fmt.Sprintf("%s: %v", e.Message, e.Cause)
}

func (e *Error) Unwrap() error { return e.Cause }

func workerError(code, message string, cause error) *Error {
	return &Error{Code: code, Message: message, Cause: cause}
}

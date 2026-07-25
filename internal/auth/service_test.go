package auth

import "testing"

func TestSafeReturnPath(t *testing.T) {
	tests := map[string]string{
		"":                         "/",
		"/":                        "/",
		"/reader/piece":            "/reader/piece",
		"https://example.com/path": "/",
		"//example.com/path":       "/",
		"/path\nLocation: bad":     "/",
	}
	for input, expected := range tests {
		if actual := SafeReturnPath(input); actual != expected {
			t.Errorf("SafeReturnPath(%q) = %q, want %q", input, actual, expected)
		}
	}
}

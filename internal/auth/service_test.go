package auth

import "testing"

func TestSafeReturnPath(t *testing.T) {
	for name, test := range map[string]struct {
		value string
		want  string
	}{
		"empty":            {"", "/"},
		"absolute URL":     {"https://attacker.example", "/"},
		"scheme relative":  {"//attacker.example", "/"},
		"header injection": {"/home\r\nLocation: https://attacker.example", "/"},
		"application path": {"/works/123?tab=scores", "/works/123?tab=scores"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := SafeReturnPath(test.value); got != test.want {
				t.Fatalf("SafeReturnPath(%q) = %q, want %q", test.value, got, test.want)
			}
		})
	}
}

func TestTokensAreRandomAndHashToThirtyTwoBytes(t *testing.T) {
	first, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || first == "" || second == "" {
		t.Fatal("secure tokens were empty or repeated")
	}
	if hash := tokenHash(first); len(hash) != 32 {
		t.Fatalf("token hash length = %d, want 32", len(hash))
	}
}

func TestGoogleIdentityMustBeVerifiedAndAllowed(t *testing.T) {
	service := NewService(nil, []string{"learner@example.com"}, 0)
	identity := GoogleIdentity{Subject: "google-subject", Email: " Learner@Example.COM ", Verified: true}
	if !service.allowsGoogleIdentity(identity) {
		t.Fatal("expected normalized verified allow-listed identity to pass")
	}
	identity.Verified = false
	if service.allowsGoogleIdentity(identity) {
		t.Fatal("unverified Google email was accepted")
	}
	identity.Verified = true
	identity.Email = "other@example.com"
	if service.allowsGoogleIdentity(identity) {
		t.Fatal("email outside allow-list was accepted")
	}
}

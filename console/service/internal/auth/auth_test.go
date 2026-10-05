package auth

import (
	"strings"
	"testing"
)

func TestHashAndVerifyPassword(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "pbkdf2-sha256$600000$") {
		t.Fatalf("unexpected encoding %q", h)
	}
	if !VerifyPassword("correct horse battery", h) {
		t.Fatal("correct password rejected")
	}
	if VerifyPassword("correct horse batterY", h) {
		t.Fatal("wrong password accepted")
	}
	h2, _ := HashPassword("correct horse battery")
	if h == h2 {
		t.Fatal("same salt used twice")
	}
}

func TestWeakPasswordRejected(t *testing.T) {
	if _, err := HashPassword("short"); err != ErrWeakPassword {
		t.Fatalf("err = %v", err)
	}
}

func TestVerifyRejectsGarbage(t *testing.T) {
	for _, enc := range []string{"", "plain", "pbkdf2-sha256$x$y$z", "bcrypt$1$2$3", "pbkdf2-sha256$0$AA$AA"} {
		if VerifyPassword("anything1", enc) {
			t.Fatalf("accepted %q", enc)
		}
	}
}

func TestTokensAreUniqueAndHashed(t *testing.T) {
	a, _ := newToken()
	b, _ := newToken()
	if a == b || !strings.HasPrefix(a, "js_") {
		t.Fatalf("tokens %q %q", a, b)
	}
	if HashToken(a) == a || len(HashToken(a)) != 64 {
		t.Fatal("token hash looks wrong")
	}
	// cookie-safe for the SQL editor (nginx reads it from a cookie)
	if strings.ContainsAny(a, ";, =+/") {
		t.Fatalf("token not cookie-safe: %q", a)
	}
}

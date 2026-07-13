package assets

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestFilesystemStoreRejectsUnsafeKeys(t *testing.T) {
	store, err := NewFilesystemStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	unsafe := []string{"../secret", "pdf/../../secret", "pdf/user-file.pdf", "/etc/passwd"}
	for _, key := range unsafe {
		if _, err := store.Put(context.Background(), key, strings.NewReader("secret")); err == nil {
			t.Fatalf("expected key %q to be rejected", key)
		}
	}
}

func TestFilesystemStoreRoundTripAndDelete(t *testing.T) {
	store, err := NewFilesystemStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key := "pdf/11111111-1111-4111-8111-111111111111"
	stored, err := store.Put(context.Background(), key, strings.NewReader("%PDF-test"))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Size != 9 || stored.Checksum == "" {
		t.Fatalf("unexpected stored object: %#v", stored)
	}
	reader, _, err := store.Open(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	contents, _ := io.ReadAll(reader)
	reader.Close()
	if string(contents) != "%PDF-test" {
		t.Fatalf("unexpected contents %q", contents)
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	exists, err := store.Exists(context.Background(), key)
	if err != nil || exists {
		t.Fatalf("expected deleted object, exists=%v err=%v", exists, err)
	}
}

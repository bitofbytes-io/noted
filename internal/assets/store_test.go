package assets

import (
	"context"
	"io"
	"os"
	"path/filepath"
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

func TestFilesystemStoreReadinessProbesRequiredDirectories(t *testing.T) {
	root := t.TempDir()
	store, err := NewFilesystemStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ready(context.Background()); err != nil {
		t.Fatalf("new store should be ready: %v", err)
	}
	if err := os.RemoveAll(filepath.Join(root, "originals", "pdf")); err != nil {
		t.Fatal(err)
	}
	if err := store.Ready(context.Background()); err == nil {
		t.Fatal("store reported ready after a required asset directory was removed")
	}
}

func TestFilesystemStoreReadinessHonorsCancellation(t *testing.T) {
	store, err := NewFilesystemStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.Ready(ctx); err == nil {
		t.Fatal("store readiness ignored a canceled context")
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

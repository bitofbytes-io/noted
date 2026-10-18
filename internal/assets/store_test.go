package assets

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLocalStoreUsesOpaqueKeysAndRejectsTraversal(t *testing.T) {
	store, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.Save(context.Background(), strings.NewReader("%PDF-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(object.Key, "fixture") || object.Size != 12 {
		t.Fatalf("unexpected object: %#v", object)
	}
	if _, err := store.Open(context.Background(), "../../etc/passwd"); err == nil {
		t.Fatal("expected traversal key to be rejected")
	}
	reader, err := store.Open(context.Background(), object.Key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, _ := io.ReadAll(reader)
	if string(body) != "%PDF-fixture" {
		t.Fatalf("unexpected stored body %q", body)
	}
}

func TestLocalStoreCheckFailsWhenObjectsDirectoryIsGone(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Check(context.Background()); err != nil {
		t.Fatalf("check on a fresh store: %v", err)
	}
	// An unmounted volume leaves only the empty mount point behind.
	if err := os.RemoveAll(filepath.Join(root, "objects")); err != nil {
		t.Fatal(err)
	}
	if err := store.Check(context.Background()); err == nil {
		t.Fatal("expected check to fail without the objects directory")
	}
}

func TestLocalStoreCheckSharesOneStatWhileTheMountHangs(t *testing.T) {
	store, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	var calls atomic.Int32
	store.stat = func(name string) (os.FileInfo, error) {
		calls.Add(1)
		<-release
		return os.Stat(name)
	}
	for range 3 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		err := store.Check(ctx)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("check against a hung mount = %v, want deadline exceeded", err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("stat calls while hung = %d, want 1", got)
	}
	close(release)
	if err := store.Check(context.Background()); err != nil {
		t.Fatalf("check after the mount recovers: %v", err)
	}
}

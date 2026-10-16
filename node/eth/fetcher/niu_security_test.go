package fetcher

import (
	"fmt"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/txpool"
	"github.com/ethereum/go-ethereum/core/types"
	"testing"
	"time"
)

// Invalid expensive proofs must disconnect the sender and stop further batches.
func TestNIUInvalidKZGDisconnectsAndStopsBatches(t *testing.T) {
	dropped := make(chan string, 1)
	batches := 0
	f := NewTxFetcher(func(common.Hash) bool { return false }, func(txs []*types.Transaction) []error {
		batches++
		errs := make([]error, len(txs))
		errs[0] = fmt.Errorf("invalid proof: %w", txpool.ErrKZGVerificationError)
		return errs
	}, func(string, []common.Hash) error { return nil }, func(peer string) { dropped <- peer })
	f.Start()
	defer f.Stop()
	txs := make([]*types.Transaction, 257)
	for i := range txs {
		txs[i] = testTxs[0]
	}
	if err := f.Enqueue("malicious", txs, true); err != nil {
		t.Fatal(err)
	}
	select {
	case peer := <-dropped:
		if peer != "malicious" {
			t.Fatalf("wrong peer: %s", peer)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("peer not disconnected")
	}
	if batches != 1 {
		t.Fatalf("processed %d batches after invalid proof", batches)
	}
}

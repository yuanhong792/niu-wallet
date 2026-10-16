package txpool

import (
	"crypto/sha256"
	"errors"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto/kzg4844"
	"testing"
)

func TestNIUInvalidBlobProofHasSentinel(t *testing.T) {
	blob := kzg4844.Blob{}
	commitment, err := kzg4844.BlobToCommitment(blob)
	if err != nil {
		t.Fatal(err)
	}
	sidecar := &types.BlobTxSidecar{Blobs: []kzg4844.Blob{blob}, Commitments: []kzg4844.Commitment{commitment}, Proofs: []kzg4844.Proof{{}}}
	hash := kzg4844.CalcBlobHashV1(sha256.New(), &commitment)
	if err := validateBlobSidecar([]common.Hash{hash}, sidecar); !errors.Is(err, ErrKZGVerificationError) {
		t.Fatalf("missing KZG error classification: %v", err)
	}
}

package eth

import "testing"

func TestNIUZeroHeaderRequestDoesNotReadChain(t *testing.T) {
	if got := ServiceGetBlockHeadersQuery(nil, &GetBlockHeadersRequest{Amount: 0}, nil); len(got) != 0 {
		t.Fatalf("empty request returned headers")
	}
}

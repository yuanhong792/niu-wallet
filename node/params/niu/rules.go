// SPDX-License-Identifier: LGPL-3.0-or-later
// NIU network rules. This chain ID is reserved for local integration validation;
// the genesis and final network activation remain subject to release acceptance.
package niu

import "math/big"

const ChainID int64 = 26261017
const HalvingInterval uint64 = 1050000
const TargetBlockSeconds uint64 = 60

// Difficulty follows the existing Ethash/EIP-100 adjustment shape without the
// difficulty bomb or uncle term. A 42-second bucket gives an equilibrium mean
// near 60 seconds under exponentially distributed PoW arrivals. This is an
// integration candidate: hashrate shifts and timestamp attacks need simulation.
func Difficulty(timestamp, parentTime uint64, parentDifficulty *big.Int) *big.Int {
	minimum := big.NewInt(131072)
	if timestamp <= parentTime {
		return new(big.Int).Set(parentDifficulty)
	}
	buckets := (timestamp - parentTime) / 42
	adjustment := int64(-99)
	if buckets < 100 {
		adjustment = 1 - int64(buckets)
	}
	step := new(big.Int).Div(new(big.Int).Set(parentDifficulty), big.NewInt(2048))
	step.Mul(step, big.NewInt(adjustment))
	result := new(big.Int).Add(parentDifficulty, step)
	if result.Cmp(minimum) < 0 {
		return new(big.Int).Set(minimum)
	}
	return result
}

func Enabled(id *big.Int) bool { return id != nil && id.Cmp(big.NewInt(ChainID)) == 0 }

// Subsidy uses integer base units (18 decimal places). Genesis has no subsidy.
// Return a fresh integer so callers cannot mutate consensus constants.
func Subsidy(height *big.Int) *big.Int {
	if height == nil || height.Sign() <= 0 {
		return new(big.Int)
	}
	era := new(big.Int).Sub(height, big.NewInt(1))
	era.Div(era, new(big.Int).SetUint64(HalvingInterval))
	if !era.IsUint64() || era.Uint64() >= 70 {
		return new(big.Int)
	}
	initial := new(big.Int).Exp(big.NewInt(10), big.NewInt(21), nil)
	return initial.Rsh(initial, uint(era.Uint64()))
}

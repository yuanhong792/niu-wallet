"""Independent recovery check for a NIU Wallet v0.4.0 personal backup.

Deliberately shares no code with the wallet: scrypt + AES-GCM come from
`cryptography`, secp256k1 from `coincurve`, keccak from `pycryptodome`, and
bech32/segwit encoding is re-implemented here from the BIP-173 spec.
If the addresses derived here match what the wallet reported, the backup is
genuinely portable and the keys are not trapped inside the app.

Usage: python tools/verify-backup-independent.py <dir with backup.json + expected.json>
"""
import json
import hashlib
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from coincurve import PublicKey
from Crypto.Hash import keccak

AAD = b"niu-personal-v1"
N, R, P = 131072, 8, 1
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
DOGE_PUBKEY_HASH = 0x1E


def base58check(payload):
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    raw = payload + checksum
    number = int.from_bytes(raw, "big")
    out = ""
    while number:
        number, rest = divmod(number, 58)
        out = B58[rest] + out
    for byte in raw:
        if byte:
            break
        out = B58[0] + out
    return out


def bech32_polymod(values):
    generator = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ value
        for i in range(5):
            chk ^= generator[i] if ((top >> i) & 1) else 0
    return chk


def bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def bech32_encode(hrp, data):
    values = bech32_hrp_expand(hrp) + data
    polymod = bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[d] for d in data + checksum)


def convertbits(data, frombits, tobits, pad=True):
    acc, bits, ret = 0, 0, []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (tobits - bits)) & maxv)
    return ret


def p2wpkh(pubkey_compressed, hrp):
    sha = hashlib.sha256(pubkey_compressed).digest()
    h160 = hashlib.new("ripemd160", sha).digest()
    return bech32_encode(hrp, [0] + convertbits(h160, 8, 5))


def evm_address(secret_hex):
    pub = PublicKey.from_valid_secret(bytes.fromhex(secret_hex[2:])).format(compressed=False)[1:]
    digest = keccak.new(digest_bits=256)
    digest.update(pub)
    return "0x" + digest.hexdigest()[-40:]


def doge_address(pubkey_compressed):
    sha = hashlib.sha256(pubkey_compressed).digest()
    h160 = hashlib.new("ripemd160", sha).digest()
    return base58check(bytes([DOGE_PUBKEY_HASH]) + h160)


def main():
    root = Path(sys.argv[1])
    envelope = json.loads((root / "backup.json").read_text(encoding="utf-8"))
    expected = json.loads((root / "expected.json").read_text(encoding="utf-8"))

    assert envelope["format"] == "niu-personal-vault", "unexpected backup format"
    assert envelope["kdf"] == f"scrypt-{N}-{R}-{P}", "unexpected kdf label"

    key = hashlib.scrypt(
        expected["password"].encode(),
        salt=bytes.fromhex(envelope["salt"]),
        n=N, r=R, p=P, dklen=32, maxmem=256 * 1024 * 1024,
    )
    plain = AESGCM(key).decrypt(
        bytes.fromhex(envelope["iv"]),
        bytes.fromhex(envelope["ciphertext"]) + bytes.fromhex(envelope["tag"]),
        AAD,
    )
    secret = json.loads(plain)

    derived = {
        "evm": evm_address(secret["evm"]),
        "btc": p2wpkh(PublicKey.from_valid_secret(bytes.fromhex(secret["btc"])).format(compressed=True), "bc"),
        "btcTest": p2wpkh(PublicKey.from_valid_secret(bytes.fromhex(secret["btc"])).format(compressed=True), "tb"),
        "doge": doge_address(PublicKey.from_valid_secret(bytes.fromhex(secret["btc"])).format(compressed=True)),
    }
    report = {"derived": derived, "wallet": expected["addresses"], "match": {}}
    ok = True
    for name, value in derived.items():
        same = value.lower() == expected["addresses"][name].lower()
        report["match"][name] = same
        ok = ok and same

    # negative control: a one-character password change must fail authentication
    try:
        bad = expected["password"][:-1] + ("x" if expected["password"][-1] != "x" else "y")
        bad_key = hashlib.scrypt(bad.encode(), salt=bytes.fromhex(envelope["salt"]),
                                 n=N, r=R, p=P, dklen=32, maxmem=256 * 1024 * 1024)
        AESGCM(bad_key).decrypt(bytes.fromhex(envelope["iv"]),
                                bytes.fromhex(envelope["ciphertext"]) + bytes.fromhex(envelope["tag"]),
                                AAD)
        report["wrongPasswordRejected"] = False
        ok = False
    except Exception:
        report["wrongPasswordRejected"] = True

    report["status"] = "passed" if ok else "failed"
    print(json.dumps(report, indent=2))
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()

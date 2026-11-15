// Package secret makes random identifiers and credentials and hashes credentials for storage.
package secret

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"strings"
)

var encoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// ID returns a random UUID (version 4).
func ID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// Prefixes tell an agent token from an access key at a glance. Credentials made before the
// project was renamed from bugspot carry the legacy prefixes and stay valid.
const (
	AgentPrefix       = "ppt_"
	KeyPrefix         = "ppk_"
	LegacyAgentPrefix = "bsp_"
	LegacyKeyPrefix   = "bsk_"
)

// IsAgentToken reports whether s looks like an agent token, new or legacy.
func IsAgentToken(s string) bool {
	return strings.HasPrefix(s, AgentPrefix) || strings.HasPrefix(s, LegacyAgentPrefix)
}

// IsKey reports whether s looks like an access key, new or legacy.
func IsKey(s string) bool {
	return strings.HasPrefix(s, KeyPrefix) || strings.HasPrefix(s, LegacyKeyPrefix)
}

// New returns a credential with 160 random bits after the prefix.
func New(prefix string) string {
	var b [20]byte
	_, _ = rand.Read(b[:])
	return prefix + encoding.EncodeToString(b[:])
}

// Hash is what the store keeps instead of the credential.
func Hash(credential string) string {
	sum := sha256.Sum256([]byte(credential))
	return hex.EncodeToString(sum[:])
}

// Equal compares two strings in constant time.
func Equal(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

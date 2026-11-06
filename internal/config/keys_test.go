package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
)

func publicPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func TestPublicKeyAndChain(t *testing.T) {
	pemText := publicPEM(t)
	path := t.TempDir() + "/key.pem"
	if err := writeFile(path, pemText); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{pemText, path} {
		c, err := Load(env(map[string]string{
			"BUGSPOT_AUTH": "jwt,header,anonymous", "BUGSPOT_JWT_PUBLIC_KEY": value, "BUGSPOT_TRUSTED_PROXIES": "10.0.0.1",
			"BUGSPOT_LOG_LEVEL": "debug",
		}))
		if err != nil || c.JWTPublicKey == nil {
			t.Fatalf("public key from %.20q: %v", value, err)
		}
		names := []string{}
		for _, p := range c.Chain(nil, nil) {
			names = append(names, p.Name())
		}
		if strings.Join(names, ",") != "jwt,header,anonymous" {
			t.Fatalf("chain = %v", names)
		}
	}
	for name, value := range map[string]string{"no PEM": "-----BEGIN nothing", "missing file": "/nonexistent/key.pem"} {
		if _, err := Load(env(map[string]string{"BUGSPOT_AUTH": "jwt", "BUGSPOT_JWT_PUBLIC_KEY": value})); err == nil || !strings.Contains(err.Error(), "JWT_PUBLIC_KEY") {
			t.Errorf("%s: %v", name, err)
		}
	}
	_, err := Load(env(map[string]string{
		"BUGSPOT_LOG_LEVEL": "loud", "BUGSPOT_ENABLED": "maybe", "BUGSPOT_RATE_READ": "-1", "BUGSPOT_JWT_SECRET_FILE": "/nonexistent",
		"BUGSPOT_FORWARD_MAP": "id=", "BUGSPOT_TRUSTED_PROXIES": "nope", "BUGSPOT_AUTH": "jwt jwt forward", "BUGSPOT_FORWARD_URL": "http://app",
	}))
	for _, want := range []string{"LOG_LEVEL", "ENABLED", "RATE_READ", "JWT_SECRET_FILE", "FORWARD_MAP", "TRUSTED_PROXIES", `"jwt" twice`, "FORWARD_COOKIES"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

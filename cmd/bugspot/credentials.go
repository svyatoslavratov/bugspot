package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/config"
	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
)

// credentials manages agent tokens (token) or access keys (key) directly in the database, so it
// runs next to the service: docker compose exec bugspot bugspot token create --name claude.
func credentials(args []string, agent bool) error {
	noun, kind, prefix := "key", domain.CredentialKey, secret.KeyPrefix
	if agent {
		noun, kind, prefix = "token", domain.CredentialAgent, secret.AgentPrefix
	}
	if len(args) == 0 {
		return fmt.Errorf("usage: bugspot %s create|list|revoke", noun)
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return fmt.Errorf("configuration:\n%w", err)
	}
	ctx := context.Background()
	st, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()

	switch args[0] {
	case "create":
		fs := flag.NewFlagSet(noun+" create", flag.ExitOnError)
		name := fs.String("name", "", "who uses it; shown as the author of their replies (required)")
		scopes := fs.String("scopes", "read,reply,status", "agent scopes: read, reply, status")
		roles := fs.String("roles", "", "roles for the policy, comma separated (keys only)")
		expires := fs.Duration("expires", 0, "lifetime such as 720h; 0 means no expiry")
		_ = fs.Parse(args[1:])
		if strings.TrimSpace(*name) == "" {
			return errors.New("--name is required")
		}
		c := domain.Credential{ID: secret.ID(), Kind: kind, Name: strings.TrimSpace(*name), CreatedAt: time.Now().UTC()}
		if agent {
			for _, s := range split(*scopes) {
				if s != domain.ScopeRead && s != domain.ScopeReply && s != domain.ScopeStatus {
					return fmt.Errorf("unknown scope %q", s)
				}
				c.Scopes = append(c.Scopes, s)
			}
		} else {
			c.Roles = split(*roles)
		}
		if *expires > 0 {
			at := c.CreatedAt.Add(*expires)
			c.ExpiresAt = &at
		}
		raw := secret.New(prefix)
		c.Hash = secret.Hash(raw)
		if err := st.CreateCredential(ctx, c); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Created %s %s (%s). It is shown once; only its hash is stored.\n", noun, c.ID, c.Name)
		if !agent {
			fmt.Fprintf(os.Stderr, "Share a link with ?bugspot_key=%s added to any page that loads the widget.\n", raw)
		}
		fmt.Println(raw)
	case "list":
		list, err := st.ListCredentials(ctx, kind)
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tNAME\tSCOPES/ROLES\tCREATED\tEXPIRES\tLAST USED\tSTATE")
		for _, c := range list {
			state := "active"
			if !c.Active(time.Now()) {
				state = "inactive"
			}
			rights := strings.Join(c.Scopes, ",") + strings.Join(c.Roles, ",")
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", c.ID, c.Name, rights, day(&c.CreatedAt), day(c.ExpiresAt), day(c.LastUsedAt), state)
		}
		return tw.Flush()
	case "revoke":
		if len(args) != 2 {
			return fmt.Errorf("usage: bugspot %s revoke ID", noun)
		}
		if err := st.RevokeCredential(ctx, args[1], time.Now().UTC()); err != nil {
			return fmt.Errorf("revoke %s: %w", args[1], err)
		}
		fmt.Fprintf(os.Stderr, "Revoked %s %s.\n", noun, args[1])
	default:
		return fmt.Errorf("unknown %s command %q", noun, args[0])
	}
	return nil
}

func split(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func day(t *time.Time) string {
	if t == nil {
		return "-"
	}
	return t.Local().Format("2006-01-02 15:04")
}

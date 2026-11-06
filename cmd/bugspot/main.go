// Command bugspot runs the feedback service and manages it: tokens for agents, access keys for
// people, and a small client to read and answer threads.
package main

import (
	"fmt"
	"os"
)

// version is set at build time: -ldflags "-X main.version=v0.1.0".
var version = "dev"

const usage = `bugspot — pinned page comments for your team and your agents.

Usage:
  bugspot [serve]                     run the service (settings: BUGSPOT_* variables)
  bugspot healthcheck                 exit 0 when the local service answers /healthz
  bugspot token create|list|revoke    API tokens for agents (scopes read, reply, status)
  bugspot key create|list|revoke      access keys for people without an account in your app
  bugspot threads list|show|reply|status
                                      read and answer threads over the API (BUGSPOT_URL, BUGSPOT_TOKEN)
  bugspot version

Run "bugspot <command> -h" for the flags of a command.
`

func main() {
	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve(args)
	case "healthcheck":
		err = healthcheck(args)
	case "token":
		err = credentials(args, true)
	case "key":
		err = credentials(args, false)
	case "threads":
		err = threads(args)
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "bugspot:", err)
		os.Exit(1)
	}
}

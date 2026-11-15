// Command bugspot runs the feedback service and manages it: tokens for agents, access keys for
// people, and a small client to read and answer threads.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

// version is set at build time: -ldflags "-X main.version=v0.1.0".
var version = "dev"

const usage = `bugspot — pinned page comments for your team and your agents.

Usage:
  bugspot [serve]                     run the service (settings: BUGSPOT_* variables)
  bugspot healthcheck                 exit 0 when the local service answers /healthz
  bugspot token create|list|revoke    API tokens for agents (scopes read, reply, status, map)
  bugspot key create|list|revoke      access keys for people without an account in your app
  bugspot threads list|show|reply|status|screenshot
                                      read and answer threads over the API (BUGSPOT_URL, BUGSPOT_TOKEN)
  bugspot mcp                         an MCP server on stdio for agents (BUGSPOT_URL, BUGSPOT_TOKEN)
  bugspot map crawl <app address>     walk the app in Chrome without a window and build the screen map
                                      (BUGSPOT_TOKEN with the read and map scopes)
  bugspot map export|import           the manifest of the map: names, sections, descriptions, transitions
                                      (BUGSPOT_URL, BUGSPOT_TOKEN)
  bugspot backup [-o file]            a consistent copy of the database, also while the service runs
  bugspot version

Run "bugspot <command> -h" for the flags of a command.
`

// app is one run of the command: its environment and its streams, so commands run in tests too.
type app struct {
	ctx    context.Context
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
	getenv func(string) string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := (&app{ctx: ctx, stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr, getenv: os.Getenv}).run(os.Args[1:])
	stop()
	os.Exit(code)
}

// run executes one command and returns the exit code.
func (a *app) run(args []string) int {
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = a.serve(args)
	case "healthcheck":
		err = a.healthcheck(args)
	case "token":
		err = a.credentials(args, true)
	case "key":
		err = a.credentials(args, false)
	case "threads":
		err = a.threads(args)
	case "mcp":
		err = a.mcp(args)
	case "map":
		err = a.mapCommand(args)
	case "backup":
		err = a.backup(args)
	case "version", "--version", "-v":
		fmt.Fprintln(a.stdout, version)
	case "help", "-h", "--help":
		fmt.Fprint(a.stdout, usage)
	default:
		fmt.Fprintf(a.stderr, "unknown command %q\n\n%s", cmd, usage)
		return 2
	}
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		fmt.Fprintln(a.stderr, "bugspot:", err)
		return 1
	}
	return 0
}

// flags is a flag set that reports to stderr and returns errors instead of exiting.
func (a *app) flags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	return fs
}

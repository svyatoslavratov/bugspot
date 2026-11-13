package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

// cdp speaks the Chrome DevTools Protocol over the pipe Chrome opens with --remote-debugging-pipe:
// JSON messages ended by a NUL byte, written to Chrome's descriptor 3 and read from its 4. No
// WebSocket and no driver library: the crawl needs a handful of methods.
type cdp struct {
	w   io.Writer
	wmu sync.Mutex

	mu      sync.Mutex
	next    int64
	pending map[int64]chan cdpMessage
	done    chan struct{}
	err     error
	// onEvent hears events, each in its own goroutine: a handler may call the browser back.
	onEvent func(cdpMessage)
}

type cdpMessage struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    any             `json:"params,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func newCDP(r io.Reader, w io.Writer) *cdp {
	c := &cdp{w: w, pending: map[int64]chan cdpMessage{}, done: make(chan struct{})}
	go c.read(r)
	return c
}

// read dispatches answers to their calls and events to onEvent.
func (c *cdp) read(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		data, err := br.ReadBytes(0)
		if err != nil {
			c.mu.Lock()
			c.err = fmt.Errorf("the browser closed the connection: %w", err)
			c.mu.Unlock()
			close(c.done)
			return
		}
		var m cdpMessage
		if json.Unmarshal(bytes.TrimSuffix(data, []byte{0}), &m) != nil {
			continue
		}
		if m.ID == 0 {
			c.mu.Lock()
			handle := c.onEvent
			c.mu.Unlock()
			if handle != nil && m.Method != "" {
				go handle(m)
			}
			continue
		}
		c.mu.Lock()
		ch := c.pending[m.ID]
		delete(c.pending, m.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}

// call sends a method to the browser (session "") or to a page session and decodes the result.
func (c *cdp) call(ctx context.Context, session, method string, params, out any) error {
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	c.next++
	id := c.next
	ch := make(chan cdpMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	data, err := json.Marshal(cdpMessage{ID: id, Method: method, Params: params, SessionID: session})
	if err != nil {
		return err
	}
	c.wmu.Lock()
	_, err = c.w.Write(append(data, 0))
	c.wmu.Unlock()
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	select {
	case m := <-ch:
		if m.Error != nil {
			return fmt.Errorf("%s: %s", method, m.Error.Message)
		}
		if out != nil {
			return json.Unmarshal(m.Result, out)
		}
		return nil
	case <-c.done:
		return c.err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

// handle sets the event handler.
func (c *cdp) handle(fn func(cdpMessage)) {
	c.mu.Lock()
	c.onEvent = fn
	c.mu.Unlock()
}

// evaluate runs an expression in the page and returns its value.
func (c *cdp) evaluate(ctx context.Context, session, expression string, out any) error {
	var res struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	err := c.call(ctx, session, "Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true}, &res)
	if err != nil {
		return err
	}
	if res.ExceptionDetails != nil {
		return fmt.Errorf("evaluate: %s", res.ExceptionDetails.Text)
	}
	if out == nil || len(res.Result.Value) == 0 {
		return nil
	}
	return json.Unmarshal(res.Result.Value, out)
}

// browser is a Chrome the command started, with its own profile unless one is given.
type browser struct {
	cmd    *exec.Cmd
	cdp    *cdp
	dir    string
	temp   bool
	stderr *tailBuffer
}

type browserOptions struct {
	path    string
	profile string
	headed  bool
	width   int
	height  int
}

// chromeNames and chromeApps are where Chrome, Chromium and Edge usually are.
var chromeNames = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
	"chrome-headless-shell", "headless_shell", "microsoft-edge"}

var chromeApps = []string{
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
}

// findChrome is the browser to run: the one asked for, else the first one installed.
func findChrome(asked string) (string, error) {
	if asked != "" {
		return asked, nil
	}
	for _, name := range chromeNames {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	for _, p := range chromeApps {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", errors.New("no Chrome or Chromium found: install one, or point --chrome (BUGSPOT_CHROME) at it")
}

func launchBrowser(ctx context.Context, o browserOptions) (*browser, error) {
	if runtime.GOOS == "windows" {
		return nil, errors.New("the crawl drives Chrome through a pipe, which needs macOS or Linux")
	}
	b := &browser{dir: o.profile, stderr: &tailBuffer{max: 4 << 10}}
	if b.dir == "" {
		dir, err := os.MkdirTemp("", "bugspot-chrome-")
		if err != nil {
			return nil, err
		}
		b.dir, b.temp = dir, true
	}
	args := []string{
		"--remote-debugging-pipe", "--user-data-dir=" + b.dir,
		"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
		"--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding", "--disable-popup-blocking", "--mute-audio",
		"--password-store=basic", "--use-mock-keychain",
		fmt.Sprintf("--window-size=%d,%d", o.width, o.height),
	}
	if !o.headed {
		args = append(args, "--headless=new", "--hide-scrollbars")
	}
	if os.Geteuid() == 0 {
		// Chrome refuses to sandbox itself as root, which is what containers usually run as.
		args = append(args, "--no-sandbox")
	}
	toChrome, toChromeW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	fromChromeR, fromChrome, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	// The browser outlives a cancelled crawl for a moment: the crawl is told to stop, then closed.
	//nolint:gosec // the operator's browser, started with fixed flags
	b.cmd = exec.CommandContext(context.WithoutCancel(ctx), o.path, append(args, "about:blank")...)
	b.cmd.ExtraFiles = []*os.File{toChrome, fromChrome}
	b.cmd.Stderr = b.stderr
	if err := b.cmd.Start(); err != nil {
		for _, f := range []*os.File{toChrome, toChromeW, fromChromeR, fromChrome} {
			_ = f.Close()
		}
		b.cleanup()
		return nil, fmt.Errorf("start %s: %w", o.path, err)
	}
	_ = toChrome.Close()
	_ = fromChrome.Close()
	b.cdp = newCDP(fromChromeR, toChromeW)
	start, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var version struct {
		Product string `json:"product"`
	}
	if err := b.cdp.call(start, "", "Browser.getVersion", nil, &version); err != nil {
		b.close()
		return nil, fmt.Errorf("the browser did not answer (%w): %s", err, b.stderr)
	}
	return b, nil
}

// page opens a tab and returns its session.
func (b *browser) page(ctx context.Context) (string, error) {
	var target struct {
		TargetID string `json:"targetId"`
	}
	if err := b.cdp.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &target); err != nil {
		return "", err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	err := b.cdp.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target.TargetID, "flatten": true}, &attached)
	return attached.SessionID, err
}

func (b *browser) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if b.cdp != nil {
		_ = b.cdp.call(ctx, "", "Browser.close", nil, nil)
	}
	exited := make(chan struct{})
	go func() {
		_ = b.cmd.Wait()
		close(exited)
	}()
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		_ = b.cmd.Process.Kill()
		<-exited
	}
	b.cleanup()
}

func (b *browser) cleanup() {
	if b.temp {
		_ = os.RemoveAll(b.dir)
	}
}

// tailBuffer keeps the last bytes written: Chrome's stderr for error messages.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(bytes.TrimSpace(t.buf))
}
